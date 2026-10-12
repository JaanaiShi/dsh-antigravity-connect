/**
 * Settings-API tests: the routes the browser page actually calls, driven over a
 * real HTTP server against the real credential and preference stores.
 *
 * The harness context and the Cloud Code Assist client are stubbed; everything
 * between them — routing, method checks, the response envelope, persistence,
 * and the registry notification — is the production code path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerApi } from '../lib/api.js'
import { CredentialStore } from '../lib/credentials.js'
import { PreferenceStore } from '../lib/preferences.js'

/**
 * Ask the OS for a free loopback port.
 *
 * Tests must never hardcode the login callback port. This suite opens a genuine
 * loopback listener, and a checkout is routinely the profile's linked plugin, so
 * a fixed port could be read by a running app and hand a browser an OAuth
 * round-trip aimed at a listener the test had already closed.
 *
 * @returns {Promise<number>} a port that was free a moment ago.
 */
async function freeLoopbackPort() {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const { port } = probe.address()
  await new Promise(resolve => probe.close(() => resolve(undefined)))
  return port
}

/**
 * Mount the API over a stub context and a live HTTP server.
 * @param {object} [overrides] - client and login-port overrides.
 * @returns {Promise<object>} the base URL, recorded emissions, stores, and the disposer.
 */
async function startApi(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsac-api-'))
  const store = new CredentialStore(join(dir, 'oauth.json'))
  const preferences = new PreferenceStore(join(dir, 'prefs.json'))

  // Undefined is "no explicit selection", which offers the whole directory.
  let enabled
  const emitted = []

  let route
  const ctx = {
    emit: (name) => { emitted.push(name) },
    logger: { info() {}, warn() {}, error() {} },
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['webServer'])
      callback({
        effect: (factory) => factory(),
        webServer: {
          register: (registered) => {
            route = registered
            return () => { route = undefined }
          },
        },
      })
    },
  }

  /**
   * A directory shaped like the backend's, so the page lists real models.
   *
   * `??` would substitute the default when a caller passes `undefined` to mean
   * "the directory is unreachable", so the presence of the key decides.
   */
  const directory = 'directory' in overrides ? overrides.directory : {
    models: {
      'gemini-3.8-flash-tiered': { maxTokens: 1048576, maxOutputTokens: 65536, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000, maxOutputTokens: 128000, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
      'chat_20706': { maxTokens: 16384 },
    },
  }

  const quotaCalls = []
  const client = {
    modelDirectory: async () => directory,
    quota: async () => {
      quotaCalls.push(Date.now())
      return overrides.quota ?? {
        projectId: 'proj-1',
        planLabel: 'Google AI Pro',
        groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: '5h', displayName: '5-hour', remainingFraction: 0.5 }] }],
        fetchedAt: Date.now(),
      }
    },
    forget: () => { quotaCalls.push('forget') },
    ...overrides.client,
  }

  registerApi(ctx, {
    store,
    preferences,
    client,
    callbackPort: overrides.callbackPort,
    getEnabledModelIds: () => enabled,
    setEnabledModelIds: (ids) => { enabled = ids },
  })

  assert.ok(route !== undefined, 'the API registered a route')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/antigravity-connect/api')

  const server = createServer((req, res) => route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}/antigravity-connect/api`,
    store,
    preferences,
    emitted,
    quotaCalls,
    enabledModelIds: () => enabled,
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(() => resolve(undefined))
    }),
  }
}

/**
 * Call one route and parse the envelope.
 * @param {string} url - absolute route URL.
 * @param {object} [init] - fetch options.
 * @returns {Promise<{ status: number, body: any }>} the status and parsed body.
 */
async function call(url, init) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
  return { status: response.status, body: await response.json() }
}

test('api: status reports the live directory, not a snapshot', async () => {
  const api = await startApi()
  try {
    const { status, body } = await call(`${api.url}/status`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.value.signedIn, false)
    assert.equal(body.value.email, undefined)
    assert.deepEqual(body.value.login, { state: 'idle' })
    // Two of the directory's three entries are real models; `chat_*` is not.
    assert.equal(body.value.models.length, 2)
    assert.deepEqual(body.value.models.map(model => model.id), [
      'gemini-3.8-flash-tiered',
      'claude-opus-5-5-high',
    ])
    // Which list this is, so a stale fallback cannot pass as current.
    assert.equal(body.value.catalogSource, 'live')
    // No stored selection means every offered model is on.
    assert.ok(body.value.models.every(model => model.enabled))
    assert.deepEqual(Object.keys(body.value.models[0]).sort(), [
      'contextWindow', 'enabled', 'id', 'name', 'pool', 'supportsThinking',
    ])
  } finally {
    await api.close()
  }
})

test('api: an unreachable directory is reported as the fallback list', async () => {
  const api = await startApi({ directory: undefined })
  try {
    const { body } = await call(`${api.url}/status`)
    assert.equal(body.value.catalogSource, 'fallback')
    assert.ok(body.value.models.length > 0)
    // Still offered, so a transient backend fault cannot empty the picker.
    assert.ok(body.value.models.every(model => model.enabled))
  } finally {
    await api.close()
  }
})

test('api: status reflects a stored credential', async () => {
  const api = await startApi()
  try {
    await api.store.write({
      refresh: 'r',
      access: 'a',
      expires: Date.now() + 3_600_000,
      email: 'me@example.com',
      projectId: 'proj-9',
    })
    const { body } = await call(`${api.url}/status`)
    assert.equal(body.value.signedIn, true)
    assert.equal(body.value.email, 'me@example.com')
    assert.equal(body.value.projectId, 'proj-9')
  } finally {
    await api.close()
  }
})

test('api: the model selection persists and notifies the registry', async () => {
  const api = await startApi()
  try {
    const { status, body } = await call(`${api.url}/models`, {
      method: 'POST',
      body: JSON.stringify({ enabledModelIds: ['claude-opus-5-5-high'] }),
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(
      body.value.models.filter(model => model.enabled).map(model => model.id),
      ['claude-opus-5-5-high'],
    )
    // The adapter reads this mirror synchronously through `listModels`.
    assert.deepEqual(api.enabledModelIds(), ['claude-opus-5-5-high'])
    // The picker has to be told the advertised set moved.
    assert.deepEqual(api.emitted, ['llm/adapters-updated'])

    // The document survives a re-read from disk.
    assert.deepEqual((await api.preferences.read()).enabledModelIds, ['claude-opus-5-5-high'])

    const followUp = await call(`${api.url}/status`)
    assert.deepEqual(
      followUp.body.value.models.filter(model => model.enabled).map(model => model.id),
      ['claude-opus-5-5-high'],
    )
  } finally {
    await api.close()
  }
})

test('api: a malformed model body is refused without touching the store', async () => {
  const api = await startApi()
  try {
    for (const payload of [{}, { enabledModelIds: 'nope' }, { enabledModelIds: null }]) {
      const { status, body } = await call(`${api.url}/models`, { method: 'POST', body: JSON.stringify(payload) })
      assert.equal(status, 400)
      assert.equal(body.ok, false)
      assert.match(body.error, /enabledModelIds/)
    }
    // The selection stays unset: a refused write must not create an explicit
    // "none" document out of a malformed request.
    assert.equal(api.enabledModelIds(), undefined)
    assert.deepEqual(api.emitted, [])

    const notJson = await call(`${api.url}/models`, { method: 'POST', body: '{oops' })
    assert.equal(notJson.status, 500)
    assert.equal(notJson.body.ok, false)
    assert.match(notJson.body.error, /not valid JSON/)
  } finally {
    await api.close()
  }
})

test('api: quota proxies the client and surfaces its failures', async () => {
  const api = await startApi()
  try {
    const { status, body } = await call(`${api.url}/quota`, { method: 'POST' })
    assert.equal(status, 200)
    assert.equal(body.value.planLabel, 'Google AI Pro')
    assert.equal(body.value.groups.length, 1)
    assert.equal(api.quotaCalls.length, 1)
  } finally {
    await api.close()
  }

  const failing = await startApi({
    client: { quota: async () => { throw new Error('HTTP 401: token expired') } },
  })
  try {
    const { status, body } = await call(`${failing.url}/quota`, { method: 'POST' })
    assert.equal(status, 500)
    assert.equal(body.ok, false)
    assert.match(body.error, /401/)
  } finally {
    await failing.close()
  }
})

test('api: logout clears the credential, the client cache, and the state', async () => {
  const api = await startApi()
  try {
    await api.store.write({ refresh: 'r', access: 'a', expires: Date.now() + 3_600_000, email: 'me@example.com' })
    const { status, body } = await call(`${api.url}/logout`, { method: 'POST' })
    assert.equal(status, 200)
    assert.equal(body.value.signedIn, false)
    assert.equal(await api.store.read(), undefined)
    // The cached project and catalog belong to the account that just left.
    assert.ok(api.quotaCalls.includes('forget'))
    assert.deepEqual(api.emitted, ['llm/adapters-updated'])
  } finally {
    await api.close()
  }
})

test('api: a sign-in runs on the loopback port and can be cancelled', async () => {
  const callbackPort = await freeLoopbackPort()
  const api = await startApi({ callbackPort })
  try {
    const login = await call(`${api.url}/login`, { method: 'POST' })
    assert.equal(login.status, 200)
    assert.equal(login.body.value.state, 'pending')
    const authUrl = new URL(login.body.value.authUrl)
    assert.equal(authUrl.origin + authUrl.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
    assert.equal(authUrl.searchParams.get('redirect_uri'), `http://localhost:${callbackPort}/oauth-callback`)
    assert.equal(authUrl.searchParams.get('response_type'), 'code')
    assert.ok(authUrl.searchParams.get('code_challenge').length > 0)

    // The page counts down instead of appearing to wait forever, so an
    // abandoned sign-in is visibly finite.
    assert.equal(typeof login.body.value.expiresAt, 'number')
    assert.ok(login.body.value.expiresAt > Date.now())

    // A second request reports the same outstanding flow instead of opening a
    // second listener on the same port.
    const again = await call(`${api.url}/login`, { method: 'POST' })
    assert.equal(again.body.value.state, 'pending')
    assert.equal(again.body.value.authUrl, login.body.value.authUrl)

    const statusWhilePending = await call(`${api.url}/status`)
    assert.equal(statusWhilePending.body.value.login.state, 'pending')

    const cancelled = await call(`${api.url}/login/cancel`, { method: 'POST' })
    assert.equal(cancelled.body.value.state, 'idle')

    // The port is free again, which is what proves the listener was released.
    await new Promise((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(callbackPort, '127.0.0.1', () => probe.close(() => resolve(undefined)))
    })
  } finally {
    await api.close()
  }
})

test('api: unknown routes, bad methods, and unknown sub-paths are refused', async () => {
  const api = await startApi()
  try {
    assert.equal((await call(`${api.url}/nope`)).status, 404)

    const wrongMethod = await call(`${api.url}/status`, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.body.ok, false)

    assert.equal((await call(`${api.url}/models`)).status, 405)
    assert.equal((await call(`${api.url}/logout`)).status, 405)
    assert.equal((await call(`${api.url}/quota`)).status, 200, 'quota accepts GET')
  } finally {
    await api.close()
  }
})

test('api: a route failure never leaks a credential from the backend', async () => {
  const api = await startApi({
    client: {
      quota: async () => {
        const error = new Error('rejected: Authorization: Bearer ya29.verysecretvalue')
        throw error
      },
    },
  })
  try {
    const { status, body } = await call(`${api.url}/quota`, { method: 'POST' })
    assert.equal(status, 500)
    assert.ok(!body.error.includes('ya29.verysecretvalue'))
    assert.ok(body.error.includes('<redacted>'))
  } finally {
    await api.close()
  }
})
