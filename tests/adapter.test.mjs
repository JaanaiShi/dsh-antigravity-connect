/**
 * Provider-path tests: SSE framing to harness chunks, model metadata, and error
 * translation. A stubbed Cloud Code Assist client stands in for the network, so
 * these exercise the adapter itself with no credentials and no backend.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AntigravityAdapter } from '../lib/adapter.js'
import { CloudCodeError, unwrapPayload } from '../lib/cloudcode.js'


/**
 * A directory response shaped like the backend's, used by every test here.
 *
 * Deliberately includes a model the old hardcoded catalog never knew about
 * (`gemini-3.8-flash-tiered`) plus the non-model entries the directory also
 * carries, so the tests fail if either regresses.
 */
const DIRECTORY = {
  models: {
    'gemini-3.8-flash-tiered': { maxTokens: 1048576, maxOutputTokens: 65536, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
    'gemini-3.8-flash-tiered': { maxTokens: 1048576, maxOutputTokens: 65536, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
    'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image', supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
    'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro (High)', maxTokens: 1048576, maxOutputTokens: 65535, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
    'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000, maxOutputTokens: 128000, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
    'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072, maxOutputTokens: 32768, supportsThinking: true, modelProvider: 'MODEL_PROVIDER_OPENAI' },
    'chat_20706': { maxTokens: 16384 },
    'tab_flash_lite_preview': { maxTokens: 16384 },
  },
}

/** Every selectable id the directory above yields, in display order. */
const DIRECTORY_IDS = [
  'gemini-3.8-flash-tiered',
  'gemini-3.8-flash-tiered',
  'gemini-3.1-flash-image',
  'gemini-3.1-pro-high',
  'claude-opus-5-5-high',
  'gpt-oss-120b-medium',
]

/**
 * Build an adapter over a scripted stream and a stubbed directory.
 * @param {object} input - payloads to yield, an optional failure, the directory, and the enabled selection.
 * @returns {{ adapter: AntigravityAdapter, bodies: object[] }} the adapter and every request body it built.
 */
function harness({ payloads = [], failure, directory = DIRECTORY, enabled } = {}) {
  const bodies = []
  const client = {
    project: async () => 'proj-test',
    modelDirectory: async () => directory,
    async *streamGenerate(body) {
      bodies.push(body)
      if (failure !== undefined) throw failure
      for (const payload of payloads) yield payload
    },
    quota: async () => ({ projectId: 'proj-test', groups: [], fetchedAt: Date.now() }),
  }
  const adapter = new AntigravityAdapter({
    client,
    enabledModelIds: () => enabled,
    resolveAttachment: async () => undefined,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { adapter, bodies }
}

/**
 * Collect a chunk stream.
 * @param {AsyncIterable<object>} stream - the chunk stream.
 * @returns {Promise<object[]>} every chunk in order.
 */
async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** A minimal request for one call. */
function request(overrides = {}) {
  return {
    provider: 'antigravity',
    model: 'gemini-3.8-flash-tiered',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    ...overrides,
  }
}

test('adapter: shapes the provider route and honours the enabled set', async () => {
  const { adapter } = harness({ enabled: ['gemini-3.8-flash-tiered', 'claude-opus-5-5-high'] })
  assert.deepEqual(adapter.providerInfo('antigravity'), { id: 'antigravity', name: 'Antigravity' })

  const listed = await adapter.listModels('antigravity')
  assert.deepEqual(listed.map(model => model.id), ['gemini-3.8-flash-tiered', 'claude-opus-5-5-high'])
  assert.equal(listed[0].provider, 'antigravity')
  assert.match(listed[0].description, /quota pool/)
  assert.deepEqual(listed[0].inputModalities, ['text', 'image'])
})

test('adapter: the route owns its retry budget, and a throttle is not retried', () => {
  const { adapter } = harness()
  const policy = adapter.providerRetryPolicy('antigravity')

  // The client only reports RATE_LIMIT once every candidate host refused the
  // same request, so retrying it repeats a walk that already failed.
  assert.ok(!policy.retryableCodes.includes('RATE_LIMIT'))
  // A degenerate completion and a transient server fault are still worth
  // repeating, so the override must not have narrowed them away.
  assert.ok(policy.retryableCodes.includes('EMPTY_RESPONSE'))
  assert.ok(policy.retryableCodes.includes('SERVER'))
  assert.ok(policy.retryableCodes.includes('TRANSPORT'))
  assert.ok(policy.retryableCodes.includes('TIMEOUT'))
  // A spent allowance is never retryable, and never failover-able either.
  assert.ok(!policy.retryableCodes.includes('QUOTA'))
  assert.equal(policy.mode, 'normal')
  // 顶层必须展开退避参数，避免 dsh-llm-retry 计算出 NaN 延迟导致 session event 序列化失败
  assert.equal(policy.initialDelayMs, 500)
  assert.equal(policy.maxDelayMs, 10_000)
  assert.equal(policy.jitterRatio, 0.1)
})

test('adapter: resolveModel reports context, output cap, and reasoning levels', async () => {
  const { adapter } = harness()
  const resolved = await adapter.resolveModel('antigravity', 'claude-opus-5-5-high')
  // Both figures come from the directory, not from a table.
  assert.equal(resolved.context.contextWindow, 1_000_000)
  assert.equal(resolved.defaultMaxTokens, 128_000)
  // The directory says a model thinks but not which levels it has, so the
  // adapter offers its own vocabulary rather than inventing a per-model list.
  assert.deepEqual(resolved.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high'])
  // The provider's own default must not be restated as an adapter default.
  assert.equal(resolved.reasoning.defaultEffort, undefined)
  assert.equal(resolved.name, 'Claude Opus 5.5 (High)')

  // An unknown model still resolves, using the fallback capacity.
  const unknown = await adapter.resolveModel('antigravity', 'future-model')
  assert.equal(unknown.id, 'future-model')
  assert.ok(unknown.context.contextWindow > 0)
  assert.equal(unknown.reasoning, undefined)
})

test('adapter: streams reasoning, text, and a tool call in order', async () => {
  const { adapter, bodies } = harness({
    payloads: [
      { candidates: [{ content: { parts: [{ text: 'Let me think', thought: true, thoughtSignature: 'sig-1' }] } }] },
      { candidates: [{ content: { parts: [{ text: ' more', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] },
      { candidates: [{ content: { parts: [{ text: ' world' }] } }] },
      {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a' }, id: 'c1' } }] },
          finishReason: 'STOP',
        }],
      },
      { usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 20, thoughtsTokenCount: 5 } },
    ],
  })

  const chunks = await drain(adapter.stream(request()))

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Let me think' },
    { type: 'reasoning-delta', index: 0, text: ' more' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think more' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'Hello' },
    { type: 'text-delta', index: 1, text: ' world' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello world' } },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'c1', name: 'read_file', argumentsDelta: '{"path":"a"}' },
    {
      type: 'block-end',
      index: 2,
      block: { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a"}' },
    },
    // Counts are disjoint: uncached input is reported apart from cache reads,
    // and thoughts count as output the user never sees.
    {
      type: 'usage',
      usage: { inputTokens: 70, outputTokens: 25, cacheReadTokens: 30, reasoningTokens: 5 },
    },
    {
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: {
        response: {
          provider: 'antigravity',
          model: 'gemini-3.8-flash-tiered',
          finishReason: 'STOP',
        },
        // One entry per emitted block, in first-seen order.
        blocks: [{ type: 'reasoning', thoughtSignature: 'sig-1' }, { type: 'text' }, { type: 'tool-call' }],
      },
    },
  ])

  // The request that reached the transport carries the resolved runtime model.
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].model, 'gemini-3.8-flash-tiered')
  assert.equal(bodies[0].project, 'proj-test')
})

test('adapter: unwraps the Vertex response envelope', async () => {
  const { adapter } = harness({
    payloads: [
      { response: { candidates: [{ content: { parts: [{ text: 'wrapped' }] } }] } },
      { response: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } } },
    ],
  })
  const chunks = await drain(adapter.stream(request()))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta'), [
    { type: 'text-delta', index: 0, text: 'wrapped' },
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  assert.deepEqual(chunks.at(-1).replayState.response.finishReason, 'STOP')

  // The helper is exported and used by the adapter.
  assert.deepEqual(unwrapPayload({ response: { candidates: [1] } }), { candidates: [1] })
  assert.deepEqual(unwrapPayload({ candidates: [1] }), { candidates: [1] })
})

test('adapter: a reasoning effort selects the mapped runtime model', async () => {
  const { adapter, bodies } = harness({
    payloads: [{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }],
  })
  await drain(adapter.stream(request({ model: 'gemini-3.7-flash-tiered', reasoningEffort: 'medium' })))
  assert.equal(bodies[0].model, 'gemini-3.7-flash-tiered')
})

test('adapter: an empty but successful stream is an error, not an empty reply', async () => {
  const { adapter } = harness({
    payloads: [{ candidates: [{ finishReason: 'STOP' }] }],
  })
  await assert.rejects(drain(adapter.stream(request())), (error) => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

test('adapter: provider failures become harness error codes', async () => {
  const auth = harness({
    failure: new CloudCodeError('antigravity-connect: generation failed (HTTP 401): bad token', {
      code: 'AUTH',
      status: 401,
    }),
  })
  await assert.rejects(drain(auth.adapter.stream(request())), (error) => {
    assert.equal(error.code, 'AUTH')
    assert.equal(error.failure.status, 401)
    // The message tells the user where to fix it.
    assert.match(error.message, /Settings > Antigravity/)
    return true
  })

  const missing = harness({
    failure: new CloudCodeError('not signed in', { code: 'MISSING_CREDENTIAL' }),
  })
  await assert.rejects(drain(missing.adapter.stream(request())), (error) => {
    assert.equal(error.code, 'AUTH')
    assert.match(error.message, /not signed in/)
    return true
  })

  const quota = harness({
    failure: new CloudCodeError('quota reached', { code: 'QUOTA', status: 429 }),
  })
  await assert.rejects(drain(quota.adapter.stream(request())), (error) => {
    assert.equal(error.code, 'QUOTA')
    return true
  })

  const idle = harness({
    failure: new CloudCodeError('nothing for 300s', { code: 'LLM_STREAM_IDLE_TIMEOUT' }),
  })
  await assert.rejects(drain(idle.adapter.stream(request())), (error) => {
    assert.equal(error.code, 'LLM_STREAM_IDLE_TIMEOUT')
    return true
  })

  // A project-discovery failure is translated too, before any request is built.
  const discovery = new AntigravityAdapter({
    client: {
      project: async () => { throw new CloudCodeError('no project', { code: 'PROJECT_DISCOVERY' }) },
      // eslint-disable-next-line require-yield
      async *streamGenerate() { throw new Error('unreachable') },
    },
    enabledModelIds: () => undefined,
    resolveAttachment: async () => undefined,
    logger: { info() {}, warn() {}, error() {} },
  })
  await assert.rejects(drain(discovery.stream(request())), (error) => {
    assert.equal(error.code, 'PROJECT_DISCOVERY')
    return true
  })
})

test('adapter: a caller abort passes through untouched', async () => {
  const controller = new AbortController()
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
  const { adapter } = harness({ failure: abortError })
  const stream = adapter.stream(request({ signal: controller.signal }))
  controller.abort()
  await assert.rejects(drain(stream), (error) => {
    // The harness maps an abort to `reason: aborted`, so the adapter must not
    // relabel it as a provider fault.
    assert.equal(error.name, 'AbortError')
    return true
  })
})
