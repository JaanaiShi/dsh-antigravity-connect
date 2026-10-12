/**
 * Offline tests for every module that does not need the harness runtime.
 *
 * The provider path itself is exercised against a stub backend in
 * `http.test.mjs`; this file covers the data and protocol translations that are
 * cheap to get subtly wrong.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fallbackModels, modelsFromDirectory, normalizeModel, poolFor, isSelectableModel, displayNameFromId, POOL_GEMINI, POOL_THIRD_PARTY } from '../lib/catalog.js'
import { CredentialStore, redactSecrets } from '../lib/credentials.js'
import { PreferenceStore } from '../lib/preferences.js'
import { buildAuthUrl, generatePKCE } from '../lib/oauth.js'
import {
  buildRequest,
  convertTools,
  maxOutputTokensFor,
  normalizeLegacySchema,
  parseArguments,
  sanitizeToolCallId,
  sanitizeText,
  stripMetaSchema,
  toolCallIdNeeded,
} from '../lib/serialize.js'
import { redirectUri, SCOPES } from '../lib/constants.js'

/** @returns {Promise<string>} a fresh temporary directory. */
async function scratch() {
  return mkdtemp(join(tmpdir(), 'dsac-test-'))
}

test('catalog: the live directory is what the picker is built from', () => {
  // A trimmed but real-shaped directory response.
  const models = modelsFromDirectory({
    models: {
      'gemini-3.8-flash-tiered': { maxTokens: 1048576, maxOutputTokens: 65536, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'gemini-3.7-flash-tiered': { maxTokens: 1048576, maxOutputTokens: 65536, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro (High)', maxTokens: 1048576, maxOutputTokens: 65535, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'gemini-3.1-pro-low': { displayName: 'Gemini 3.1 Pro (Low)', maxTokens: 1048576, maxOutputTokens: 65536, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000, maxOutputTokens: 128000, supportsThinking: true, supportsImages: true, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072, maxOutputTokens: 32768, supportsThinking: true, modelProvider: 'MODEL_PROVIDER_OPENAI' },
      // Entries that are not conversational models.
      'chat_20706': { maxTokens: 16384 },
      'tab_flash_lite_preview': { maxTokens: 16384 },
      'secret-internal': { isInternal: true, maxTokens: 999 },
    },
  })

  // `gemini-3.1-pro-high` is deliberately absent: the backend advertises it with
  // full metadata but 400s every request, so it is withheld from the picker. Its
  // servable sibling is listed in its place.
  assert.deepEqual(models.map(m => m.id), [
    'gemini-3.8-flash-tiered',
    'gemini-3.7-flash-tiered',
    'gemini-3.1-pro-low',
    'claude-opus-5-5-high',
    'gpt-oss-120b-medium',
  ])

  // A model the old hardcoded table never knew about must come through, and
  // with no displayName in the directory it gets a readable derived name.
  assert.equal(models[0].id, 'gemini-3.8-flash-tiered')
  assert.equal(models[0].name, 'Gemini 3.8 Flash Tiered')
  assert.deepEqual(models.map(m => m.pool), [
    POOL_GEMINI, POOL_GEMINI, POOL_GEMINI, POOL_THIRD_PARTY, POOL_THIRD_PARTY,
  ])
  assert.equal(models[3].contextWindow, 1000000)
  assert.equal(models[3].maxOutputTokens, 128000)
  assert.equal(models[4].supportsImages, false)
})

test('catalog: a route the backend advertises but refuses to serve is withheld', () => {
  // The directory ships full metadata for this id, so nothing about the entry
  // itself marks it as unusable; only the backend's answer does. Measured on a
  // live account: `gemini-3.1-pro-high` answers 400 INVALID_ARGUMENT for every
  // request shape, while `gemini-3.1-pro-low` and `gemini-pro-agent` serve.
  const advertised = {
    displayName: 'Gemini 3.1 Pro (High)',
    maxTokens: 1048576,
    maxOutputTokens: 65535,
    supportsThinking: true,
    supportsImages: true,
    modelProvider: 'MODEL_PROVIDER_GOOGLE',
  }
  assert.equal(isSelectableModel('gemini-3.1-pro-high', advertised), false)
  // A picker row that always fails is worse than a missing one, but the
  // servable siblings must survive the same filter.
  assert.equal(isSelectableModel('gemini-3.1-pro-low', advertised), true)
  assert.equal(isSelectableModel('gemini-pro-agent', advertised), true)

  const models = modelsFromDirectory({ models: { 'gemini-3.1-pro-high': advertised } })
  assert.deepEqual(models.map(m => m.id), [])
})

test('catalog: unnamed routes get a readable name, and sizing is never zero', () => {
  // The -tiered routes carry no displayName.
  assert.equal(displayNameFromId('gemini-3.8-flash-tiered'), 'Gemini 3.8 Flash Tiered')
  const bare = normalizeModel('gemini-3.8-flash-tiered', { maxTokens: 1048576, maxOutputTokens: 65536 })
  assert.equal(bare.name, 'Gemini 3.8 Flash Tiered')

  // The image route is reported with no token figures at all, and a model with
  // no capacity is unusable, so both numbers must be assumed rather than zero.
  const unsized = normalizeModel('gemini-3.1-flash-image', { supportsImages: true })
  assert.ok(unsized.contextWindow > 0)
  assert.ok(unsized.maxOutputTokens > 0)

  // A reply cap above the context window is rejected by the backend.
  const skewed = normalizeModel('odd', { maxTokens: 1000, maxOutputTokens: 9000 })
  assert.equal(skewed.maxOutputTokens, 1000)
})

test('catalog: gating and pool mapping', () => {
  assert.equal(isSelectableModel('gemini-3.8-flash-tiered', {}), true)
  assert.equal(isSelectableModel('chat_1', {}), false)
  assert.equal(isSelectableModel('tab_1', {}), false)
  assert.equal(isSelectableModel('internal', { isInternal: true }), false)
  assert.equal(isSelectableModel('', {}), false)
  assert.equal(isSelectableModel('x', null), false)

  // The provider token decides the pool; the id is only the fallback.
  assert.equal(poolFor('MODEL_PROVIDER_ANTHROPIC', 'gemini-x'), POOL_THIRD_PARTY)
  assert.equal(poolFor('MODEL_PROVIDER_OPENAI', 'gemini-x'), POOL_THIRD_PARTY)
  assert.equal(poolFor('MODEL_PROVIDER_GOOGLE', 'claude-x'), POOL_GEMINI)
  assert.equal(poolFor(undefined, 'claude-x'), POOL_THIRD_PARTY)
  assert.equal(poolFor(undefined, 'gemini-x'), POOL_GEMINI)
})

test('catalog: the fallback list is only for an unreachable directory', () => {
  const models = fallbackModels()
  assert.ok(models.length > 0)
  for (const model of models) {
    assert.ok(model.id.length > 0)
    assert.ok(model.name.length > 0)
    assert.ok(model.contextWindow > 0)
    assert.ok(model.maxOutputTokens > 0)
    assert.ok([POOL_GEMINI, POOL_THIRD_PARTY].includes(model.pool))
  }
  assert.equal(new Set(models.map(m => m.id)).size, models.length)
  // An empty or malformed directory must not throw; it yields nothing, and the
  // caller is the one that decides to fall back.
  assert.deepEqual(modelsFromDirectory(undefined), [])
  assert.deepEqual(modelsFromDirectory({}), [])
  assert.deepEqual(modelsFromDirectory({ models: null }), [])
})

test('catalog: the output cap falls back by model family', () => {
  assert.equal(maxOutputTokensFor('claude-opus-5-5-high'), 128000)
  assert.equal(maxOutputTokensFor('gpt-oss-120b-medium'), 32768)
  assert.equal(maxOutputTokensFor('gemini-3.8-flash-tiered'), 65536)
  assert.equal(maxOutputTokensFor('gemini-3.1-pro-high'), 65535)
})

test('serialize: sanitizeText replaces lone surrogates', () => {
  assert.equal(sanitizeText('ok'), 'ok')
  assert.equal(sanitizeText('\uD800'), '\uFFFD')
  assert.equal(sanitizeText(undefined), '')
})

test('serialize: parseArguments tolerates every shape', () => {
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 })
  assert.deepEqual(parseArguments({ a: 1 }), { a: 1 })
  assert.deepEqual(parseArguments('not json'), {})
  assert.deepEqual(parseArguments('[1,2]'), {})
  assert.deepEqual(parseArguments(undefined), {})
})

test('serialize: tool-call ids are sanitized and never empty', () => {
  assert.equal(sanitizeToolCallId('call/1:2', 'tool'), 'call_1_2')
  assert.ok(sanitizeToolCallId('', 'read_file').startsWith('read_file_'))
  assert.ok(sanitizeToolCallId('x'.repeat(200), 't').length <= 64)
  assert.equal(toolCallIdNeeded('claude-opus-5-5-high', 'claude-opus-4-6-thinking'), true)
  assert.equal(toolCallIdNeeded('gpt-oss-120b', 'gpt-oss-120b-medium'), true)
  assert.equal(toolCallIdNeeded('gemini-3.8-flash-tiered', 'gemini-3.8-flash-tiered'), false)
})

test('serialize: schema conversion differs per model family', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { unused: { type: 'string' } },
    type: 'object',
    properties: {
      path: { type: ['string', 'null'], description: 'file' },
      mode: { type: 'string', enum: ['read', 'write'] },
      count: { type: 'integer', enum: [1, 2] },
    },
    required: ['path'],
    additionalProperties: false,
  }

  assert.deepEqual(stripMetaSchema(schema).$schema, undefined)
  assert.deepEqual(stripMetaSchema(schema).$defs, undefined)

  const legacy = normalizeLegacySchema(stripMetaSchema(schema))
  // A type union collapses to its non-null member.
  assert.equal(legacy.properties.path.type, 'string')
  // `additionalProperties` is not in the legacy whitelist.
  assert.equal(legacy.additionalProperties, undefined)
  // A non-string enum cannot be expressed, so the constraint is dropped rather
  // than forwarded as a hard 400.
  assert.equal(legacy.properties.count.enum, undefined)
  assert.deepEqual(legacy.properties.mode.enum, ['read', 'write'])

  const tools = [{ name: 'read_file', description: 'Read a file', parameters: schema }]
  const modern = convertTools(tools, false)
  assert.ok(modern[0].functionDeclarations[0].parametersJsonSchema !== undefined)
  assert.equal(modern[0].functionDeclarations[0].parameters, undefined)

  const reduced = convertTools(tools, true)
  assert.ok(reduced[0].functionDeclarations[0].parameters !== undefined)
  assert.equal(reduced[0].functionDeclarations[0].parametersJsonSchema, undefined)

  assert.equal(convertTools([], false), undefined)
  assert.equal(convertTools(undefined, false), undefined)
})

/** A conversation exercising text, reasoning, a tool call, and its result. */
function conversation() {
  return [
    {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'read the file' }],
      source: { kind: 'user' },
    },
    {
      id: 'm2',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'I should look at it' },
        { type: 'text', text: 'Reading now.' },
        { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ],
      source: {
        kind: 'model',
        provider: 'antigravity',
        model: 'claude-opus-5-5-high',
        replayState: {
          response: { provider: 'antigravity', model: 'claude-opus-5-5-high', runtimeModel: 'claude-opus-4-6-thinking' },
          blocks: [
            { type: 'reasoning', thoughtSignature: 'sig-reason' },
            { type: 'text' },
            { type: 'tool-call', thoughtSignature: 'sig-call' },
          ],
        },
      },
    },
    {
      id: 'm3',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'contents' }] }],
      source: { kind: 'tool', callId: 'call-1' },
    },
  ]
}

test('serialize: buildRequest produces the Cloud Code Assist envelope', async () => {
  const body = await buildRequest({
    options: {
      provider: 'antigravity',
      model: 'claude-opus-5-5-high',
      messages: conversation(),
      system: 'extra system text',
      temperature: 0.4,
      maxTokens: 999_999,
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
    },
    modelId: 'claude-opus-5-5-high',
    maxOutputTokens: 128000,
    projectId: 'proj-1',
    resolveAttachment: async () => undefined,
  })

  assert.equal(body.project, 'proj-1')
  assert.equal(body.model, 'claude-opus-5-5-high')
  assert.equal(body.requestType, 'agent')
  assert.equal(body.userAgent, 'antigravity')
  assert.match(body.requestId, /^antigravity-\d+-[0-9a-f]{12}$/)

  const request = body.request
  assert.equal(request.contents.length, 3)
  assert.deepEqual(request.contents.map(entry => entry.role), ['user', 'model', 'user'])

  // Stored thought signatures are re-attached so the backend keeps its chain.
  assert.deepEqual(request.contents[1].parts[0], {
    thought: true,
    text: 'I should look at it',
    thoughtSignature: 'sig-reason',
  })
  assert.deepEqual(request.contents[1].parts[1], { text: 'Reading now.' })
  assert.deepEqual(request.contents[1].parts[2].functionCall, {
    name: 'read_file',
    args: { path: 'a.txt' },
    id: 'call-1',
  })
  assert.equal(request.contents[1].parts[2].thoughtSignature, 'sig-call')

  // The tool result echoes the tool name and its id, both required for Claude.
  assert.deepEqual(request.contents[2].parts[0].functionResponse, {
    name: 'read_file',
    response: { output: 'contents' },
    id: 'call-1',
  })

  assert.equal(request.systemInstruction.parts[0].text.length > 0, true)
  assert.equal(request.systemInstruction.parts.at(-1).text, 'extra system text')

  // An oversized request cap is clamped to the model's own ceiling.
  assert.equal(request.generationConfig.maxOutputTokens, 128000)
  assert.equal(request.generationConfig.temperature, 0.4)

  // Claude gets the reduced dialect plus VALIDATED tool calling.
  assert.ok(request.tools[0].functionDeclarations[0].parameters !== undefined)
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: 'VALIDATED' } })
})

test('serialize: a Gemini request uses parametersJsonSchema and no toolConfig', async () => {
  const body = await buildRequest({
    options: {
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
      reasoningEffort: 'high',
      tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
    },
    modelId: 'gemini-3.8-flash-tiered',
    maxOutputTokens: 65536,
    projectId: 'p',
    resolveAttachment: async () => undefined,
  })

  assert.ok(body.request.tools[0].functionDeclarations[0].parametersJsonSchema !== undefined)
  assert.equal(body.request.toolConfig, undefined)
  // The tiered route exposes the thinking-level knob.
  assert.deepEqual(body.request.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' })
  assert.equal(body.request.generationConfig.maxOutputTokens, 65536)
})

test('serialize: a reasoning block without a stored signature degrades to text', async () => {
  const body = await buildRequest({
    options: {
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      messages: [{
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'thought' }],
        source: { kind: 'model', provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
      }],
    },
    modelId: 'gemini-3.8-flash-tiered',
    maxOutputTokens: 65536,
    projectId: 'p',
    resolveAttachment: async () => undefined,
  })
  assert.deepEqual(body.request.contents[0].parts, [{ text: 'thought' }])
})

test('credentials: write, read, mode, and serialized modify', async () => {
  const dir = await scratch()
  const path = join(dir, 'creds.json')
  const store = new CredentialStore(path)

  assert.equal(await store.read(), undefined)

  await store.write({ refresh: 'r1', access: 'a1', expires: Date.now() + 3_600_000, email: 'me@example.com' })
  const stored = await store.read()
  assert.equal(stored.refresh, 'r1')
  assert.equal(stored.email, 'me@example.com')

  const mode = (await stat(path)).mode & 0o777
  assert.equal(mode, 0o600, 'a credential file must not be group- or world-readable')

  // A document without a refresh token is not a usable credential.
  await store.write({ access: 'a1' })
  assert.equal(await store.read(), undefined)
  await store.write({ refresh: 'r1', access: 'a1', expires: Date.now() + 3_600_000 })

  // Concurrent modifies must observe each other's writes, not race.
  let observed = 0
  await Promise.all(Array.from({ length: 8 }, () => store.modify(async (current) => {
    assert.ok(current !== undefined)
    observed += 1
    return { next: { ...current, seen: (current.seen ?? 0) + 1 }, result: undefined }
  })))
  assert.equal(observed, 8)
  assert.equal((await store.read()).seen, 8)

  // A throwing body must not wedge the chain for later callers.
  await assert.rejects(store.modify(async () => { throw new Error('boom') }), /boom/)
  assert.equal(await store.modify(async () => ({ result: 'still works' })), 'still works')

  await store.delete()
  assert.equal(await store.read(), undefined)
  await store.delete()
})

test('credentials: redaction removes every credential shape', () => {
  const text = 'Authorization: Bearer ya29.abcdefghijklmnop refresh_token=1//0gABCDEFGHIJKLMNOPQRSTUV "client_secret":"GOCSPX-secret"'
  const redacted = redactSecrets(text)
  assert.ok(!redacted.includes('ya29.'))
  assert.ok(!redacted.includes('1//0gABCDEFGHIJKLMNOPQRSTUV'))
  assert.ok(!redacted.includes('GOCSPX-secret'))
  assert.ok(redacted.includes('<redacted>'))
})

test('preferences: an absent document is not the same as an empty selection', async () => {
  const dir = await scratch()
  const store = new PreferenceStore(join(dir, 'prefs.json'))

  // Absent means the user has expressed no preference, which the caller reads
  // as "offer everything". It must not look like a deliberate empty list.
  const absent = await store.read()
  assert.deepEqual(absent.enabledModelIds, [])
  assert.equal(absent.explicit, false)

  // An explicit empty list is "none", and stays distinct from the above.
  assert.deepEqual((await store.write([])).enabledModelIds, [])
  const empty = await store.read()
  assert.deepEqual(empty.enabledModelIds, [])
  assert.equal(empty.explicit, true)

  // Ids are stored as given: the store is deliberately blind to which models
  // currently exist, so a backend rename cannot silently drop a selection.
  const written = await store.write(['gemini-3.8-flash-tiered', 'gemini-3.8-flash-tiered', '', 'claude-opus-5-5-high'])
  assert.deepEqual(written.enabledModelIds, ['gemini-3.8-flash-tiered', 'claude-opus-5-5-high'])
  const stored = await store.read()
  assert.equal(stored.explicit, true)
  assert.deepEqual(stored.enabledModelIds, ['gemini-3.8-flash-tiered', 'claude-opus-5-5-high'])

  // A corrupt document reads as "no preference", never as a crash.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(store.path, '{not json')
  assert.equal((await store.read()).explicit, false)

  // The document is written as readable JSON.
  await store.write(['gemini-3.1-pro-high'])
  assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), { enabledModelIds: ['gemini-3.1-pro-high'] })
})

test('oauth: PKCE pairs are unique and the auth URL carries every required parameter', () => {
  const first = generatePKCE()
  const second = generatePKCE()
  assert.notEqual(first.verifier, second.verifier)
  assert.notEqual(first.challenge, second.challenge)
  // base64url of 32 bytes, unpadded.
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.match(first.challenge, /^[A-Za-z0-9_-]{43}$/)

  const redirect = redirectUri(51121)
  assert.equal(redirect, 'http://localhost:51121/oauth-callback')

  const url = new URL(buildAuthUrl({ redirect, state: 'state-1', challenge: first.challenge }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('redirect_uri'), redirect)
  assert.equal(url.searchParams.get('state'), 'state-1')
  assert.equal(url.searchParams.get('code_challenge'), first.challenge)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  // Without offline + consent Google may omit the refresh token.
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '))
  assert.ok(url.searchParams.get('client_id').endsWith('.apps.googleusercontent.com'))
})
