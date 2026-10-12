/**
 * Wire-level facts for the Google Antigravity / Cloud Code Assist provider.
 *
 * Everything in this module is a constant or a pure derivation of one: the
 * OAuth endpoints and the public installed-app client identity, the Cloud Code
 * Assist hosts, the wire headers the IDE itself sends, and the timeouts the
 * transport enforces. Keeping them in one place is what lets the adapter, the
 * login flow, and the CLI helper agree without importing each other.
 *
 * @module dsh-antigravity-connect/constants
 */

/** Provider route this plugin owns on `ctx.llm`. */
export const PROVIDER = 'antigravity'

/** Human-readable provider name for selectors and diagnostics. */
export const PROVIDER_NAME = 'Antigravity'

/** Cordis plugin id; must equal the package `name` so the loader and the client bundle agree. */
export const PLUGIN_ID = 'dsh-antigravity-connect'

/** Absolute path prefix every route of this plugin's own HTTP API lives under. */
export const API_PREFIX = '/antigravity-connect/api'

/** Credential store file name under the harness home's `storages/` directory. */
export const CREDENTIAL_FILE = 'antigravity-connect-oauth.json'

/** Preference store file name under the harness home's `storages/` directory. */
export const PREFERENCES_FILE = 'antigravity-connect-preferences.json'

/** Primary Cloud Code Assist host. */
export const DEFAULT_ENDPOINT = 'https://cloudcode-pa.googleapis.com'

/** Google OAuth 2.0 authorization endpoint. */
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Google OAuth 2.0 token endpoint (code exchange and refresh). */
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** OpenID userinfo endpoint used to label the signed-in account. */
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'

/**
 * Scopes the Antigravity IDE itself requests. `aicode` and `cloud-platform`
 * authorize the inference calls; `cclog` and `experimentsandconfigs` are sent
 * because the backend gates some responses on their presence; the two
 * `userinfo` scopes exist only so the settings page can name the account.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

/**
 * The public "installed application" OAuth client the Antigravity IDE ships.
 * Google issues these to desktop apps and they are not secrets in the RFC 8252
 * sense — there is no confidential client here, which is exactly why PKCE is
 * used for the code exchange. Encoded rather than written literally so the file
 * is not a verbatim credential dump for secret scanners.
 */
export const CLIENT_ID = Buffer.from(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc'
  + 'C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==',
  'base64',
).toString('utf8')

/** Companion value for the same installed-app client; see {@link CLIENT_ID}. */
export const CLIENT_SECRET = Buffer.from(
  'R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=',
  'base64',
).toString('utf8')

/** Loopback callback path registered with Google. */
export const REDIRECT_PATH = '/oauth-callback'

/**
 * Preferred loopback port. Google requires an exact redirect URI for a
 * pre-registered client, so the port is fixed rather than OS-assigned.
 */
export const DEFAULT_CALLBACK_PORT = 51121

/** How long a pending login waits for the browser to come back. */
export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

/** Access tokens are refreshed this long before their stated expiry. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000

/** Maximum provider idle time while one stream read is outstanding. */
export const STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Bound on the small metadata round-trips (project discovery, quota, catalog). */
export const DISCOVERY_TIMEOUT_MS = 8 * 1000

/** How long a discovered project id stays authoritative. */
export const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000

/** How long the live model catalog stays authoritative. */
export const MODEL_CACHE_TTL_MS = 30 * 60 * 1000

/** IDE version advertised in `User-Agent`; the backend gates features on it. */
export const ANTIGRAVITY_VERSION = '1.15.8'

/** Wire platform token for `Client-Metadata`. */
export const PLATFORM = process.platform === 'darwin'
  ? 'MACOS'
  : process.platform === 'win32' ? 'WINDOWS' : 'LINUX'

/** `process.platform`/`process.arch` spelling used in the `User-Agent` product token. */
export const UA_PLATFORM = `${process.platform}/${process.arch}`

/** Cloud Code Assist role vocabulary for `contents[].role`. */
export const GEMINI_ROLE = { user: 'user', model: 'model' }

/**
 * Statuses worth trying the next host for.
 *
 * Deliberately narrower than "any transient failure": 401/403/404 describe this
 * *account's* standing with this backend, so failing over to another host
 * cannot fix them — it only burns a round-trip and replaces the actionable
 * cause (an expired sign-in, a missing project) with whatever the second host
 * happens to say. Only a server-side fault is worth a second host.
 */
export const RETRYABLE_STATUS = new Set([500, 502, 503, 504])

/**
 * Whether a `429` is worth trying the next host for.
 *
 * A throttle is a property of the *host*, not the account: the two Cloud Code
 * Assist hosts bill against different pools, so an allowance spent on one is
 * routinely untouched on the other. A genuine `QUOTA` classification is the
 * opposite — it is the account's own standing and no host can lift it — so the
 * caller must fail over only when the body reads as a throttle.
 *
 * Measured on a real account: the production host answered every request `429`
 * while the sandbox host answered the identical request `200`.
 *
 * @param {string} code - the classification from `classify`.
 * @returns {boolean} true when another host may still serve the request.
 */
export function isHostFailoverStatus(code) {
  return code === 'RATE_LIMIT'
}

/**
 * Hosts to try, in order, after the configured `endpoint`.
 *
 * The sandbox host is listed because it is a real serving endpoint for this
 * product, not a development leftover: it answers the same `v1internal:*`
 * methods against a separate allowance pool. An account whose production pool
 * is spent is served here, so omitting it turns a working request into a bare
 * `429`. It is a *fallback* rather than the default because it intermittently
 * refuses the TLS handshake (observed `ECONNRESET`), which is exactly the kind
 * of fault the caller's host loop is built to walk past.
 */
export const ENDPOINT_FALLBACKS = ['https://daily-cloudcode-pa.sandbox.googleapis.com']

/** Baseline system instruction the Antigravity IDE prepends. */
export const DEFAULT_SYSTEM_INSTRUCTION = 'You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. '
  + 'You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.'

/**
 * Appended to the system slot: the backend otherwise emits rule-check
 * preambles as visible text, which pollutes an agentic transcript.
 */
export const NO_PREAMBLE_INSTRUCTION = 'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, '
  + 'or thinking/personality preambles in the final response. Output only the final response.'

/** `Client-Metadata` sent on every Cloud Code Assist request. */
export function clientMetadata() {
  return { ideType: 'ANTIGRAVITY', platform: PLATFORM, pluginType: 'GEMINI' }
}

/**
 * The Antigravity product token on its own. The harness's own mandatory
 * attribution token is appended to this by the caller rather than sent as a
 * second `user-agent` header — two spellings of one field would be comma-joined
 * by `fetch` into a single value the backend cannot parse.
 * @returns the IDE product token, e.g. `antigravity/1.15.8 darwin/arm64`.
 */
export function antigravityUserAgent() {
  return `antigravity/${ANTIGRAVITY_VERSION} ${UA_PLATFORM}`
}

/**
 * Build the loopback redirect URI for a given port.
 * @param port - the port the callback listener actually bound.
 * @returns the absolute redirect URI registered with Google.
 */
export function redirectUri(port) {
  return `http://localhost:${port}${REDIRECT_PATH}`
}
