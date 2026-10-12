/**
 * Translation between the harness's provider-neutral request vocabulary and
 * the Cloud Code Assist wire format.
 *
 * This is the only module that knows how a `Message` becomes a `contents[]`
 * entry, how tool schemas are spelled for Gemini versus Claude/GPT, and how a
 * reasoning effort becomes a `thinkingConfig`. Keeping it separate from the
 * transport means the request body can be inspected and tested without a
 * network call.
 *
 * @module dsh-antigravity-connect/serialize
 */

import { randomBytes } from 'node:crypto'
import {
  DEFAULT_SYSTEM_INSTRUCTION,
  GEMINI_ROLE,
  NO_PREAMBLE_INSTRUCTION,
  PROVIDER,
} from './constants.js'

/**
 * Replace unpaired surrogates, which `JSON.stringify` would otherwise emit as
 * escape sequences the backend rejects.
 * @param {unknown} text - any value.
 * @returns {string} a string safe to place in a JSON body.
 */
export function sanitizeText(text) {
  return String(text ?? '').replace(/[\uD800-\uDFFF]/g, '\uFFFD')
}

/**
 * Mint the per-call request id the backend logs against.
 * @returns {string} a unique opaque id.
 */
export function nowRequestId() {
  return `antigravity-${Date.now()}-${randomBytes(6).toString('hex')}`
}

/**
 * Parse a tool-call argument payload, tolerating an already-parsed object.
 * @param {unknown} raw - the raw JSON string or object.
 * @returns {Record<string, unknown>} the arguments, or `{}` when unparseable.
 */
export function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

let toolCallCounter = 0

/**
 * Make a tool-call id acceptable to the backends that validate it.
 * @param {string} id - the harness-issued call id.
 * @param {string} [fallbackName] - tool name used when `id` sanitizes to nothing.
 * @returns {string} a 1..64 character id of `[A-Za-z0-9_-]`.
 */
export function sanitizeToolCallId(id, fallbackName) {
  const cleaned = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return cleaned.length > 0 ? cleaned : `${fallbackName ?? 'tool'}_${Date.now()}_${++toolCallCounter}`
}

/**
 * Whether this model requires an explicit id on every
 * `functionCall`/`functionResponse`.
 *
 * The Anthropic and OpenAI routes correlate tool results by an explicit id;
 * the Gemini routes match a result to its call by position and name.
 *
 * @param {string} modelId - runtime model id.
 * @returns {boolean} true for the Claude and GPT-OSS routes.
 */
export function toolCallIdNeeded(modelId) {
  return modelId.startsWith('claude-') || modelId.startsWith('gpt-oss-')
}

/** JSON-Schema keywords the backend's legacy `parameters` field tolerates. */
const LEGACY_SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum'])

/**
 * Remove the meta keywords the backend rejects in a JSON Schema.
 * @param {unknown} schema - any JSON Schema node.
 * @returns {unknown} the node without `$schema`, `$defs`, and friends.
 */
export function stripMetaSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const omit = new Set(['$schema', '$id', '$anchor', '$dynamicAnchor', '$vocabulary', '$comment', '$defs', 'definitions'])
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value)
  }
  return out
}

/**
 * Collapse a type union to its single non-null member, which is the only form
 * the legacy schema dialect accepts.
 * @param {unknown} value - a `type` field.
 * @returns {string | undefined} the surviving type name.
 */
function normalizeLegacyType(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  return value.find(entry => typeof entry === 'string' && entry !== 'null')
}

/**
 * Reduce a JSON Schema to the legacy dialect Claude and GPT-OSS accept.
 * @param {unknown} schema - any JSON Schema node.
 * @returns {unknown} the whitelisted schema.
 */
export function normalizeLegacySchema(schema) {
  if (schema === null || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(normalizeLegacySchema)
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!LEGACY_SCHEMA_KEYS.has(key)) continue
    if (key === 'type') {
      const normalized = normalizeLegacyType(value)
      if (normalized !== undefined) out.type = normalized
      continue
    }
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const properties = {}
      for (const [name, propertySchema] of Object.entries(value)) {
        properties[name] = normalizeLegacySchema(propertySchema)
      }
      out.properties = properties
      continue
    }
    if (key === 'enum' && Array.isArray(value) && !value.every(entry => typeof entry === 'string')) {
      // A non-string enumeration cannot be represented in this dialect, and
      // forwarding it is a hard 400; dropping the constraint is recoverable.
      continue
    }
    out[key] = normalizeLegacySchema(value)
  }
  return out
}

/**
 * Convert the harness tool list into Cloud Code Assist declarations.
 * @param {readonly {name: string, description: string, parameters: object}[] | undefined} tools - harness tool schemas.
 * @param {boolean} legacy - whether to emit the reduced `parameters` dialect.
 * @returns {unknown[] | undefined} the `tools` array, or `undefined` when there are none.
 */
export function convertTools(tools, legacy) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return [{
    functionDeclarations: tools.map(tool => {
      const schema = stripMetaSchema(tool.parameters)
      return {
        name: tool.name,
        description: tool.description,
        ...legacy ? { parameters: normalizeLegacySchema(schema) } : { parametersJsonSchema: schema },
      }
    }),
  }]
}

/**
 * The adapter-private per-block metadata this plugin stores for replay, at the
 * position of the block it belongs to.
 * @param {import('@deepseek-ai/dsh-llm').Message} message - one assistant message.
 * @param {string} model - the public model id recorded on the message.
 * @param {number} index - position of the block within `message.content`.
 * @returns {Record<string, unknown> | undefined} the stored entry, when this plugin produced the message.
 */
function replayBlockFor(message, model, index) {
  const source = message.source
  if (source === undefined || source.kind !== 'model') return undefined
  const state = source.replayState
  if (state === null || typeof state !== 'object') return undefined
  const response = state.response
  if (response === null || typeof response !== 'object') return undefined
  if (response.provider !== PROVIDER || response.model !== model) return undefined
  if (!Array.isArray(state.blocks)) return undefined
  const entry = state.blocks[index]
  return entry !== null && typeof entry === 'object' ? entry : undefined
}

/**
 * Convert one image block into an `inlineData` part.
 * @param {import('@deepseek-ai/dsh-llm').ImageBlock} block - the image block.
 * @param {(ref: unknown) => Promise<{data: string, mimeType: string} | undefined>} resolve - attachment resolver.
 * @returns {Promise<object | undefined>} the part, when the bytes could be read.
 */
async function imagePart(block, resolve) {
  const resolved = await resolve(block.attachment)
  if (resolved === undefined || resolved.data.length === 0) return undefined
  return { inlineData: { mimeType: resolved.mimeType || 'image/png', data: resolved.data } }
}

/**
 * Build the `parts[]` for one user-role message.
 * @param {readonly object[]} content - non-tool-result blocks.
 * @param {(ref: unknown) => Promise<{data: string, mimeType: string} | undefined>} resolve - attachment resolver.
 * @returns {Promise<object[]>} the parts.
 */
async function userParts(content, resolve) {
  const parts = []
  for (const block of content) {
    if (block?.type === 'text') {
      parts.push({ text: sanitizeText(block.text) })
    } else if (block?.type === 'image') {
      const part = await imagePart(block, resolve)
      if (part !== undefined) parts.push(part)
    }
  }
  return parts
}

/**
 * Build the `parts[]` for one assistant-role message, re-attaching any stored
 * thought signature so the backend can continue its own reasoning chain.
 * @param {import('@deepseek-ai/dsh-llm').Message} message - the assistant message.
 * @param {object} context - model id, tool-name map, and attachment resolver.
 * @returns {Promise<object[]>} the parts.
 */
async function assistantParts(message, context) {
  const { model, toolNames } = context
  const parts = []
  if (!Array.isArray(message.content)) return parts
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index]
    if (block === null || typeof block !== 'object') continue
    const replay = replayBlockFor(message, model, index)
    if (block.type === 'text' && String(block.text ?? '').trim().length > 0) {
      parts.push({ text: sanitizeText(block.text) })
    } else if (block.type === 'reasoning' && String(block.text ?? '').trim().length > 0) {
      // Without the signature the backend will not accept this as a thought
      // part, so it degrades to plain text rather than failing the request.
      // That loses the reasoning trace, not the conversation.
      if (replay?.type === 'reasoning' && typeof replay.thoughtSignature === 'string') {
        parts.push({ thought: true, text: sanitizeText(block.text), thoughtSignature: replay.thoughtSignature })
      } else {
        parts.push({ text: sanitizeText(block.text) })
      }
    } else if (block.type === 'tool-call') {
      const id = String(block.id ?? '')
      toolNames.set(id, block.name)
      parts.push({
        functionCall: {
          name: block.name,
          args: parseArguments(block.arguments),
          ...toolCallIdNeeded(model) ? { id: sanitizeToolCallId(id, block.name) } : {},
        },
        ...replay?.type === 'tool-call' && typeof replay.thoughtSignature === 'string'
          ? { thoughtSignature: replay.thoughtSignature }
          : {},
      })
    }
  }
  return parts
}

/**
 * Flatten a tool result's content blocks to the text the model sees.
 * @param {readonly object[]} content - the result's blocks.
 * @returns {string} concatenated text.
 */
function toolResultText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (block === null || typeof block !== 'object') return ''
    if (block.type === 'text') return sanitizeText(block.text)
    if (block.type === 'tool-result') return toolResultText(block.content)
    return ''
  }).join('')
}

/**
 * Append one tool result, merging into the preceding user turn when that turn
 * already carries results. The backend groups parallel results into one turn.
 * @param {object[]} contents - the accumulating `contents[]`.
 * @param {object} result - the `tool-result` block.
 * @param {Map<string, string>} toolNames - call-id to tool-name map.
 * @param {object} context - the model id, for the tool-id dialect.
 * @returns {void}
 */
function pushToolResult(contents, result, toolNames, context) {
  const callId = String(result.toolCallId ?? '')
  const toolName = toolNames.get(callId) ?? 'unknown'
  const text = toolResultText(result.content) || (result.isError === true ? 'Tool failed' : '')
  const part = {
    functionResponse: {
      name: toolName,
      response: result.isError === true ? { error: text } : { output: text },
      ...toolCallIdNeeded(context.model)
        ? { id: sanitizeToolCallId(callId, toolName) }
        : {},
    },
  }
  const last = contents[contents.length - 1]
  if (last?.role === GEMINI_ROLE.user && last.parts.some(entry => 'functionResponse' in entry)) {
    last.parts.push(part)
  } else {
    contents.push({ role: GEMINI_ROLE.user, parts: [part] })
  }
}

/**
 * Convert the assembled conversation into `contents[]`.
 * @param {object} options - the harness request.
 * @param {object} context - model id and attachment resolver.
 * @returns {Promise<object[]>} the wire conversation.
 */
export async function convertMessages(options, context) {
  const contents = []
  const toolNames = new Map()
  const scoped = { ...context, toolNames }
  for (const message of options.messages ?? []) {
    if (message.role === 'assistant') {
      const parts = await assistantParts(message, scoped)
      if (parts.length > 0) contents.push({ role: GEMINI_ROLE.model, parts })
      continue
    }
    const content = Array.isArray(message.content) ? message.content : []
    const nonResults = content.filter(block => block?.type !== 'tool-result')
    const parts = await userParts(nonResults, context.resolveAttachment)
    if (message.role === 'system') {
      // A system-role message in the middle of history is injected context;
      // the backend has no system role in `contents`, so it rides as user text.
      if (parts.length > 0) contents.push({ role: GEMINI_ROLE.user, parts })
      continue
    }
    if (parts.length > 0) contents.push({ role: GEMINI_ROLE.user, parts })
    for (const block of content) {
      if (block?.type === 'tool-result') pushToolResult(contents, block, toolNames, context)
    }
  }
  return contents
}

/**
 * Resolve the output ceiling for a model the directory did not size.
 *
 * Only a fallback: the directory reports `maxOutputTokens` for essentially
 * every model, and that reported value is what the adapter prefers.
 *
 * @param {string} modelId - runtime model id.
 * @returns {number} the maximum `maxOutputTokens` the backend accepts.
 */
export function maxOutputTokensFor(modelId) {
  if (modelId.startsWith('claude-')) return 128_000
  if (modelId.startsWith('gpt-oss-')) return 32_768
  if (modelId.startsWith('gemini-3.1-pro') || modelId === 'gemini-pro-agent') return 65_535
  return 65_536
}

/**
 * Build the `generationConfig` for one call.
 * @param {object} input - request options, the model id, and the selected effort.
 * @returns {Record<string, unknown> | undefined} the config, or `undefined` when empty.
 */
export function buildGenerationConfig({ options, modelId, maxOutputTokens, effort }) {
  const config = {}
  if (options.temperature !== undefined) config.temperature = options.temperature
  const cap = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0
    ? maxOutputTokens
    : maxOutputTokensFor(modelId)
  config.maxOutputTokens = options.maxTokens !== undefined
    ? Math.min(options.maxTokens, cap)
    : cap

  // The `-tiered` routes are the generic ones whose thinking depth is chosen
  // here rather than pinned by the id; every other route picks its own depth
  // from the prompt and ignores this knob.
  if (modelId.endsWith('-tiered')) {
    const selected = typeof effort === 'string' ? effort : 'off'
    config.thinkingConfig = {
      thinkingLevel: selected === 'high'
        ? 'HIGH'
        : selected === 'medium' ? 'MEDIUM' : 'LOW',
    }
  }

  if (Array.isArray(options.stop) && options.stop.length > 0) {
    config.stopSequences = options.stop.slice(0, 5).map(sanitizeText)
  }
  return Object.keys(config).length > 0 ? config : undefined
}

/**
 * Assemble the complete Cloud Code Assist request envelope.
 * @param {object} input - request options, the model id, project, output cap, and attachments resolver.
 * @returns {Promise<Record<string, unknown>>} the JSON body to POST.
 */
export async function buildRequest({ options, modelId, projectId, maxOutputTokens, resolveAttachment }) {
  const context = { model: modelId, resolveAttachment }
  const request = {
    contents: await convertMessages(options, context),
    systemInstruction: {
      role: GEMINI_ROLE.user,
      parts: [
        { text: DEFAULT_SYSTEM_INSTRUCTION },
        { text: NO_PREAMBLE_INSTRUCTION },
        ...options.system ? [{ text: sanitizeText(options.system) }] : [],
      ],
    },
  }
  const generationConfig = buildGenerationConfig({
    options,
    modelId,
    maxOutputTokens,
    effort: options.reasoningEffort,
  })
  if (generationConfig !== undefined) request.generationConfig = generationConfig

  // Claude and GPT-OSS take a reduced schema dialect, and Claude additionally
  // validates every declared tool against the model's own call, so the default
  // has to be VALIDATED rather than AUTO.
  const legacySchemas = toolCallIdNeeded(modelId)
  const tools = convertTools(options.tools, legacySchemas)
  if (tools !== undefined) {
    request.tools = tools
    if (modelId.startsWith('claude-')) {
      request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } }
    }
  }
  if (options.sessionId !== undefined) request.sessionId = String(options.sessionId)

  return {
    project: projectId,
    model: modelId,
    request,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: nowRequestId(),
  }
}
