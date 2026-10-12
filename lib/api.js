/**
 * The plugin's own HTTP API, mounted on the harness web server.
 *
 * The settings page is a same-origin browser client, so it talks to the host
 * over plain `fetch` rather than a typed RPC seam: sign in, sign out, read the
 * quota, and flip which models the picker offers. Every route lives under
 * {@link API_PREFIX} so nothing collides with the harness's own `/api` and
 * `/plugins` routes.
 *
 * Responses are always `{ ok: true, value }` or `{ ok: false, error }`, which
 * keeps the client's error path uniform.
 *
 * @module dsh-antigravity-connect/api
 */

import { API_PREFIX, CALLBACK_TIMEOUT_MS, DEFAULT_CALLBACK_PORT, redirectUri } from './constants.js'
import { redactSecrets } from './credentials.js'
import { openBrowser, startCallbackServer } from './oauth.js'
import { fallbackModels, modelsFromDirectory } from './catalog.js'

/** Largest request body this API will read, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - the body.
 * @returns {void}
 */
function sendJson(response, status, payload) {
  if (response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // These responses are per-account and must never be cached.
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<unknown>} the parsed body.
 * @throws when the body is too large or not JSON.
 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * Register the settings API.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} deps - credential store, preference store, client, enabled-model accessors, and the callback port.
 * @returns {object} the live login state accessor.
 */
export function registerApi(ctx, deps) {
  const {
    store,
    preferences,
    client,
    callbackPort = DEFAULT_CALLBACK_PORT,
    getEnabledModelIds,
    setEnabledModelIds,
  } = deps

  const logger = deps.logger ?? ctx.logger

  /** @type {{ state: string, error?: string, authUrl?: string, expiresAt?: number }} */
  let login = { state: 'idle' }
  /** @type {{ server: Awaited<ReturnType<typeof startCallbackServer>>, controller: AbortController, authUrl: string } | undefined} */
  let pending

  /**
   * Build the payload every state-changing route returns.
   * @returns {Promise<object>} the current status.
   */
  const status = async () => {
    const credential = await store.read()
    const selection = getEnabledModelIds()
    // No stored selection means "offer everything the directory reports".
    const enabled = selection === undefined || selection === null ? undefined : new Set(selection)
    // The settings page lists models from the same live directory the picker
    // uses, so the two can never disagree about what exists.
    const directory = await client.modelDirectory()
    const models = directory === undefined ? fallbackModels() : modelsFromDirectory(directory)
    return {
      signedIn: credential !== undefined,
      ...credential?.email === undefined ? {} : { email: credential.email },
      ...credential?.projectId === undefined ? {} : { projectId: credential.projectId },
      // Whether this list is the real directory or the offline snapshot, so the
      // page can say which instead of presenting a stale list as current.
      catalogSource: directory === undefined ? 'fallback' : 'live',
      login,
      models: models.map(model => ({
        id: model.id,
        name: model.name,
        pool: model.pool,
        contextWindow: model.contextWindow,
        supportsThinking: model.supportsThinking,
        ...model.remainingFraction === undefined ? {} : { remainingFraction: model.remainingFraction },
        enabled: enabled === undefined || enabled.has(model.id),
      })),
    }
  }

  /**
   * Start a Google sign-in, or report the one already running.
   * @returns {Promise<object>} the current login state.
   */
  const beginLogin = async () => {
    if (pending !== undefined) return login
    const server = await startCallbackServer({ port: callbackPort })
    const controller = new AbortController()
    // The page counts down to this instant, so an abandoned sign-in is visibly
    // finite instead of looking like it will wait forever.
    const expiresAt = Date.now() + CALLBACK_TIMEOUT_MS
    pending = { server, controller, authUrl: server.authUrl }
    login = { state: 'pending', authUrl: server.authUrl, expiresAt }
    // Log the exact callback being awaited. When a browser reports a refused
    // connection, this line is what distinguishes "the attempt timed out" from
    // "this process is not the one the page is talking to" — the two causes
    // have identical symptoms from the browser's side.
    logger.info(
      `dsh-antigravity-connect: waiting for the Google sign-in callback on ${redirectUri(callbackPort)}`,
    )
    openBrowser(server.authUrl)
    // The flow outlives this request by design: the browser round-trip takes
    // as long as the user takes, and the page polls `status` meanwhile.
    void (async () => {
      try {
        const code = await server.waitForCode(controller.signal)
        const credential = await server.complete(code, store, controller.signal)
        login = {
          state: 'signed-in',
          ...credential.email === undefined ? {} : { email: credential.email },
        }
        ctx.emit('llm/adapters-updated')
      } catch (error) {
        login = { state: 'failed', error: redactSecrets(error?.message ?? error) }
      } finally {
        await server.close().catch(() => {})
        pending = undefined
      }
    })()
    return login
  }

  /**
   * Abandon a running sign-in and free the loopback port.
   * @returns {Promise<object>} the resulting login state.
   */
  const cancelLogin = async () => {
    if (pending === undefined) return login
    pending.controller.abort()
    await pending.server.close().catch(() => {})
    pending = undefined
    login = { state: 'idle' }
    return login
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (request, response) => {
          const url = new URL(request.url ?? '/', 'http://dsh.local')
          const route = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
          try {
            if (route === '' || route === 'status') {
              if (request.method !== 'GET') {
                sendJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }

            if (route === 'login') {
              if (request.method !== 'POST') {
                sendJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              sendJson(response, 200, { ok: true, value: await beginLogin() })
              return
            }

            if (route === 'login/cancel') {
              if (request.method !== 'POST') {
                sendJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              sendJson(response, 200, { ok: true, value: await cancelLogin() })
              return
            }

            if (route === 'logout') {
              if (request.method !== 'POST') {
                sendJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              await cancelLogin()
              await store.delete()
              client?.forget?.()
              login = { state: 'idle' }
              ctx.emit('llm/adapters-updated')
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }

            if (route === 'quota') {
              if (request.method !== 'GET' && request.method !== 'POST') {
                sendJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              sendJson(response, 200, { ok: true, value: await client.quota() })
              return
            }

            if (route === 'models') {
              if (request.method !== 'POST') {
                sendJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              const body = await readJson(request)
              if (body === null || typeof body !== 'object' || !Array.isArray(body.enabledModelIds)) {
                sendJson(response, 400, { ok: false, error: 'enabledModelIds must be an array' })
                return
              }
              const stored = await preferences.write(body.enabledModelIds)
              setEnabledModelIds(stored.enabledModelIds)
              // The picker reads `listModels()`, so the registry has to be told
              // the advertised set moved.
              ctx.emit('llm/adapters-updated')
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }

            sendJson(response, 404, { ok: false, error: 'not found' })
          } catch (error) {
            sendJson(response, 500, { ok: false, error: redactSecrets(error?.message ?? error) })
          }
        },
      }),
      'dsh-antigravity-connect: settings api',
    )
  })

  return {
    /** Current login state, for diagnostics and the CLI helper. */
    loginState: () => login,
  }
}
