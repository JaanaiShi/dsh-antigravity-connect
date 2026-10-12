/**
 * End-to-end integration: the plugin mounted into the real harness runtime.
 *
 * A genuine Cordis application hosts the real `LlmRuntime` and the real
 * `WebServer`, the plugin is loaded through `ctx.plugin()` exactly as the
 * profile loader does it, and the network is a fake Cloud Code Assist backend
 * on loopback. Everything between those two ends is production code.
 *
 * This is what catches a mistake the unit tests cannot: a wrong service
 * contract, a `Config` schema the loader rejects, model metadata the registry
 * refuses to normalize, or a settings route that never mounts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebServer from '@deepseek-ai/dsh-host-webserver'

/** The harness home for this run; must be set before `apply()` resolves paths. */
const HOME = await mkdtemp(join(tmpdir(), 'dsac-home-'))
process.env.DSH_HOME = HOME

const CREDENTIAL_PATH = join(HOME, 'storages', 'antigravity-connect-oauth.json')

/**
 * The model directory the fake backend reports.
 *
 * Shaped like the real `fetchAvailableModels` response, and including a model
 * that no hardcoded catalog could have known about (`gemini-3.8-flash-tiered`)
 * alongside the non-model entries the directory also carries. If the picker
 * ever stops reading this, these tests fail rather than silently offering a
 * snapshot.
 */
const DIRECTORY = {
  'gemini-3.8-flash-tiered': {
    maxTokens: 1048576, maxOutputTokens: 65536, supportsThinking: true, supportsImages: true,
    modelProvider: 'MODEL_PROVIDER_GOOGLE',
  },
  'gemini-3.1-pro-low': {
    displayName: 'Gemini 3.1 Pro (Low)', maxTokens: 1048576, maxOutputTokens: 65536,
    supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE',
  },
  'claude-opus-5-5-high': {
    displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000, maxOutputTokens: 128000,
    supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
  },
  'gpt-oss-120b-medium': {
    displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072, maxOutputTokens: 32768,
    supportsThinking: true, modelProvider: 'MODEL_PROVIDER_OPENAI',
  },
  'chat_20706': { maxTokens: 16384 },
  'tab_flash_lite_preview': { maxTokens: 16384 },
}

/** Every selectable id the directory above yields, in display order. */
const DIRECTORY_IDS = [
  'gemini-3.8-flash-tiered',
  'gemini-3.1-pro-low',
  'claude-opus-5-5-high',
  'gpt-oss-120b-medium',
]

/**
 * Start a fake Cloud Code Assist backend.
 * @returns {Promise<{ url: string, requests: object[], close: () => Promise<void> }>} the backend handle.
 */
async function fakeBackend() {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8'), headers: req.headers })

    if (req.url === '/v1internal:fetchAvailableModels') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: DIRECTORY }))
      return
    }
    if (req.url === '/v1internal:retrieveUserQuotaSummary') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        groups: [{
          displayName: 'Gemini Models',
          buckets: [{ bucketId: '5h', displayName: '5-hour limit', remainingFraction: 0.66 }],
        }],
      }))
      return
    }
    if (req.url === '/v1internal:loadCodeAssist') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ currentTier: { id: 'pro', name: 'Google AI Pro' } }))
      return
    }
    if (req.url?.startsWith('/v1internal:streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello from ' }, { text: 'Antigravity' }] } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: ' more' }] } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 2, candidatesTokenCount: 7 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `unexpected ${req.url}` } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(() => resolve(undefined))
    }),
  }
}

/**
 * Boot a harness application with the plugin mounted.
 * @param {string} endpoint - the backend base URL.
 * @returns {Promise<{ ctx: object, close: () => Promise<void> }>} the mounted app.
 */
async function boot(endpoint) {
  await mkdir(join(HOME, 'storages'), { recursive: true })
  await writeFile(CREDENTIAL_PATH, JSON.stringify({
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3_600_000,
    projectId: 'proj-e2e',
    email: 'e2e@example.com',
  }))

  const ctx = new Context()
  const fibers = [
    await ctx.plugin(LlmRuntime),
    // Port 0 asks the OS for a free port, so parallel test files never collide.
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
  ]

  const plugin = await import('../index.js')
  fibers.push(await ctx.plugin(plugin, { endpoint }))

  return {
    ctx,
    // Disposing the WebServer fiber is what releases its listening socket;
    // without it the test process would never exit.
    close: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

test('plugin: mounts into the real runtime and registers the provider route', async () => {
  const backend = await fakeBackend()
  const app = await boot(backend.url)
  try {
    // The registry accepted the route, which also proves the adapter's
    // provider metadata passed validation.
    const providers = app.ctx.llm.listProviders()
    assert.deepEqual(providers, [{ id: 'antigravity', name: 'Antigravity' }])

    // `listModels` runs the registry's own normalization, so a malformed entry
    // (a non-string description, a bad modality) would fail here.
    const models = await app.ctx.llm.listModels('antigravity')
    // The picker is built from the directory, so a model no hardcoded list could
    // have known about is offered.
    assert.deepEqual(models.map(model => model.id), DIRECTORY_IDS)
    assert.equal(models[0].provider, 'antigravity')
    assert.equal(models[0].id, 'gemini-3.8-flash-tiered')
    assert.equal(models[0].name, 'Gemini 3.8 Flash Tiered')
    assert.ok(models.every(model => typeof model.description === 'string'))
    assert.ok(models.every(model => Array.isArray(model.inputModalities)))
  } finally {
    await app.close()
    await backend.close()
  }
})

test('plugin: exact-model metadata survives registry normalization', async () => {
  const backend = await fakeBackend()
  const app = await boot(backend.url)
  try {
    const resolved = await app.ctx.llm.resolveModelInfo('antigravity', 'claude-opus-5-5-high')
    assert.equal(resolved.provider, 'antigravity')
    assert.equal(resolved.id, 'claude-opus-5-5-high')
    assert.equal(resolved.name, 'Claude Opus 5.5 (High)')
    // Both figures come from the directory the backend reported.
    assert.equal(resolved.context.contextWindow, 1_000_000)
    assert.equal(resolved.defaultMaxTokens, 128_000)
    // The directory does not enumerate reasoning levels, so a thinking model
    // gets the adapter's vocabulary rather than an invented per-model list.
    assert.deepEqual(resolved.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high'])

    // A model the directory reports as non-thinking gets no selector at all,
    // rather than a control that does nothing.
    const picker = await app.ctx.llm.resolveModelInfo('antigravity', 'gemini-3.1-pro-low')
    assert.deepEqual(picker.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high'])
    // A model absent from the directory still resolves, so a caller naming one
    // the picker does not list is not rejected outright.
    const unlisted = await app.ctx.llm.resolveModelInfo('antigravity', 'some-future-model')
    assert.equal(unlisted.id, 'some-future-model')
    assert.ok(unlisted.context.contextWindow > 0)
    assert.equal(unlisted.reasoning, undefined)
  } finally {
    await app.close()
    await backend.close()
  }
})

test('plugin: a full generation round-trips through the harness runtime', async () => {
  const backend = await fakeBackend()
  const app = await boot(backend.url)
  try {
    const chunks = []
    for await (const chunk of app.ctx.llm.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      messages: [{
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'say hello' }],
        source: { kind: 'user' },
      }],
    })) {
      chunks.push(chunk)
    }

    assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), [
      'Hello from ',
      'Antigravity',
      ' more',
    ])
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
      { type: 'text', text: 'Hello from Antigravity more' },
    ])
    assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 2,
    })
    const finish = chunks.at(-1)
    assert.deepEqual(finish.reason, { kind: 'stop' })
    // The replay envelope is what the registry stores on the assistant message.
    assert.deepEqual(finish.replayState, {
      response: {
        provider: 'antigravity',
        model: 'gemini-3.8-flash-tiered',
        finishReason: 'STOP',
      },
      blocks: [{ type: 'text' }],
    })

    // The request that left the process carried the resolved runtime model and
    // the project discovered from the credential.
    const sent = backend.requests.find(request => request.url?.startsWith('/v1internal:streamGenerateContent'))
    const body = JSON.parse(sent.body)
    assert.equal(body.model, 'gemini-3.8-flash-tiered')
    assert.equal(body.project, 'proj-e2e')
    assert.equal(body.request.contents[0].parts[0].text, 'say hello')
    assert.ok(sent.headers['client-metadata'] !== undefined)
  } finally {
    await app.close()
    await backend.close()
  }
})

test('plugin: the settings API is mounted on the harness web server', async () => {
  const backend = await fakeBackend()
  const app = await boot(backend.url)
  try {
    const base = `http://127.0.0.1:${app.ctx.webServer.port}/antigravity-connect/api`

    const status = await (await fetch(`${base}/status`)).json()
    assert.equal(status.ok, true)
    assert.equal(status.value.signedIn, true)
    assert.equal(status.value.email, 'e2e@example.com')
    assert.equal(status.value.projectId, 'proj-e2e')
    assert.deepEqual(status.value.models.map(model => model.id), DIRECTORY_IDS)
    assert.equal(status.value.catalogSource, 'live')

    const quota = await (await fetch(`${base}/quota`, { method: 'POST' })).json()
    assert.equal(quota.ok, true)
    assert.equal(quota.value.planLabel, 'Google AI Pro (pro)')
    assert.equal(quota.value.groups[0].buckets[0].remainingFraction, 0.66)

    // Turning models off must change what the picker is offered, which only
    // works if the API's mirror and the adapter are the same source.
    const saved = await (await fetch(`${base}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabledModelIds: ['gemini-3.8-flash-tiered'] }),
    })).json()
    assert.equal(saved.ok, true)

    const after = await app.ctx.llm.listModels('antigravity')
    assert.deepEqual(after.map(model => model.id), ['gemini-3.8-flash-tiered'])
  } finally {
    await app.close()
    await backend.close()
  }
})

test('plugin: the credential file holds the discovered project after a call', async () => {
  const backend = await fakeBackend()
  const app = await boot(backend.url)
  try {
    for await (const _ of app.ctx.llm.stream({
      provider: 'antigravity',
      model: 'gemini-2.5-flash',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    })) void _

    // A stored access token is reused rather than refreshed, so the backend saw
    // the credential's bearer token.
    const sent = backend.requests[0]
    assert.equal(sent.headers.authorization, 'Bearer access-token')
  } finally {
    await app.close()
    await backend.close()
  }
})
