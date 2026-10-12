/**
 * The harness-facing adapter: turns Cloud Code Assist server-sent events into
 * the harness stream vocabulary, and harness requests into Cloud Code Assist
 * request envelopes.
 *
 * The adapter owns no network state beyond the client it is handed, so a
 * settings change reaches the next request without a restart.
 *
 * @module dsh-antigravity-connect/adapter
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  ToolCallId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { PROVIDER, PROVIDER_NAME } from './constants.js'
import { POOL_THIRD_PARTY, REASONING_EFFORTS, fallbackModels, modelsFromDirectory } from './catalog.js'
import { maxOutputTokensFor, buildRequest } from './serialize.js'
import { STREAM_IDLE_TIMEOUT_CODE, CloudCodeError, unwrapPayload } from './cloudcode.js'
import { redactSecrets } from './credentials.js'

/** Context capacity assumed for a model the catalog does not describe. */
const FALLBACK_CONTEXT_WINDOW = 200_000

/**
 * Human-readable quota-pool label for a catalog entry.
 * @param {string | undefined} pool - `'gemini'`, `'third-party'`, or unknown.
 * @returns {string} the label.
 */
function poolLabel(pool) {
  if (pool === 'third-party') return 'Claude & GPT (3P) quota pool'
  return 'Gemini quota pool'
}

/**
 * Compose one model's user-facing description.
 * @param {object} entry - a catalog entry.
 * @returns {string} the description.
 */
function describe(entry) {
  const pool = poolLabel(entry.pool)
  return entry.description === undefined ? pool : `${entry.description} · ${pool}`
}

/**
 * Translate a provider-side failure into the harness error vocabulary.
 *
 * Aborts pass through untouched so `LlmRuntime` can report them as `aborted`
 * rather than as a provider fault.
 *
 * @param {unknown} error - whatever the transport threw.
 * @param {AbortSignal | undefined} signal - the request's cancellation signal.
 * @returns {Error} the error to throw.
 */
function translate(error, signal) {
  if (signal?.aborted === true) return /** @type {Error} */ (error)
  if (error instanceof LlmError) return error
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return /** @type {Error} */ (error)

  const code = typeof error?.code === 'string' ? error.code : 'ANTIGRAVITY_ERROR'
  const status = typeof error?.status === 'number' ? error.status : undefined
  const detail = redactSecrets(error?.message ?? String(error))
  /** @type {Record<string, unknown>} */
  const options = {}
  if (status !== undefined && status >= 100 && status <= 599) options.status = status
  if (error !== undefined && error !== null) options.cause = error
  // A provider-stated delay is what lets the retry policy wait exactly as long
  // as the server asked instead of guessing.
  const retryAfterMs = typeof error?.retryAfterMs === 'number' ? error.retryAfterMs : undefined
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    options.providerRetryAfterMs = retryAfterMs
  }

  switch (code) {
    case 'MISSING_CREDENTIAL':
    case 'AUTH_REFRESH_REJECTED':
    case 'AUTH_REJECTED':
    case 'AUTH':
      return new LlmError(
        code === 'MISSING_CREDENTIAL'
          ? 'antigravity-connect: not signed in to Antigravity; open Settings > Antigravity and sign in, then retry'
          : `${detail} — the Antigravity sign-in has expired; open Settings > Antigravity and sign in again`,
        'AUTH',
        options,
      )
    case STREAM_IDLE_TIMEOUT_CODE:
      return new LlmError(detail, STREAM_IDLE_TIMEOUT_CODE, options)
    case 'QUOTA':
      return new LlmError(detail, QUOTA_EXCEEDED_CODE, options)
    case 'CONTEXT_WINDOW_EXCEEDED':
      return new LlmError(detail, CONTEXT_WINDOW_EXCEEDED_CODE, options)
    case 'RATE_LIMIT':
      return new LlmError(detail, 'RATE_LIMIT', options)
    case 'TRANSPORT':
      return new LlmError(`${detail}; retry the request`, 'TRANSPORT', options)
    case 'PROTOCOL':
      return new LlmError(detail, 'PROTOCOL', options)
    default:
      return new LlmError(detail, code, options)
  }
}

/** Cloud Code Assist adapter registered on the `antigravity` provider route. */
export class AntigravityAdapter extends LlmAdapter {
  #client
  #resolveAttachment
  #enabledModelIds
  #systemInstruction
  #logger

  /**
   * @param {object} options - the Cloud Code Assist client, current enabled-model accessor,
   *   attachment resolver, system-instruction accessor, and logger.
   */
  constructor({ client, enabledModelIds, resolveAttachment, systemInstruction, logger }) {
    super()
    this.#client = client
    this.#enabledModelIds = enabledModelIds
    this.#resolveAttachment = resolveAttachment
    this.#systemInstruction = systemInstruction
    this.#logger = logger
  }

  /**
   * @param {string} provider - the registered route.
   * @returns {{ id: string, name: string }} display metadata for the route.
   */
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME }
  }

  /**
   * 路由重试策略配置。
   *
   * 契约规范说明：
   * DeepSeek Harness 的重试执行模块 (dsh-llm-retry) 期望接收展开在顶层的退避参数
   * (initialDelayMs, maxDelayMs, jitterRatio)，而不是仅仅包含嵌套的 backoff 对象。
   * 若缺少顶层字段，dsh-llm-retry 会计算出 delayMs = NaN，进而导致 session event "llm/retry"
   * 的无损 JSON 校验失败并抛出异常。此处通过 resolveRetryPolicy 进行标准化解析。
   *
   * @param {string} _provider - 注册的服务提供商路由标识。
   * @returns {import('@deepseek-ai/dsh-llm').ResolvedRetryPolicy} 符合规范的解析后重试策略。
   */
  providerRetryPolicy(_provider) {
    const rawPolicy = {
      mode: 'normal',
      maxRetries: 5,
      // 保持针对空响应、服务端故障、超时和传输错误的重试行为；
      // 故意排除 RATE_LIMIT，避免在候选节点均限流后做无效重试。
      retryableCodes: [EMPTY_RESPONSE_CODE, 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
    }
    if (typeof resolveRetryPolicy === 'function') {
      return resolveRetryPolicy(rawPolicy, 'antigravity')
    }
    return Object.freeze({
      mode: rawPolicy.mode,
      maxRetries: rawPolicy.maxRetries,
      retryableCodes: Object.freeze([...rawPolicy.retryableCodes]),
      initialDelayMs: rawPolicy.backoff.initialDelayMs,
      maxDelayMs: rawPolicy.backoff.maxDelayMs,
      jitterRatio: rawPolicy.backoff.jitterRatio,
    })
  }

  /**
   * The models this account offers, narrowed to the user's selection.
   *
   * The list comes from the backend's own directory, so a model the account
   * gains appears without a plugin update. {@link fallbackModels} covers the
   * signed-out and directory-unreachable cases, so the picker is never empty —
   * and once a real directory arrives it replaces the fallback entirely rather
   * than merging, because a merge would keep offering models the account does
   * not have.
   *
   * @param {string} provider - the registered route.
   * @returns {Promise<readonly object[]>} the advertised models.
   */
  async listModels(provider) {
    const selection = this.#enabledModelIds()
    // `undefined` is "no preference expressed", which offers everything the
    // directory reports. An empty array is a deliberate "none" and must stay
    // empty, so the two cannot be collapsed into one check.
    const enabled = selection === undefined || selection === null ? undefined : new Set(selection)
    const models = await this.#currentModels()
    return models
      .filter(entry => enabled === undefined || enabled.has(entry.id))
      .map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        description: describe(entry),
        inputModalities: entry.supportsImages === true ? ['text', 'image'] : ['text'],
      }))
  }

  /**
   * The current model list: the live directory when it is reachable, otherwise
   * the offline fallback.
   * @returns {Promise<object[]>} normalized models.
   */
  async #currentModels() {
    const directory = await this.#client.modelDirectory()
    return directory === undefined ? fallbackModels() : modelsFromDirectory(directory)
  }

  /**
   * The output ceiling the directory reports for one model.
   *
   * Read here rather than re-derived from a table, because the backend raises
   * this figure as models gain capacity and a stale number would either
   * truncate replies or trip a 400.
   *
   * @param {string} modelId - the model id.
   * @returns {Promise<number | undefined>} the cap, or `undefined` to let the fallback decide.
   */
  async #outputCapFor(modelId) {
    const models = await this.#currentModels()
    return models.find(candidate => candidate.id === modelId)?.maxOutputTokens
  }

  /**
   * Full metadata for one exact model, including its context capacity and
   * selectable reasoning levels.
   *
   * No `defaultEffort` is declared: the backend picks its own default per
   * model, so restating one here would override the provider with a guess.
   *
   * @param {string} provider - the registered route.
   * @param {string} model - the model id, which is the runtime id.
   * @returns {Promise<object>} the resolved metadata.
   */
  async resolveModel(provider, model) {
    const models = await this.#currentModels()
    const entry = models.find(candidate => candidate.id === model)
    const contextWindow = entry?.contextWindow ?? FALLBACK_CONTEXT_WINDOW
    const inputModalities = entry === undefined
      ? ['text', 'image']
      : entry.supportsImages === true ? ['text', 'image'] : ['text']
    // Only a model the directory marks as thinking gets a reasoning selector;
    // offering levels for a model that ignores them is a control that does
    // nothing.
    const efforts = entry?.supportsThinking === true ? REASONING_EFFORTS : []
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      description: entry === undefined ? poolLabel(undefined) : describe(entry),
      inputModalities,
      context: { contextWindow },
      defaultMaxTokens: entry?.maxOutputTokens ?? maxOutputTokensFor(model),
      ...efforts.length === 0
        ? {}
        : {
          reasoning: {
            efforts: efforts.map(effort => ({
              id: ReasoningEffortId(effort),
              name: effort === 'off' ? 'Off' : effort.charAt(0).toUpperCase() + effort.slice(1),
            })),
          },
        },
    }
  }

  /**
   * Stream one model call.
   *
   * @param {object} options - the assembled harness request.
   * @returns {AsyncGenerator<object>} harness stream chunks.
   */
  async *stream(options) {
    const modelId = String(options.model)
    const signal = options.signal

    let projectId
    try {
      projectId = await this.#client.project(signal)
    } catch (error) {
      throw translate(error, signal)
    }

    let body
    try {
      body = await buildRequest({
        options,
        modelId,
        projectId,
        maxOutputTokens: await this.#outputCapFor(modelId),
        resolveAttachment: this.#resolveAttachment,
      })
    } catch (error) {
      throw translate(error, signal)
    }

    /** @type {{ type: string, thoughtSignature?: string }[]} */
    const blocks = []
    /** @type {{ index: number, type: string, block: any } | undefined} */
    let open
    let usage
    let finishReason

    try {
      for await (const payload of this.#client.streamGenerate(body, signal)) {
        const chunk = unwrapPayload(payload)

        const metadata = chunk.usageMetadata
        if (metadata !== null && typeof metadata === 'object') usage = metadata

        const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined
        if (candidate === undefined || candidate === null) continue
        if (typeof candidate.finishReason === 'string') finishReason = candidate.finishReason

        const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : []
        for (const part of parts) {
          if (part === null || typeof part !== 'object') continue

          if (part.functionCall !== undefined && part.functionCall !== null) {
            // A tool call is atomic: it arrives whole, so the block opens and
            // closes around a single delta that already holds the full payload.
            if (open !== undefined) {
              yield { type: 'block-end', index: open.index, block: open.block }
              open = undefined
            }
            const index = blocks.length
            const name = String(part.functionCall.name ?? 'tool')
            const rawId = part.functionCall.id
            const id = ToolCallId(typeof rawId === 'string' && rawId.length > 0 ? rawId : `antigravity_${index}_${Date.now()}`)
            const args = JSON.stringify(part.functionCall.args ?? {})
            blocks.push({
              type: 'tool-call',
              ...typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {},
            })
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
            yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
            continue
          }

          const kind = part.thought === true ? 'reasoning' : typeof part.text === 'string' ? 'text' : undefined
          if (kind === undefined) continue
          const text = part.text
          if (text.length === 0) continue

          if (open === undefined || open.type !== kind) {
            if (open !== undefined) {
              yield { type: 'block-end', index: open.index, block: open.block }
              open = undefined
            }
            const index = blocks.length
            blocks.push({
              type: kind,
              ...typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {},
            })
            open = { index, type: kind, block: kind === 'reasoning' ? { type: 'reasoning', text: '' } : { type: 'text', text: '' } }
            yield { type: 'block-start', index, blockType: kind }
          } else if (typeof part.thoughtSignature === 'string' && blocks[open.index].thoughtSignature === undefined) {
            // The signature can trail the first delta; keep the latest one seen.
            blocks[open.index].thoughtSignature = part.thoughtSignature
          }

          open.block.text += text
          yield kind === 'reasoning'
            ? { type: 'reasoning-delta', index: open.index, text }
            : { type: 'text-delta', index: open.index, text }
        }
      }
    } catch (error) {
      throw translate(error, signal)
    }

    if (open !== undefined) {
      yield { type: 'block-end', index: open.index, block: open.block }
    }

    if (blocks.length === 0) {
      throw new LlmError(
        'antigravity-connect: the backend ended the stream without producing any content;'
        + ' retry the request, or switch to another Antigravity model',
        EMPTY_RESPONSE_CODE,
      )
    }

    if (usage !== undefined) {
      const prompt = Number(usage.promptTokenCount ?? 0)
      const cached = Number(usage.cachedContentTokenCount ?? 0)
      const answer = Number(usage.candidatesTokenCount ?? 0)
      const thoughts = Number(usage.thoughtsTokenCount ?? 0)
      // Harness token counts are disjoint: uncached input is reported apart
      // from the cache reads, and thoughts are output the user never sees.
      yield {
        type: 'usage',
        usage: {
          inputTokens: Math.max(0, prompt - cached),
          outputTokens: answer + thoughts,
          ...cached > 0 ? { cacheReadTokens: cached } : {},
          ...thoughts > 0 ? { reasoningTokens: thoughts } : {},
        },
      }
    }

    const sawToolCall = blocks.some(block => block.type === 'tool-call')
    yield {
      type: 'finish',
      reason: {
        kind: finishReason === 'MAX_TOKENS' ? 'max-tokens' : sawToolCall ? 'tool-calls' : 'stop',
      },
      replayState: {
        response: {
          provider: PROVIDER,
          model: modelId,
          finishReason: finishReason ?? 'STOP',
        },
        // Positionally aligned with the emitted blocks: assembly drops the
        // entry at the same index when it drops a block.
        blocks,
      },
    }
  }
}
