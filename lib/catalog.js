/**
 * Model catalog: which models exist, what each is called, and how much it holds.
 *
 * ## Why this is live-first
 *
 * The backend's `fetchAvailableModels` directory is the only correct source of
 * truth for *which* models an account has. A hardcoded table goes stale
 * silently, and the failure is the worst kind: a model the account really does
 * have is simply absent from the picker, with nothing on screen to explain it.
 * The rewrite that produced this file was prompted by exactly that —
 * `gemini-3.8-flash` was live on an account while the table still called
 * `gemini-3.7-flash` the newest model, and most of the table's `-low` /
 * `-medium` / `-high` variants did not exist at all.
 *
 * So the directory is what the picker is built from, and it replaces the
 * fallback wholesale. {@link fallbackModels} exists only so the picker is never
 * *empty* while the directory is unreachable — signed out, or a transient
 * backend fault.
 *
 * Because the directory reports the ids the backend actually accepts, a model's
 * id here *is* its runtime id: there is no public-id indirection left to drift
 * out of sync.
 *
 * @module dsh-antigravity-connect/catalog
 */

/** The pool shared by the Gemini models. */
export const POOL_GEMINI = 'gemini'

/** The separate pool shared by the Anthropic and OpenAI routes. */
export const POOL_THIRD_PARTY = 'third-party'

/**
 * Reasoning levels offered for a thinking model, in display order.
 *
 * The directory says *whether* a model thinks but does not enumerate levels, so
 * this is the vocabulary offered for the models it marks. `off` stays
 * meaningful for the `-tiered` routes, where it selects the lowest thinking
 * level rather than disabling thinking.
 */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high']

/**
 * Context capacity assumed for a model the directory does not size.
 *
 * `gemini-3.1-flash-image` is the real case: the backend reports it with no
 * token figures at all, and the harness cannot use a model with no declared
 * capacity.
 */
export const FALLBACK_CONTEXT_WINDOW = 1_048_576

/** Output cap assumed for a model the directory does not size. */
export const FALLBACK_MAX_OUTPUT_TOKENS = 65_536

/**
 * Offline fallback, used only while the directory is unreachable.
 *
 * Every figure is a copy of what the backend reported for these ids at the time
 * of writing, so this is a snapshot rather than a design.
 */
const FALLBACK_SPECS = [
  { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
  { id: 'gemini-3.7-flash-tiered', name: 'Gemini 3.7 Flash', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
  { id: 'gemini-3.6-flash-tiered', name: 'Gemini 3.6 Flash', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
  { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', maxTokens: 1_048_576, maxOutputTokens: 65_535 },
  { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', maxTokens: 1_000_000, maxOutputTokens: 128_000, thirdParty: true },
  { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)', maxTokens: 1_000_000, maxOutputTokens: 128_000, thirdParty: true },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', maxTokens: 131_072, maxOutputTokens: 32_768, thirdParty: true },
]

/**
 * Turn a runtime id into a readable name, for entries the backend leaves
 * unnamed.
 *
 * The `-tiered` routes are what this is for: they are real and selectable, but
 * the directory lists them with no `displayName`, so without this they would
 * render as a bare id.
 *
 * @param {string} id - runtime model id.
 * @returns {string} a title-cased display name.
 */
export function displayNameFromId(id) {
  return id
    .split('-')
    .map(part => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ')
}

/**
 * Map a backend `modelProvider` token to a quota pool.
 * @param {unknown} modelProvider - e.g. `MODEL_PROVIDER_ANTHROPIC`.
 * @param {string} id - runtime id, consulted when the field is absent.
 * @returns {string} one of the `POOL_*` values.
 */
export function poolFor(modelProvider, id) {
  if (typeof modelProvider === 'string') {
    if (modelProvider.includes('ANTHROPIC') || modelProvider.includes('OPENAI')) return POOL_THIRD_PARTY
    if (modelProvider.includes('GOOGLE')) return POOL_GEMINI
  }
  return id.startsWith('gemini-') ? POOL_GEMINI : POOL_THIRD_PARTY
}

/**
 * Whether a directory entry is a real, user-selectable model.
 *
 * The directory also carries entries that are not conversational models:
 * `chat_*` and `tab_*` ids drive IDE features, and `isInternal` marks entries
 * the backend does not intend a user to pick. Offering them would put rows in
 * the picker that cannot hold a conversation.
 *
 * The directory additionally advertises some routes it will not serve. The known
 * case is `gemini-3.1-pro-high`: it ships full metadata (display name, a
 * thinking budget, a context window) and 400s `INVALID_ARGUMENT` on every
 * request, with or without a `generationConfig`. Its sibling `gemini-3.1-pro-low`
 * and the equivalently-labelled `gemini-pro-agent` both serve normally, so this
 * is a dead route rather than a malformed request. A picker row that always
 * fails is worse than a missing one, so the route is withheld.
 *
 * @param {string} id - runtime model id.
 * @param {object} info - the directory entry.
 * @returns {boolean} true when the model belongs in a picker.
 */
export function isSelectableModel(id, info) {
  if (typeof id !== 'string' || id.length === 0) return false
  if (info === null || typeof info !== 'object') return false
  if (info.isInternal === true) return false
  if (id.startsWith('chat_') || id.startsWith('tab_')) return false
  // Advertised but not servable: see the note above.
  if (DEAD_ROUTE_IDS.has(id)) return false
  return true
}

/**
 * Routes the directory advertises that the backend refuses to serve.
 *
 * Kept as a named set so the reason is discoverable from the id alone, and so a
 * route can be re-admitted by deleting one line once the backend serves it.
 */
const DEAD_ROUTE_IDS = new Set(['gemini-3.1-pro-high'])

/**
 * Normalize one directory entry into this plugin's model shape.
 * @param {string} id - runtime model id.
 * @param {object} info - the directory entry.
 * @returns {object} the normalized model.
 */
export function normalizeModel(id, info) {
  const contextWindow = Number.isSafeInteger(info.maxTokens) && info.maxTokens > 0
    ? info.maxTokens
    : FALLBACK_CONTEXT_WINDOW
  const declared = Number.isSafeInteger(info.maxOutputTokens) && info.maxOutputTokens > 0
    ? info.maxOutputTokens
    : FALLBACK_MAX_OUTPUT_TOKENS
  const name = typeof info.displayName === 'string' && info.displayName.length > 0
    ? info.displayName
    : displayNameFromId(id)
  const quota = info.quotaInfo !== null && typeof info.quotaInfo === 'object' ? info.quotaInfo : {}
  const remainingFraction = typeof quota.remainingFraction === 'number'
    ? Math.min(1, Math.max(0, quota.remainingFraction))
    : undefined
  return {
    id,
    name,
    pool: poolFor(info.modelProvider, id),
    contextWindow,
    // A reply cap above the context window is not usable, and the backend
    // rejects such a request outright.
    maxOutputTokens: Math.min(declared, contextWindow),
    supportsThinking: info.supportsThinking === true,
    // An absent field means "not reported"; only an explicit value is a
    // statement about capability.
    supportsImages: info.supportsImages === true,
    ...remainingFraction === undefined ? {} : { remainingFraction },
  }
}

/**
 * Order two models the way a picker should read.
 *
 * Gemini leads because it is the primary pool; then by family and descending
 * version so `3.8` precedes `3.7`; then the generic `-tiered` route after its
 * named siblings, being the same model without a preset level.
 *
 * @param {object} left - one model.
 * @param {object} right - the other.
 * @returns {number} comparator result.
 */
function compareModels(left, right) {
  if (left.pool !== right.pool) return left.pool === POOL_GEMINI ? -1 : 1

  /** The leading version number in a model id, or 0 when it has none. */
  const versionOf = (model) => {
    const match = /(\d+(?:\.\d+)?)/.exec(model.id)
    return match === null ? 0 : Number.parseFloat(match[1])
  }
  /** The id with versions and preset suffixes stripped, as a family key. */
  const familyOf = (model) => model.id
    .replace(/[\d.]+/g, '')
    .replace(/-(?:tiered|high|low|medium|extra|agent)\b/g, '')
    .replace(/-+/g, '-')

  const family = familyOf(left).localeCompare(familyOf(right))
  if (family !== 0) return family

  const version = versionOf(right) - versionOf(left)
  if (version !== 0) return version

  const tiered = Number(left.id.endsWith('-tiered')) - Number(right.id.endsWith('-tiered'))
  if (tiered !== 0) return tiered

  return left.id.localeCompare(right.id)
}

/**
 * Build the selectable model list from a raw directory response.
 *
 * A raw directory order is unusable in a picker: it interleaves `chat_*`
 * entries and lists older versions first.
 *
 * @param {unknown} directory - the `fetchAvailableModels` response body.
 * @returns {object[]} normalized models, in display order.
 */
export function modelsFromDirectory(directory) {
  const models = directory !== null && typeof directory === 'object'
    && directory.models !== null && typeof directory.models === 'object'
    ? directory.models
    : {}
  const normalized = []
  for (const [id, info] of Object.entries(models)) {
    if (!isSelectableModel(id, info)) continue
    normalized.push(normalizeModel(id, info))
  }
  return normalized.sort(compareModels)
}

/**
 * The offline fallback list, in the same shape as {@link modelsFromDirectory}.
 * @returns {object[]} normalized fallback models.
 */
export function fallbackModels() {
  return FALLBACK_SPECS
    .map(spec => normalizeModel(spec.id, {
      displayName: spec.name,
      maxTokens: spec.maxTokens,
      maxOutputTokens: spec.maxOutputTokens,
      supportsThinking: true,
      supportsImages: spec.thirdParty !== true,
      modelProvider: spec.thirdParty === true ? 'MODEL_PROVIDER_ANTHROPIC' : 'MODEL_PROVIDER_GOOGLE',
    }))
    .sort(compareModels)
}
