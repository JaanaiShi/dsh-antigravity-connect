/**
 * Google OAuth 2.0 for the Antigravity provider: authorization-code flow with
 * PKCE over a loopback redirect, plus the lazy refresh that keeps an access
 * token live for every later Cloud Code Assist call.
 *
 * The module deliberately depends on nothing from the harness. Every failure
 * carries a stable `code` so the caller can decide whether it is a terminal
 * auth problem or a transient transport one; translating those into harness
 * error types is the adapter's job.
 *
 * @module dsh-antigravity-connect/oauth
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import {
  AUTH_URL,
  CALLBACK_TIMEOUT_MS,
  CLIENT_ID,
  CLIENT_SECRET,
  DEFAULT_CALLBACK_PORT,
  REDIRECT_PATH,
  REFRESH_MARGIN_MS,
  SCOPES,
  TOKEN_URL,
  USERINFO_URL,
  redirectUri,
} from './constants.js'
import { redactSecrets } from './credentials.js'

/**
 * Build an auth error carrying a stable machine code.
 * @param {string} message - human-readable summary.
 * @param {string} code - stable code the caller switches on.
 * @param {object} [options] - optional `status` and `cause`.
 * @returns {Error & { code: string, status?: number }} the error.
 */
function authError(message, code, options = {}) {
  const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause })
  error.code = code
  if (options.status !== undefined) error.status = options.status
  return error
}

/**
 * Base64url-encode a buffer, without padding, per RFC 7636.
 * @param {Buffer} buffer - raw bytes.
 * @returns {string} the base64url spelling.
 */
function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/**
 * Mint one PKCE verifier and its S256 challenge.
 * @returns {{ verifier: string, challenge: string }} the pair for one login attempt.
 */
export function generatePKCE() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * Assemble the authorization URL the browser is sent to.
 * @param {object} input - redirect URI, opaque state, and PKCE challenge.
 * @returns {string} the absolute authorization URL.
 */
export function buildAuthUrl({ redirect, state, challenge }) {
  const url = new URL(AUTH_URL)
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  // `offline` plus an explicit consent prompt is what reliably returns a
  // refresh token; without it a repeat login can come back access-only.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

/**
 * `fetch` with a hard deadline, so a hung metadata call cannot hold a request
 * open forever.
 * @param {string} url - absolute URL.
 * @param {RequestInit} init - request options; an existing signal is composed with the deadline.
 * @param {number} timeoutMs - deadline in milliseconds.
 * @returns {Promise<Response>} the response.
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = init.signal === undefined || init.signal === null
    ? deadline
    : AbortSignal.any([init.signal, deadline])
  return fetch(url, { ...init, signal })
}

/**
 * POST a form-encoded body to the token endpoint and normalize both the
 * success and the error shapes.
 * @param {Record<string, string>} body - form fields.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<Record<string, unknown>>} the parsed token response.
 */
async function postToken(body, signal) {
  let response
  try {
    response = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal,
    }, 30_000)
  } catch (error) {
    throw authError(
      `antigravity-connect: could not reach the Google token endpoint: ${redactSecrets(error?.message ?? error)}`,
      'AUTH_NETWORK',
      { cause: error },
    )
  }
  const text = await response.text()
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw authError(
      `antigravity-connect: the Google token endpoint returned a non-JSON body (HTTP ${response.status})`,
      'AUTH_PROTOCOL',
      { status: response.status },
    )
  }
  if (!response.ok || typeof parsed.error === 'string') {
    const detail = typeof parsed.error_description === 'string' ? parsed.error_description : parsed.error
    throw authError(
      `antigravity-connect: Google rejected the token request (HTTP ${response.status}): ${redactSecrets(detail ?? 'unknown error')}`,
      // A rejected grant means the stored refresh token is dead and the user
      // must sign in again; every other status is worth retrying later.
      parsed.error === 'invalid_grant' ? 'AUTH_REFRESH_REJECTED' : 'AUTH_REJECTED',
      { status: response.status },
    )
  }
  return parsed
}

/**
 * Look up the signed-in account's email address.
 * @param {string} access - a live access token.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<string | undefined>} the email, or `undefined` when unavailable.
 */
export async function fetchUserInfo(access, signal) {
  try {
    const response = await fetchWithTimeout(USERINFO_URL, {
      headers: { authorization: `Bearer ${access}` },
      signal,
    }, 15_000)
    if (!response.ok) return undefined
    const parsed = await response.json()
    return typeof parsed?.email === 'string' ? parsed.email : undefined
  } catch {
    // The account label is cosmetic: a failed lookup must not fail a login.
    return undefined
  }
}

/**
 * Return a usable access token, refreshing it first when it is missing, spent,
 * or about to expire.
 *
 * The whole decision runs inside one serialized read-modify-write cycle, so
 * concurrent callers share a single refresh. There is no timer and no
 * background scheduler: a token is refreshed exactly when a request needs one.
 *
 * @param {import('./credentials.js').CredentialStore} store - the credential store.
 * @param {object} [options] - `force` to refresh even a live token, `signal` to cancel.
 * @returns {Promise<string>} the access token.
 */
export async function ensureAccessToken(store, options = {}) {
  return store.modify(async (current) => {
    if (current === undefined) {
      throw authError(
        'antigravity-connect: not signed in; open Settings > Antigravity and sign in with Google',
        'MISSING_CREDENTIAL',
      )
    }
    const live = typeof current.access === 'string'
      && current.access.length > 0
      && typeof current.expires === 'number'
      && current.expires - REFRESH_MARGIN_MS > Date.now()
    if (live && options.force !== true) {
      return { result: current.access }
    }
    const refreshed = await postToken({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: current.refresh,
      grant_type: 'refresh_token',
    }, options.signal)
    if (typeof refreshed.access_token !== 'string') {
      throw authError(
        'antigravity-connect: the Google token endpoint returned no access_token for the refresh',
        'AUTH_PROTOCOL',
      )
    }
    const expiresIn = typeof refreshed.expires_in === 'number' ? refreshed.expires_in : 3600
    const next = {
      ...current,
      access: refreshed.access_token,
      expires: Date.now() + expiresIn * 1000,
      // Google usually omits a new refresh token on refresh; only replace the
      // stored one when it actually sends a different value.
      ...typeof refreshed.refresh_token === 'string' && refreshed.refresh_token.length > 0
        ? { refresh: refreshed.refresh_token }
        : {},
    }
    return { next, result: next.access }
  })
}

/**
 * Exchange an authorization code for tokens and return the credential to
 * store. Aborts when no refresh token comes back: without one the login would
 * succeed and then die at the first expiry, which is worse than failing here.
 * @param {object} input - the code, the PKCE verifier, and the redirect URI used.
 * @returns {Promise<import('./credentials.js').StoredCredential>} the new credential.
 */
async function exchangeCode({ code, verifier, redirect }) {
  const token = await postToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
    code_verifier: verifier,
  })
  if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') {
    throw authError(
      'antigravity-connect: the Google token exchange returned no refresh token;'
      + ' revoke this app\'s access at https://myaccount.google.com/permissions and sign in again',
      'AUTH_NO_REFRESH_TOKEN',
    )
  }
  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 3600
  const email = await fetchUserInfo(token.access_token)
  return {
    refresh: token.refresh_token,
    access: token.access_token,
    expires: Date.now() + expiresIn * 1000,
    ...email === undefined ? {} : { email },
  }
}

/**
 * HTML the browser lands on when the callback completes.
 * @param {boolean} ok - whether the login succeeded.
 * @param {string} detail - one line of copy to show.
 * @returns {string} a complete HTML document.
 */
function callbackPage(ok, detail) {
  const title = ok ? 'Signed in' : 'Sign-in failed'
  const accent = ok ? '#1a7f37' : '#b42318'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Antigravity</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif }
  main { max-width:30rem; padding:2.5rem; text-align:center }
  h1 { margin:0 0 .5rem; font-size:1.25rem; color:${accent} }
  p { margin:0; opacity:.75 }
</style></head>
<body><main><h1>${title}</h1><p>${detail}</p></main>
<script>setTimeout(function(){window.close()},1500)</script>
</body></html>`
}

/**
 * Send one callback response and stop reading the connection.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {string} html - body.
 * @returns {void}
 */
function sendPage(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // The page is inert, but a loopback listener should never be framable.
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  })
  response.end(html)
}

/**
 * Whether an address belongs to this machine.
 * @param {string | undefined} address - `req.socket.remoteAddress`.
 * @returns {boolean} true for IPv4/IPv6 loopback and IPv4-mapped loopback.
 */
function isLoopback(address) {
  if (typeof address !== 'string') return false
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

/**
 * Start the loopback listener that receives the authorization code.
 *
 * A fresh state value and a fresh PKCE pair are created per call and captured
 * in this closure, so accepting one callback cannot validate a different login
 * attempt's response.
 *
 * @param {object} input - the callback port.
 * @returns {Promise<{ redirect: string, authUrl: string, waitForCode: (signal?: AbortSignal) => Promise<string>, close: () => Promise<void> }>}
 *   the redirect URI, the URL to open, a promise for the code, and the disposer.
 */
export async function startCallbackServer({ port = DEFAULT_CALLBACK_PORT } = {}) {
  const { verifier, challenge } = generatePKCE()
  const state = base64url(randomBytes(16))
  const redirect = redirectUri(port)

  /** @type {(value: { code?: string, error?: string }) => void} */
  let settle = () => {}
  const received = new Promise(resolve => { settle = resolve })

  const server = createServer((request, response) => {
    if (!isLoopback(request.socket.remoteAddress)) {
      sendPage(response, 403, callbackPage(false, 'This callback only answers requests from this machine.'))
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== REDIRECT_PATH) {
      sendPage(response, 404, callbackPage(false, 'Unknown callback path.'))
      return
    }
    if (url.searchParams.get('state') !== state) {
      // A mismatched state is either a stale browser tab or a cross-site
      // attempt; either way the code must not be redeemed.
      sendPage(response, 400, callbackPage(false, 'The sign-in response did not match this request. Start again.'))
      return
    }
    const error = url.searchParams.get('error')
    if (error !== null) {
      sendPage(response, 400, callbackPage(false, `Google returned: ${error}`))
      settle({ error })
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code.length === 0) {
      sendPage(response, 400, callbackPage(false, 'No authorization code was returned.'))
      settle({ error: 'missing code' })
      return
    }
    sendPage(response, 200, callbackPage(true, 'You can close this tab and return to DeepSeek Harness.'))
    settle({ code })
  })

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(error?.code === 'EADDRINUSE'
        ? authError(
          `antigravity-connect: port ${port} is already in use; close whatever holds it and start the sign-in again`,
          'AUTH_PORT_BUSY',
          { cause: error },
        )
        : error)
    })
    // Loopback only: the OAuth redirect must never be reachable from the network.
    server.listen(port, '127.0.0.1', resolve)
  })

  const authUrl = buildAuthUrl({ redirect, state, challenge })

  return {
    redirect,
    authUrl,
    /**
     * Wait for the browser to deliver a code.
     * @param {AbortSignal} [signal] - caller cancellation.
     * @returns {Promise<string>} the authorization code.
     */
    async waitForCode(signal) {
      const timeout = AbortSignal.timeout(CALLBACK_TIMEOUT_MS)
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      const outcome = await Promise.race([
        received,
        new Promise(resolve => {
          combined.addEventListener('abort', () => resolve({ error: 'aborted' }), { once: true })
        }),
      ])
      if (outcome.code !== undefined) return outcome.code
      throw authError(
        outcome.error === 'aborted'
          ? 'antigravity-connect: sign-in was cancelled'
          : 'antigravity-connect: timed out waiting for the Google sign-in to finish',
        'AUTH_CALLBACK_TIMEOUT',
      )
    },
    /**
     * Redeem the waiting code and persist the resulting credential.
     * @param {string} code - the authorization code.
     * @param {import('./credentials.js').CredentialStore} store - where to persist.
     * @param {AbortSignal} [signal] - caller cancellation.
     * @returns {Promise<import('./credentials.js').StoredCredential>} what was stored.
     */
    async complete(code, store, signal) {
      const credential = await exchangeCode({ code, verifier, redirect })
      await store.write(credential)
      void signal
      return credential
    },
    /**
     * Release the listening socket. Idempotent.
     * @returns {Promise<void>} resolves once the port is free.
     */
    async close() {
      await new Promise(resolve => { server.close(() => resolve(undefined)) })
    },
  }
}

/**
 * Best-effort browser launch. A headless or remote host has no browser, and
 * that must not fail the login — the caller prints the URL instead.
 * @param {string} url - the authorization URL.
 * @returns {boolean} true when a launcher was spawned.
 */
export function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
