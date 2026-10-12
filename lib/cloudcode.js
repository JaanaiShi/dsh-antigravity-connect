/**
 * Cloud Code Assist transport: project discovery, the live model catalog, the
 * quota summary, and the streaming generation call.
 *
 * Every method here is one logical operation against the backend. Host
 * failover, token refresh, and SSE framing live in this module so the adapter
 * above it deals only in harness vocabulary.
 *
 * @module dsh-antigravity-connect/cloudcode
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_ENDPOINT,
  DISCOVERY_TIMEOUT_MS,
  ENDPOINT_FALLBACKS,
  MODEL_CACHE_TTL_MS,
  PROJECT_CACHE_TTL_MS,
  RETRYABLE_STATUS,
  antigravityUserAgent,
  clientMetadata,
  isHostFailoverStatus,
} from './constants.js'
import { ensureAccessToken } from './oauth.js'
import { redactSecrets } from './credentials.js'

/** Stable code carried by the idle-timeout abort, so the adapter can name it. */
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * A failure at the Cloud Code Assist boundary, carrying the facts the adapter
 * needs to pick a harness error code.
 */
export class CloudCodeError extends Error {
  /**
   * @param {string} message - human-readable summary, already redacted.
   * @param {object} options - stable code, HTTP status, failing host, and a provider-requested delay.
   */
  constructor(message, { code, status, host, retryAfterMs } = {}) {
    super(message)
    this.name = 'CloudCodeError'
    this.code = code ?? 'ANTIGRAVITY_ERROR'
    if (status !== undefined) this.status = status
    if (host !== undefined) this.host = host
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

/**
 * Read a `Retry-After` header as milliseconds.
 *
 * Honoring the server's own figure matters more than it looks: a fixed
 * exponential backoff can retry well before the window reopens (wasting an
 * attempt) or long after it already did (making the user wait for nothing).
 *
 * @param {Response} response - the throttled response.
 * @returns {number | undefined} the delay in milliseconds, when stated and usable.
 */
function retryAfterMs(response) {
  const raw = response.headers.get('retry-after')
  if (raw === null || raw.length === 0) return undefined
  // The header is either delta-seconds or an HTTP date.
  const seconds = Number(raw)
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(raw) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 5 * 60 * 1000) : undefined
}

/**
 * Read an error body and reduce it to one redacted line.
 * @param {Response} response - the failed response.
 * @returns {Promise<string>} the backend's message, or a generic summary.
 */
async function errorDetail(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {
    return `HTTP ${response.status}`
  }
  if (text.length === 0) return `HTTP ${response.status}`
  try {
    const parsed = JSON.parse(text)
    const detail = parsed?.error?.message ?? parsed?.message ?? parsed?.error
    if (typeof detail === 'string' && detail.length > 0) return redactSecrets(detail).slice(0, 500)
  } catch {
    // A non-JSON error body is still worth showing, bounded.
  }
  return redactSecrets(text).slice(0, 500)
}

/**
 * Whether a 429 body describes a spent allowance rather than a rate limit.
 *
 * This distinction has to be drawn on real phrasing, not on the word "quota".
 * Google's generic throttle body is `Resource has been exhausted (e.g. check
 * quota)` — it contains "quota" while meaning "you are going too fast", so a
 * naive substring test reports every rate limit as an exhausted allowance and
 * sends the user looking for a quota problem that does not exist.
 *
 * A genuine exhaustion names the allowance with a verb, in either order:
 * "you have exhausted your quota", "quota exceeded", "insufficient quota",
 * "out of quota". A throttle never phrases it that way, and never uses
 * "quota" as the subject of a verb.
 *
 * @param {string} detail - the redacted backend message.
 * @returns {boolean} true when the allowance itself is spent.
 */
function isQuotaExhausted(detail) {
  const VERB = '(?:exhausted|exceeded|depleted|insufficient|unavailable|reached|hit)'
  return new RegExp(`(?:your|the|insufficient|out of|over)\\s+quota`, 'i').test(detail)
    || new RegExp(`quota\\s+(?:has been\\s+|is\\s+|was\\s+)?${VERB}`, 'i').test(detail)
    || new RegExp(`${VERB}\\s+(?:your|the)\\s+quota`, 'i').test(detail)
    || /out of quota|over quota/i.test(detail)
}

/**
 * Classify a backend failure into a stable code.
 * @param {number} status - HTTP status.
 * @param {string} detail - redacted backend message.
 * @returns {string} the code.
 */
function classify(status, detail) {
  if (status === 401) return 'AUTH'
  if (status === 403) return 'AUTH'
  // A 429 is overwhelmingly a throttle; only explicit exhaustion phrasing makes
  // it a quota problem. Getting this backwards sends the user to check an
  // allowance that is actually fine.
  if (status === 429) return isQuotaExhausted(detail) ? 'QUOTA' : 'RATE_LIMIT'
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID|invalid_grant/i.test(detail)) return 'AUTH'
    if (/context|token count|too long/i.test(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return 'ANTIGRAVITY_ERROR'
}

/**
 * Pull the project id out of a `loadCodeAssist`-style payload, trying every
 * spelling the backend has used.
 * @param {unknown} data - the response body.
 * @returns {string | undefined} the project id.
 */
function extractProjectId(data) {
  if (data === null || typeof data !== 'object') return undefined
  for (const key of [
    'antigravityProjectId',
    'projectId',
    'backendProjectId',
    'userDefinedCloudaicompanionProject',
    'cloudaicompanionProject',
    'project',
  ]) {
    const value = data[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Clamp a remaining-fraction value into `[0, 1]`.
 * @param {unknown} value - the raw field.
 * @returns {number | undefined} the fraction, or `undefined` when unusable.
 */
function clampFraction(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.min(1, Math.max(0, number))
}

/**
 * Parse one `retrieveUserQuotaSummary` body.
 * @param {unknown} data - the response body.
 * @returns {{ groups: object[], description?: string }} the normalized groups.
 */
function parseQuotaGroups(data) {
  const summary = data !== null && typeof data === 'object' ? data : {}
  const groups = []
  for (const group of Array.isArray(summary.groups) ? summary.groups : []) {
    if (group === null || typeof group !== 'object') continue
    const buckets = []
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (bucket === null || typeof bucket !== 'object') continue
      const remaining = clampFraction(bucket.remainingFraction)
      // A bucket with an identity but no reported fraction is a real limit with
      // an unknown balance; dropping it would hide the limit, and defaulting it
      // to zero would claim the user is out of quota.
      if (remaining === undefined && bucket.bucketId === undefined && bucket.displayName === undefined) continue
      buckets.push({
        bucketId: String(bucket.bucketId ?? bucket.displayName ?? 'unknown'),
        displayName: String(bucket.displayName ?? bucket.bucketId ?? 'Limit'),
        ...bucket.window === undefined ? {} : { window: String(bucket.window) },
        ...bucket.resetTime === undefined ? {} : { resetTime: String(bucket.resetTime) },
        ...bucket.description === undefined ? {} : { description: String(bucket.description) },
        ...remaining === undefined ? {} : { remainingFraction: remaining },
      })
    }
    if (buckets.length === 0 && group.displayName === undefined) continue
    groups.push({
      displayName: String(group.displayName ?? 'Quota group'),
      ...group.description === undefined ? {} : { description: String(group.description) },
      buckets,
    })
  }
  return {
    groups,
    ...summary.description === undefined ? {} : { description: String(summary.description) },
  }
}

/**
 * Extract the plan label from a `loadCodeAssist` body.
 * @param {unknown} data - the response body.
 * @returns {string | undefined} a display label such as `Google AI Pro (pro)`.
 */
function parsePlanLabel(data) {
  if (data === null || typeof data !== 'object') return undefined
  for (const tier of [data.paidTier, data.currentTier]) {
    if (tier === null || typeof tier !== 'object') continue
    const name = typeof tier.name === 'string' ? tier.name : undefined
    if (name === undefined) continue
    const id = typeof tier.id === 'string' && tier.id.length > 0 ? tier.id : undefined
    return id === undefined ? name : `${name} (${id})`
  }
  return undefined
}

/**
 * Split one SSE line into its JSON payload.
 * @param {string} line - one raw line without its terminator.
 * @returns {object | undefined} the parsed payload, when the line carries one.
 */
function ssePayload(line) {
  if (!line.startsWith('data:')) return undefined
  const body = line.slice(5).trim()
  if (body.length === 0 || body === '[DONE]') return undefined
  try {
    const parsed = JSON.parse(body)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Unwrap the two response envelopes the backend uses: the plain
 * `{candidates, usageMetadata}` form and the Vertex-wrapped `{response:{...}}`
 * form.
 * @param {object} payload - one SSE payload.
 * @returns {object} the body carrying `candidates` and `usageMetadata`.
 */
export function unwrapPayload(payload) {
  if (payload.response !== null && typeof payload.response === 'object') return payload.response
  return payload
}

/** Cloud Code Assist client bound to one credential store and endpoint. */
export class CloudCodeClient {
  #store
  #endpoint
  #streamIdleTimeoutMs
  #logger
  #projectId
  #projectAt = 0
  #directory
  #directoryAt = 0
  #fallbacks

  /**
   * @param {object} options - credential store, configured endpoint, stream idle bound, logger,
   *   and the failover hosts to append.
   */
  constructor({ store, endpoint, streamIdleTimeoutMs, logger, fallbacks = ENDPOINT_FALLBACKS }) {
    this.#store = store
    this.#endpoint = endpoint
    this.#streamIdleTimeoutMs = streamIdleTimeoutMs
    this.#logger = logger
    this.#fallbacks = fallbacks
  }

  /** The credential store this client authenticates through. */
  get store() {
    return this.#store
  }

  /**
   * Drop every cached account fact. Called when the credential changes, so a
   * different Google account never inherits the previous one's project or
   * model directory.
   * @returns {void}
   */
  forget() {
    this.#projectId = undefined
    this.#projectAt = 0
    this.#directory = undefined
    this.#directoryAt = 0
  }

  /**
   * Hosts to try, configured one first, deduplicated.
   * @returns {string[]} candidate base URLs.
   */
  #hosts() {
    const candidates = [this.#endpoint ?? DEFAULT_ENDPOINT, ...this.#fallbacks]
    return [...new Set(candidates.filter(host => typeof host === 'string' && host.length > 0))]
  }

  /**
   * Headers for one backend call.
   *
   * The harness's mandatory attribution token is appended to the Antigravity
   * product token inside a single `user-agent` value: two separate spellings of
   * the same header would be comma-joined by `fetch` into something the backend
   * cannot parse.
   *
   * @param {string} access - live access token.
   * @param {string} publicId - public model id, for the Claude beta header.
   * @returns {Record<string, string>} the headers.
   */
  #headers(access, publicId) {
    const attribution = attributionHeaders()['user-agent']
    return {
      authorization: `Bearer ${access}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': `${antigravityUserAgent()} ${attribution}`,
      'x-goog-api-client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'client-metadata': JSON.stringify(clientMetadata()),
      ...publicId.startsWith('claude-') ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {},
    }
  }

  /**
   * POST a JSON body, walking the host list on retryable failures.
   * @param {string} path - `/v1internal:<method>` path.
   * @param {object} body - JSON body.
   * @param {object} options - `signal`, `publicId`, and the code to stamp on failure.
   * @returns {Promise<{ data: unknown, host: string }>} the parsed body and the host that served it.
   */
  async #postJson(path, body, { signal, publicId = '', code = 'ANTIGRAVITY_ERROR' } = {}) {
    const access = await ensureAccessToken(this.#store, { signal })
    const hosts = this.#hosts()
    let lastError
    for (const host of hosts) {
      let response
      try {
        response = await fetch(`${host}${path}`, {
          method: 'POST',
          headers: this.#headers(access, publicId),
          body: JSON.stringify(body),
          signal: signal === undefined
            ? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
            : AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]),
        })
      } catch (error) {
        if (signal?.aborted === true) throw error
        lastError = new CloudCodeError(
          `antigravity-connect: ${path} could not reach ${host}: ${redactSecrets(error?.message ?? error)}`,
          { code: 'TRANSPORT', host },
        )
        continue
      }
      if (response.ok) {
        try {
          return { data: await response.json(), host }
        } catch {
          throw new CloudCodeError(`antigravity-connect: ${path} returned a non-JSON body`, {
            code: 'PROTOCOL',
            status: response.status,
            host,
          })
        }
      }
      const detail = await errorDetail(response)
      const classified = classify(response.status, detail) || code
      lastError = new CloudCodeError(
        `antigravity-connect: ${path} failed (HTTP ${response.status}): ${detail}`,
        {
          code: classified,
          status: response.status,
          host,
          retryAfterMs: retryAfterMs(response),
        },
      )
      if (!RETRYABLE_STATUS.has(response.status) && !isHostFailoverStatus(classified)) throw lastError
    }
    throw lastError ?? new CloudCodeError(`antigravity-connect: ${path} failed`, { code })
  }

  /**
   * Resolve the Cloud Code Assist project the account bills against.
   *
   * The result is cached in memory and, once known, on the credential document
   * so a restart does not pay for the round-trip again. Both caches expire, so
   * an account switched to a different project is picked up.
   *
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<string>} the project id.
   */
  async project(signal) {
    if (this.#projectId !== undefined && Date.now() - this.#projectAt < PROJECT_CACHE_TTL_MS) {
      return this.#projectId
    }
    const stored = await this.#store.read()
    if (stored?.projectId !== undefined && typeof stored.projectId === 'string' && stored.projectId.length > 0) {
      this.#projectId = stored.projectId
      this.#projectAt = Date.now()
      return this.#projectId
    }
    const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
    let discovered
    try {
      const { data } = await this.#postJson('/v1internal:loadCodeAssist', { metadata }, {
        signal,
        code: 'PROJECT_DISCOVERY',
      })
      discovered = extractProjectId(data)
    } catch (error) {
      if (signal?.aborted === true) throw error
      this.#logger?.warn?.(`antigravity-connect: loadCodeAssist failed, trying the project list (${redactSecrets(error?.message ?? error)})`)
    }
    if (discovered === undefined) {
      const { data } = await this.#postJson('/v1internal:listCloudAICompanionProjects', {}, {
        signal,
        code: 'PROJECT_DISCOVERY',
      })
      const projects = Array.isArray(data?.projects) ? data.projects : []
      for (const project of projects) {
        const id = extractProjectId(project)
        if (id !== undefined) {
          discovered = id
          break
        }
      }
    }
    if (discovered === undefined) {
      throw new CloudCodeError(
        'antigravity-connect: could not determine a Cloud Code Assist project for this account;'
        + ' open Settings > Antigravity, sign out, and sign in again',
        { code: 'PROJECT_DISCOVERY' },
      )
    }
    this.#projectId = discovered
    this.#projectAt = Date.now()
    // Persist so the next process start skips discovery entirely.
    await this.#store.modify(async current => current === undefined
      ? { result: undefined }
      : { next: { ...current, projectId: discovered }, result: undefined })
    return discovered
  }

  /**
   * The models this account may call right now, as the backend reports them.
   *
   * Cached for {@link MODEL_CACHE_TTL_MS}. A failure resolves to `undefined`
   * rather than throwing: this is a listing path, and a transient fault must
   * degrade to the fallback catalog instead of failing a request or an
   * already-open settings page.
   *
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object | undefined>} the raw `fetchAvailableModels` body, or `undefined` when unavailable.
   */
  async modelDirectory(signal) {
    if (this.#directory !== undefined && Date.now() - this.#directoryAt < MODEL_CACHE_TTL_MS) {
      return this.#directory
    }
    try {
      const project = await this.project(signal)
      const { data } = await this.#postJson('/v1internal:fetchAvailableModels', { project }, { signal })
      if (data === null || typeof data !== 'object') return undefined
      this.#directory = data
      this.#directoryAt = Date.now()
      return data
    } catch (error) {
      if (signal?.aborted === true) throw error
      this.#logger?.warn?.(
        `antigravity-connect: could not read the model directory, falling back to the built-in list`
        + ` (${redactSecrets(error?.message ?? error)})`,
      )
      return undefined
    }
  }

  /**
   * Fetch the account's live quota summary and plan label.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ projectId: string, planLabel?: string, groups: object[], description?: string, fetchedAt: number }>} the summary.
   */
  async quota(signal) {
    const projectId = await this.project(signal)
    const [assist, summary] = await Promise.all([
      this.#postJson('/v1internal:loadCodeAssist', {
        metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
      }, { signal, code: 'QUOTA' }).catch(() => undefined),
      this.#postJson('/v1internal:retrieveUserQuotaSummary', {}, { signal, code: 'QUOTA' }),
    ])
    const parsed = parseQuotaGroups(summary.data)
    const planLabel = assist === undefined ? undefined : parsePlanLabel(assist.data)
    return {
      projectId,
      ...planLabel === undefined ? {} : { planLabel },
      groups: parsed.groups,
      ...parsed.description === undefined ? {} : { description: parsed.description },
      fetchedAt: Date.now(),
    }
  }

  /**
   * Open the streaming generation call and yield each parsed SSE payload.
   *
   * The host list is walked only on a retryable status *before* the body
   * starts: once chunks are flowing, restarting would duplicate output.
   *
   * @param {object} body - the request envelope from `buildRequest`.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {AsyncGenerator<object>} parsed payloads, in wire order.
   */
  async *streamGenerate(body, signal) {
    const access = await ensureAccessToken(this.#store, { signal })
    const hosts = this.#hosts()
    let response
    let lastError
    for (const host of hosts) {
      let attempt
      try {
        attempt = await fetch(`${host}/v1internal:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: this.#headers(access, String(body.model ?? '')),
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        if (signal?.aborted === true) throw error
        lastError = new CloudCodeError(
          `antigravity-connect: could not reach ${host}: ${redactSecrets(error?.message ?? error)}`,
          { code: 'TRANSPORT', host },
        )
        continue
      }
      if (attempt.ok) {
        response = { response: attempt, host }
        break
      }
      const detail = await errorDetail(attempt)
      const classified = classify(attempt.status, detail)
      lastError = new CloudCodeError(
        `antigravity-connect: generation failed (HTTP ${attempt.status}): ${detail}`,
        {
          code: classified,
          status: attempt.status,
          host,
          retryAfterMs: retryAfterMs(attempt),
        },
      )
      if (!RETRYABLE_STATUS.has(attempt.status) && !isHostFailoverStatus(classified)) throw lastError
    }
    if (response === undefined) throw lastError ?? new CloudCodeError('antigravity-connect: generation failed', {})

    yield * this.#readSse(response.response)
  }

  /**
   * Await one body read under an idle bound.
   *
   * The bound has to be raced against the read rather than merely signalled:
   * a stream reader has no way to observe an abort, so a watchdog that only
   * raises a signal would leave this awaiting a read that never arrives —
   * which is the exact failure the bound exists to catch. Cancelling the body
   * on timeout is what releases the socket.
   *
   * @param {ReadableStreamDefaultReader<Uint8Array>} reader - the body reader.
   * @returns {Promise<ReadableStreamReadResult<Uint8Array>>} the read result.
   */
  async #readWithIdle(reader) {
    let timer
    const idle = new Promise(resolve => {
      timer = setTimeout(() => resolve({ kind: 'idle' }), this.#streamIdleTimeoutMs)
    })
    try {
      const outcome = await Promise.race([
        reader.read().then(value => ({ kind: 'read', value })),
        idle,
      ])
      if (outcome.kind === 'idle') {
        reader.cancel().catch(() => {})
        throw new CloudCodeError(
          `antigravity-connect: the backend sent nothing for ${Math.round(this.#streamIdleTimeoutMs / 1000)}s;`
          + ' giving up on this stream',
          { code: STREAM_IDLE_TIMEOUT_CODE },
        )
      }
      return outcome.value
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Frame an SSE body into payloads, enforcing an idle bound on each read.
   *
   * Cancellation rides the response itself: the caller's signal is the one
   * `fetch` was given, so an abort rejects the pending read without any extra
   * wiring here.
   *
   * @param {Response} response - the streaming response.
   * @returns {AsyncGenerator<object>} parsed payloads.
   */
  async *#readSse(response) {
    if (response.body === null) {
      throw new CloudCodeError('antigravity-connect: the backend returned an empty stream body', { code: 'TRANSPORT' })
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const result = await this.#readWithIdle(reader)
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const payload = ssePayload(buffer.slice(0, newline).replace(/\r$/, ''))
          buffer = buffer.slice(newline + 1)
          if (payload !== undefined) yield payload
          newline = buffer.indexOf('\n')
        }
      }
      // A stream that ends without a trailing newline still carries its last event.
      const payload = ssePayload(buffer.replace(/\r$/, ''))
      if (payload !== undefined) yield payload
    } finally {
      // Release the socket when the consumer stopped early. Deliberately not
      // awaited: a connection the peer already destroyed can leave `cancel()`
      // unsettled, and finishing this generator must not depend on it.
      reader.cancel().catch(() => {})
    }
  }
}
