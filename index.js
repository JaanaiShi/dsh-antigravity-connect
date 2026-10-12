/**
 * dsh-antigravity-connect — a DeepSeek Harness model provider for Google
 * Antigravity / Cloud Code Assist.
 *
 * The plugin registers one `antigravity` route on the harness LLM service,
 * authenticates it with the Antigravity IDE's own Google OAuth client, and
 * streams generations from `cloudcode-pa.googleapis.com`. Credentials live
 * under the harness home; the settings page in the Web GUI signs in, reports
 * quota, and chooses which models the picker advertises.
 *
 * It is a DSH Web plugin and nothing else: there is no separate daemon, no
 * listening port of its own, and no outbound proxy surface. The settings API is
 * mounted on the harness web server that already exists.
 *
 * Load it from a profile bundle:
 *
 * ```yaml
 * - insert:
 *     - id: antigravity-connect
 *       name: dsh-antigravity-connect
 * ```
 *
 * @module dsh-antigravity-connect
 */

import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  CREDENTIAL_FILE,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_ENDPOINT,
  DEFAULT_SYSTEM_INSTRUCTION,
  PREFERENCES_FILE,
  PLUGIN_ID,
  PROVIDER,
  STREAM_IDLE_TIMEOUT_MS,
} from './lib/constants.js'
import { CredentialStore } from './lib/credentials.js'
import { CloudCodeClient } from './lib/cloudcode.js'
import { AntigravityAdapter } from './lib/adapter.js'
import { PreferenceStore } from './lib/preferences.js'
import { registerApi } from './lib/api.js'

/** Cordis plugin name; must match the package `name`. */
export const name = PLUGIN_ID

/** The LLM registry this plugin registers a provider route on. */
export const inject = ['llm']

/**
 * Plugin configuration, read from this plugin's bundle layer.
 *
 * Every field is optional in YAML: an omitted endpoint uses the public host, an
 * omitted system instruction uses the Antigravity baseline, and an omitted
 * stream-idle bound uses five minutes.
 *
 * This is entry config rather than a live settings section on purpose. The
 * harness's settings seam is for values a form should edit; everything a user
 * actually changes here — signing in, picking models — is owned by the plugin's
 * own settings page, so routing operator knobs through a second editable
 * surface would mean two writers for one value.
 *
 * @typedef {object} Config
 * @property {string} [endpoint] Cloud Code Assist base URL.
 * @property {number} [callbackPort] Loopback port for the OAuth redirect; must match the pre-registered client.
 * @property {number} [streamIdleTimeoutMs] Maximum provider silence tolerated while a stream read is outstanding.
 * @property {string} [systemInstruction] Baseline system text prepended to every request.
 */

/** Validated configuration schema. */
export const Config = z.object({
  endpoint: z.string(),
  callbackPort: z.natural().min(1024).max(65535).default(DEFAULT_CALLBACK_PORT),
  streamIdleTimeoutMs: z.natural().min(1).default(STREAM_IDLE_TIMEOUT_MS),
  systemInstruction: z.string(),
})

/**
 * Resolve raw configuration into the facts the transport needs.
 * @param {Config} config - entry config or a resolved settings snapshot.
 * @returns {{ endpoint: string, callbackPort: number, streamIdleTimeoutMs: number, systemInstruction: string }} validated facts.
 */
function resolveConfig(config) {
  const callbackPort = config.callbackPort ?? DEFAULT_CALLBACK_PORT
  if (!Number.isInteger(callbackPort) || callbackPort < 1024 || callbackPort > 65535) {
    throw new Error('dsh-antigravity-connect: callbackPort must be an integer from 1024 through 65535')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error('dsh-antigravity-connect: streamIdleTimeoutMs must be a positive number')
  }
  if (streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    // Node clamps a longer timer to 1ms, so this would silently cut every
    // stream almost immediately instead of waiting.
    throw new Error(
      `dsh-antigravity-connect: streamIdleTimeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    endpoint: config.endpoint !== undefined && config.endpoint.length > 0 ? config.endpoint : DEFAULT_ENDPOINT,
    callbackPort,
    streamIdleTimeoutMs,
    systemInstruction: config.systemInstruction !== undefined && config.systemInstruction.length > 0
      ? config.systemInstruction
      : DEFAULT_SYSTEM_INSTRUCTION,
  }
}

/**
 * Mount the provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Config} config - entry configuration.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  // Config is entry-only, so it resolves exactly once. A bad value fails the
  // plugin's activation loudly instead of being papered over at request time.
  const facts = resolveConfig(config)

  const store = new CredentialStore(dshHomePath('storages', CREDENTIAL_FILE))
  const preferences = new PreferenceStore(dshHomePath('storages', PREFERENCES_FILE))

  // `listModels` must answer synchronously, so the preference document is
  // mirrored in memory: read once at mount, rewritten through the mirror
  // afterwards. `undefined` means the user has expressed no preference, and
  // every model the directory reports is offered.
  let enabledModelIds

  const client = new CloudCodeClient({
    store,
    endpoint: facts.endpoint,
    streamIdleTimeoutMs: facts.streamIdleTimeoutMs,
    logger: ctx.logger,
  })

  /**
   * Resolve one stored image to base64 for an inline request part.
   * @param {import('@deepseek-ai/dsh-attachment').ImageAttachmentRef} ref - the durable reference.
   * @returns {Promise<{ data: string, mimeType: string } | undefined>} the encoded bytes, or `undefined` when unavailable.
   */
  const resolveAttachment = async (ref) => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined || ref === null || typeof ref !== 'object') return undefined
    try {
      const stored = await attachments.readImage(ref)
      return {
        data: Buffer.from(stored.data).toString('base64'),
        mimeType: typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png',
      }
    } catch (error) {
      // An image that cannot be read degrades the request; it must not fail it.
      ctx.logger.warn(`dsh-antigravity-connect: could not read an image attachment (${String(error?.message ?? error)})`)
      return undefined
    }
  }

  const adapter = new AntigravityAdapter({
    client,
    enabledModelIds: () => enabledModelIds,
    resolveAttachment,
    systemInstruction: () => facts.systemInstruction,
    logger: ctx.logger,
  })

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)

  // The settings API owns the sign-in flow; its routes bind to this fiber.
  registerApi(ctx, {
    store,
    preferences,
    client,
    callbackPort: facts.callbackPort,
    logger: ctx.logger,
    getEnabledModelIds: () => enabledModelIds,
    setEnabledModelIds: (ids) => { enabledModelIds = ids },
  })

  // The stored selection replaces the "everything on" default as soon as it
  // loads, and the picker is told the advertised set moved.
  void preferences.read()
    .then((stored) => {
      // Only an explicitly stored selection narrows the picker; an absent
      // document keeps the "offer everything" default.
      enabledModelIds = stored.explicit ? stored.enabledModelIds : undefined
      ctx.emit('llm/adapters-updated')
    })
    .catch((error) => {
      ctx.logger.warn(`dsh-antigravity-connect: could not read the model preferences (${String(error?.message ?? error)})`)
    })

  // Release the route when the plugin unloads; the HTTP route and the
  // preference read bind to this fiber already.
  ctx.effect(() => () => { registration() }, 'dsh-antigravity-connect: provider route')

  ctx.logger.info(`dsh-antigravity-connect: registered the "${PROVIDER}" provider route`)
}

apply.inject = ['llm']

export default apply
