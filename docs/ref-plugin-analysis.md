# `dsh-antigravity` — Technical Reference for Reimplementation

Analysis of the reference plugin at `/tmp/dsh-antigravity-ref` (package `dsh-antigravity@0.0.4`).

| File | Lines | Role |
|---|---|---|
| `lib/index.js` | 3034 | Host (Cordis/node) plugin: OAuth, credential store, Cloud Code Assist client, `LlmAdapter`, HTTP web API |
| `lib/client.js` | 661 | Web client plugin: settings page (slot `settings.section`), i18n, calls the host HTTP API |
| `bin/antigravity-login.mjs` | 34 | CLI login helper (`antigravity-login [--logout]`) |
| `cordis.patch.yml` | 3 | Bundle patch that mounts the plugin |
| `package.json` | 75 | `dsh.bundle.patch`, `dsh.client.inject`, peer deps, `bin` |

Everything below is quoted from that source. Line numbers are `lib/index.js` unless stated.

**Verified runtime baseline.** The installed DSH packages under
`/Users/shiwenhui/.dsh/profiles/node_modules/@deepseek-ai/` are `0.1.1-rc.2`
(`dsh-client-ui-slots` is `0.1.0-rc.6`). The reference plugin was written against an
**older** `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-client-locale`. Every place where
that drift changes behaviour is flagged **[DRIFT]**. Do not copy drifted code blindly.

---

## Table of contents

1. [Exports, identity, and lifecycle](#1-exports-identity-and-lifecycle)
2. [OAuth flow](#2-oauth-flow)
3. [Credential storage](#3-credential-storage)
4. [Cloud Code Assist API](#4-cloud-code-assist-api)
5. [Streaming response handling](#5-streaming-response-handling)
6. [Model catalog](#6-model-catalog)
7. [Quota](#7-quota)
8. [DSH integration surface](#8-dsh-integration-surface)
9. [Client plugin](#9-client-plugin)
10. [Reusable vs. avoid](#10-reusable-vs-avoid)

---

## 1. Exports, identity, and lifecycle

### 1.1 Module identity and injection (L29–32)

```js
export const PROVIDER = "antigravity";
export const PROVIDER_NAME = "Antigravity";
export const name = "dsh-antigravity";
export const inject = ["llm"];
```

```js
// L3024-3034
export function apply(ctx) {
  const store = new FileCredentialStore(credentialPath());
  const modelSettings = new FileModelSettingsStore(modelSettingsPath());
  const adapter = new AntigravityAdapter(store, modelSettings);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  registerWebApi(ctx, store, modelSettings);
}

apply.inject = ["llm"];

export default apply;
```

Both `export const inject` and `apply.inject` are set. **There is no `Config` schema
and no `@deepseek-ai/schemastery` import anywhere in the plugin** — all configuration is
via environment variables (see §4.2). There is also **no command registration**: the
`/antigravity-login`-style commands advertised in `doctorText()` (L2763) do not exist.

Full export list: `PROVIDER`, `PROVIDER_NAME`, `name`, `inject`, `credentialPath`,
`modelSettingsPath`, `redactSecrets`, `getAntigravityDiagnostics`, `compareAntigravityModels`,
`compareAntigravityModelOptions`, `fetchAccountQuota`, `getCachedQuota`, `formatQuotaSummary`,
`openBrowser`, `browserInteraction`, `terminalInteraction`, `loginAntigravity`,
`beginWebLogin`, `getWebLoginStatus`, `refreshAntigravityToken`, `getApiKey`,
`FileCredentialStore`, `FileModelSettingsStore`, `loginAndSave`, `AntigravityAdapter`, `apply`,
default.

### 1.2 Module-global state (L328–344)

```js
const diagnostics = {
  endpoint: "", status: undefined, projectId: "", resolvedRuntimeModel: "",
  availableModels: "", matchedModelDebug: "", error: "",
};

const projectCache = new Map();
const modelCache = new Map();
const inFlightModelLookups = new Map();
let cachedQuota = undefined;
let webLoginFlow = undefined;

let toolCallCounter = 0;
```

`projectCache` and `modelCache` are keyed by **the access token itself**
(`` `${token}::${projectId}::${requestedRuntimeModel}` `` at L832), so a refreshed token
yields an empty cache and old entries are only evicted by TTL sweep / size cap.
`projectCache` is unbounded per token but capped at 32 entries (L657); `modelCache` is
capped at 64 with a TTL sweep (L848).

### 1.3 Import specifiers (L8–27)

```js
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError,
  QUOTA_EXCEEDED_CODE, ReasoningEffortId, attributionHeaders, contentHasImage,
  isContextWindowExceededError, isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
```

`peerDependencies` (all `"*"`, all optional via `peerDependenciesMeta: {"*": {optional: true}}`):
`@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-llm`,
`@deepseek-ai/dsh-timeout`. The host half never imports `dsh-client-ui-settings` or
`dsh-client-locale`; those appear only in `package.json` → `dsh.client.inject`.

---

## 2. OAuth flow

### 2.1 Constants (L34–67)

| Name | Exact value |
|---|---|
| `REDIRECT_PATH` | `"/oauth-callback"` |
| `AUTH_URL` | `"https://accounts.google.com/o/oauth2/v2/auth"` |
| `TOKEN_URL` | `"https://oauth2.googleapis.com/token"` (used for **both** exchange and refresh) |
| Loopback port | `51121` (`callbackPort()` default, L494) |
| `redirect_uri` | `` `http://localhost:${callbackPort()}${REDIRECT_PATH}` `` → `http://localhost:51121/oauth-callback` |
| Callback bind host | `127.0.0.1` (default; `resolveCallbackHost` maps `localhost`→`127.0.0.1`, L489) |
| Callback timeout | `OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000` |
| PKCE | **yes**, `S256` |
| Userinfo URL | `https://www.googleapis.com/oauth2/v1/userinfo?alt=json` (L2064) |

Scopes (L50–57), joined with `" "`:

```js
const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
```

Embedded OAuth client (base64-decoded at module load, L59–67). Both are overridable by env:

```js
const DEFAULT_CLIENT_ID = Buffer.from(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
    "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  "base64",
).toString("utf8");
const DEFAULT_CLIENT_SECRET = Buffer.from(
  "R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
  "base64",
).toString("utf8");
```

Decoded values:

| Field | Exact value |
|---|---|
| `client_id` | `[GOOGLE_CLIENT_ID]` |
| `client_secret` | `[GOOGLE_CLIENT_SECRET]` |

This is a Google "installed app" client: the secret is non-confidential by design (it ships
in the binary), which is why sending it alongside PKCE is acceptable. The base64 split into
two string literals is deliberate obfuscation against naive secret scanners, not a security
control.

### 2.2 Authorize URL construction — exact code

The URL is built in two places with **identical** parameter dicts: `loginAntigravity()` (L2182–2197)
and `beginWebLogin()` (L2299–2312). Quoting the web path (L2295–2312):

```js
  const { verifier, challenge } = generatePKCE();
  const state = base64Url(randomBytes(32));
  const { server, waitForCode } = await startCallbackServer(state);
  const callbackUrl = redirectUri();
  const authParams = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: callbackUrl,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  const flow = {
    status: "pending",
    authUrl: `${AUTH_URL}?${authParams.toString()}`,
    startedAt: Date.now(),
    error: "",
  };
  webLoginFlow = flow;
```

So the final URL is:

```text
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=<google_client_id>
  &response_type=code
  &redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback
  &scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Faicode+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+...
  &code_challenge=<S256 challenge>
  &code_challenge_method=S256
  &state=<base64url 32 random bytes>
  &access_type=offline
  &prompt=consent
```

`access_type=offline` + `prompt=consent` is what forces Google to return a `refresh_token`
every time (otherwise only the first consent does).

### 2.3 PKCE and state (L2052–2060)

```js
function base64Url(buffer) {
  return buffer.toString("base64url");
}

function generatePKCE() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
```

`state` is independently `base64Url(randomBytes(32))`. The verifier is **not persisted** —
it lives only in the closure of the in-flight flow, so an interrupted web login must be
restarted from scratch.

### 2.4 Loopback callback server (L2075–2139)

`startCallbackServer(expectedState)` returns `{ server, waitForCode }`. Behaviour:

- Only `GET`/`HEAD`; anything else → `405` with `oauthCallbackHeaders("text/plain; charset=utf-8")`.
- Any path other than `/oauth-callback` → `404`.
- `?error=` present → `400` + reject `new Error(\`OAuth error: ${providerError.slice(0, 200)}\`)`.
- Missing `code` or `state` → `400` + reject `"Missing code or state in OAuth callback"`.
- `state !== expectedState` → `400` + reject `"OAuth state mismatch"`.
- Success → `200` with body `"Antigravity authentication complete. You can close this window and return to DSH."`
- Server listens on `callbackPort()` / `resolveCallbackHost()`; the 5-minute timer rejects
  `"OAuth callback timed out waiting for browser login"` and closes the server.

Response security headers (L2029–2038):

```js
function oauthCallbackHeaders(contentType = "text/html; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
  };
}
```

Note the `redirect_uri` says `localhost` but the socket binds `127.0.0.1`; this works because
`localhost` normally resolves to `127.0.0.1`, and the Google client must have
`http://localhost:51121/oauth-callback` registered.

### 2.5 Token exchange — exact code (L2251–2284)

```js
async function exchangeOAuthCode(code, verifier, callbackUrl) {
  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`,
    );
  }
  const tokenData = await tokenResponse.json();
  if (!tokenData.refresh_token) {
    throw new Error("No refresh token received. Re-run login and allow offline access.");
  }
  const [email, discoveredProject] = await Promise.all([
    getUserEmail(tokenData.access_token),
    loadCodeAssist(tokenData.access_token),
  ]);
  return {
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
    projectId: discoveredProject || defaultProjectId(email || "antigravity-default"),
    email,
  };
}
```

`loginAntigravity()` (L2176–2239) performs the same exchange inline with an extra
`signal: interaction.signal`, plus `state` re-verification and `interaction.signal?.aborted`
checks. It is the terminal/`bin` path; `beginWebLogin` is the web path.

### 2.6 Token response shape consumed

| Field read | Type | Use |
|---|---|---|
| `access_token` | string | Bearer token |
| `refresh_token` | string | **required**; error if absent |
| `expires_in` | number (s) | `expires = Date.now() + expires_in*1000 - 5*60*1000` |

`scope`, `token_type`, `id_token` are ignored. `getUserEmail()` reads `data.email` from the
userinfo response and returns `undefined` on any failure (never throws).

### 2.7 Refresh — endpoint, body, trigger, scheduling (L2363–2396)

```js
function needsRefresh(credentials) {
  return !credentials?.access || !credentials.expires || credentials.expires <= Date.now() + 60000;
}

export async function refreshAntigravityToken(credentials) {
  if (!credentials?.refresh) throw new Error("Missing Antigravity refresh token. Run /antigravity-login.");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: credentials.refresh,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Antigravity token refresh failed: ${sanitizeOAuthProviderError(await response.text())}`,
    );
  }
  const data = await response.json();
  const existingProjectId = credentialProjectId(credentials);
  const discoveredProject = existingProjectId ? undefined : await loadCodeAssist(data.access_token);
  const email = credentialEmail(credentials);
  return {
    ...credentials,
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId:
      existingProjectId || discoveredProject || defaultProjectId(email || "antigravity-default"),
  };
}
```

**There is no timer, no background scheduler, and no `setInterval`.** Refresh is *lazy and
demand-driven*: `ensureApiKey(store)` is called at the top of both the chat path
(`requestAntigravityChunks`, L2606) and the quota path (`fetchAccountQuota`, L1278).

```js
// L2546-2572
async function ensureApiKey(store) {
  let credentials = await store.read();
  if (!credentials) {
    throw new LlmError("No Antigravity OAuth credentials. Run /antigravity-login.", "AUTH");
  }
  if (needsRefresh(credentials)) {
    credentials = await store.modify(async (current) => {
      if (!current) throw new LlmError("No Antigravity OAuth credentials. Run /antigravity-login.", "AUTH");
      if (!needsRefresh(current)) return current;
      return refreshAntigravityToken(current);
    });
  }
  let warmedProject = null;
  if (!credentialProjectId(credentials) && !antigravityEnv("PROJECT_ID")) {
    warmedProject = await loadCodeAssist(credentials.access);
    if (warmedProject) {
      await store.modify(async (current) => (current ? { ...current, projectId: warmedProject } : current));
    }
  }
  const projectId = resolveProjectId({
    credentialProjectId: credentialProjectId(credentials),
    email: credentialEmail(credentials),
    warmedProject,
  });
  setLastProjectId(projectId);
  return { token: credentials.access, projectId, email: credentialEmail(credentials) };
}
```

Two design points worth copying:

1. **Double-checked refresh inside `store.modify`.** The re-read + `needsRefresh(current)`
   re-test inside the serialized `modify()` critical section means N concurrent API calls
   whose token just expired produce exactly **one** token refresh, not N.
2. **60-second skew, plus 5-minute-expiry skew at write time.** `expires` is stored already
   reduced by 5 minutes, and `needsRefresh` adds another 60 s guard — an effective ~6-minute
   pre-expiry refresh margin.
3. On refresh, `projectId` is **kept** if already present; `loadCodeAssist` is only called
   when it is missing.

### 2.8 Web login state machine (L2286–2353)

`beginWebLogin(store)`:

- If `webLoginFlow?.status === "pending"`, returns the existing `{status, authUrl, startedAt}`
  (no second callback server, no second URL).
- Otherwise starts the PKCE/state pair and the callback server, stores `webLoginFlow`, and
  fires a **detached** async IIFE (`void (async () => {...})()`) that awaits the code,
  exchanges it, writes credentials, and sets `flow.status` to `"complete"` / `"error"`,
  clearing `cachedQuota` on success and closing the server in `finally`.

`getWebLoginStatus()` returns one of:

```js
{ status: "idle" }
{ status: "pending", startedAt, completedAt?, email?, error? }
{ status: "complete", startedAt, completedAt, email, error }
{ status: "error",    startedAt, completedAt, error }
```

The client polls `/status` every 2000 ms and reacts on `login.status === "complete" | "error"`.

### 2.9 Browser launch and interaction adapters (L2141–2174)

```js
export function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true });
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    }
  } catch {
    // Best effort only.
  }
}
```

`browserInteraction(signal)` calls `openBrowser` on `auth_url`; `terminalInteraction(signal)`
prints `event.instructions || "Open the following URL to sign in:"`, then the URL, then also
tries `openBrowser`. `bin/antigravity-login.mjs` wires `terminalInteraction` with an
`AbortController` on `SIGINT`/`SIGTERM` and supports `--logout` (`store.delete()`).

### 2.10 Secret redaction (L397–410) — copy this

```js
export function redactSecrets(text) {
  return String(text)
    .replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
    .replace(/\b1\/[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*)[^\s&,}]+/gi,
      "$1[redacted]",
    );
}
```

`safeError(error)` = `redactSecrets(error.message)`. `sanitizeOAuthProviderError(text)`
(L2040–2050) redacts, then extracts `error` + `error_description` from a JSON body, else
returns up to 300 chars.

---

## 3. Credential storage

### 3.1 Paths (L346–352)

```js
export function credentialPath() {
  return dshHomePath("storages", "antigravity-oauth.json");
}

export function modelSettingsPath() {
  return dshHomePath("storages", "antigravity-settings.json");
}
```

`dshHomePath(...segments)` resolves against the DSH home — precedence is explicit config →
`$DSH_HOME` → `~/.dsh`, and it returns a normalized absolute path. With the default home:

| Purpose | Absolute path |
|---|---|
| OAuth credentials | `$DSH_HOME/storages/antigravity-oauth.json` (e.g. `/Users/<you>/.dsh/storages/antigravity-oauth.json`) |
| Enabled-model settings + catalog | `$DSH_HOME/storages/antigravity-settings.json` |

### 3.2 Credential JSON shape

Written verbatim (2-space JSON, mode `0o600`) from the object returned by
`loginAntigravity` / `exchangeOAuthCode` / `refreshAntigravityToken`:

```json
{
  "refresh": "1//0g...",
  "access": "ya29.a0...",
  "expires": 1750000000000,
  "projectId": "a1b2c3d4-5e6f-...",
  "email": "user@example.com"
}
```

| Key | Type | Meaning |
|---|---|---|
| `refresh` | string | Google refresh token (required) |
| `access` | string | Bearer access token |
| `expires` | number | **epoch ms**, already reduced by 5 minutes |
| `projectId` | string | Cloud Code Assist project id; may be `undefined` and then omitted by `JSON.stringify` |
| `email` | string \| undefined | From userinfo; omitted when unknown |

### 3.3 `FileCredentialStore` (L2406–2455) — copy this verbatim

```js
export class FileCredentialStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = credentialPath()) {
    this.#file = file;
  }

  path() {
    return this.#file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return isRecord(parsed) ? parsed : undefined;
    } catch (error) {
      if (error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(credentials) {
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) await this.write(updated);
      return updated ?? current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  async delete() {
    await this.#chain.catch(() => {});
    try {
      await unlink(this.#file);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}
```

Properties: atomic write via `.tmp` + `rename`; `0o600` on the temp file (so the renamed
target keeps it); missing file is `undefined`, not an error; malformed JSON **throws**
(not swallowed) because only `ENOENT` is caught — `JSON.parse` failures propagate;
`modify()` is a promise chain that serializes all read-modify-write sequences and swallows
chain errors so one failure does not poison the queue.

### 3.4 Validation

There is no schema validation. The code is duck-typed throughout:

```js
function credentialProjectId(credentials) { return asString(credentials?.projectId); }  // L2355
function credentialEmail(credentials) { return asString(credentials?.email); }          // L2359
function needsRefresh(credentials) {                                                     // L2363
  return !credentials?.access || !credentials.expires || credentials.expires <= Date.now() + 60000;
}
```

`asString(v)` returns `v` only when it is a non-empty string, else `undefined`.
`refreshAntigravityToken` throws when `credentials?.refresh` is falsy. `credentialSummary`
(L2241) is the outward-facing view: `{ authenticated: false }` or
`{ authenticated: true, email, projectId, expires }`.

Vestigial export (L2398–2404, unused internally, no callers anywhere in the package):

```js
export function getApiKey(credentials) {
  const email = credentialEmail(credentials);
  return JSON.stringify({
    token: credentials.access,
    projectId: credentialProjectId(credentials) || defaultProjectId(email || "antigravity-default"),
  });
}
```

### 3.5 Model settings store (L2457–2520)

File shape:

```json
{
  "enabledModelIds": ["gemini-3.7-flash", "claude-opus-4-6"],
  "updatedAt": 1750000000000,
  "catalogModels": [ { "id": "...", "name": "...", "inputModalities": ["text"], "contextWindow": 1048576, "maxTokens": 65536, "reasoningEfforts": ["low","medium","high"], "available": true, "remainingFraction": 0.87, "resetTime": "...", "modelProvider": "..." } ]
}
```

Normalization rules (L2457–2468): `enabledModelIds` filters to non-empty strings with no
whitespace, dedupes via `Set`; defaults to `DEFAULT_ENABLED_MODEL_IDS` (= every id in
`MODELS`, L354). `catalogModels` filters to records with a non-empty string `id`.
`updatedAt` coerces to `0` when not a number. `write()` always stamps `updatedAt: Date.now()`
and returns `this.read()`. Same `#chain` serialization + tmp/rename + `0o600` as the
credential store. Helpers `setEnabledModelIds(ids)` and `setCatalogModels(models, {enabledModelIds})`
are `modify()` wrappers.

Effective-model helpers (L2522–2538):

```js
function enabledModelSet(settings) { return new Set(normalizeModelSettings(settings).enabledModelIds); }
function catalogModelsOf(settings) {
  const normalized = normalizeModelSettings(settings);
  return normalized.catalogModels.length ? normalized.catalogModels : MODELS;
}
function configuredModels(settings) {
  const enabled = enabledModelSet(settings);
  return catalogModelsOf(settings).filter((model) => enabled.has(model.id)).sort(compareAntigravityModels);
}
function modelFromSettings(settings, modelId) {
  return catalogModelsOf(settings).find((model) => model.id === modelId) || modelById(modelId) || inferModelShape(modelId);
}
```

---

## 4. Cloud Code Assist API

### 4.1 Hostnames and base paths (L41–45)

```js
const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];
```

`endpointCandidates()` (L476–479) returns `[ANTIGRAVITY_BASE_URL]` when set (validated), else
the two-entry fallback list — **in that order**, and every call site iterates the whole list.

`assertSafeApiBaseUrl(raw)` (L449–474) requires `https:`, no userinfo, host equal to
`googleapis.com` / ending in `.googleapis.com` / ending in `.sandbox.googleapis.com`, and
strips trailing slashes: returns `` `${url.origin}${path === "/" ? "" : path}` ``.

### 4.2 Environment variables (L356–358)

```js
function antigravityEnv(namePart) {
  return process.env[`ANTIGRAVITY_${namePart}`] || process.env[`NOAGY_${namePart}`];
}
```

| Suffix | Effect |
|---|---|
| `ANTIGRAVITY_BASE_URL` / `NOAGY_BASE_URL` | Overrides the endpoint list entirely (validated) |
| `ANTIGRAVITY_CALLBACK_HOST` | Must be loopback (`127.0.0.1`, `::1`, `localhost`); else throws |
| `ANTIGRAVITY_CALLBACK_PORT` | Integer 1–65535; else throws |
| `ANTIGRAVITY_CLIENT_ID` | Overrides embedded client id |
| `ANTIGRAVITY_CLIENT_SECRET` | Overrides embedded client secret |
| `ANTIGRAVITY_USER_AGENT` | Overrides the `User-Agent` header |
| `ANTIGRAVITY_PROJECT_ID` | Pins the project id; skips discovery |
| `ANTIGRAVITY_RUNTIME_MODEL` | Pins the runtime model id; skips `ROUTING` + dynamic lookup |

### 4.3 Endpoint catalogue

All calls are `POST` with the Google method-name suffix syntax `v1internal:<method>`.

| Method | Path | Body | Where |
|---|---|---|---|
| loadCodeAssist | `/v1internal:loadCodeAssist` | `{"metadata":{...}}` | L619, L1280, L600 |
| listCloudAICompanionProjects | `/v1internal:listCloudAICompanionProjects` | `{}` | L602 |
| fetchAvailableModels | `/v1internal:fetchAvailableModels` | `{"project": projectId}` | L800, L924 |
| retrieveUserQuotaSummary | `/v1internal:retrieveUserQuotaSummary` | `{}` | L1287 |
| streamGenerateContent | `/v1internal:streamGenerateContent?alt=sse` | full request envelope | L2588 |

No streaming chunked-JSON alternative is attempted; only SSE.

### 4.4 Headers

Bearer/JSON header builder (L520–533) — used for the SSE chat call:

```js
function antigravityHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: PLATFORM,
      pluginType: "GEMINI",
    }),
  };
}
```

`jsonHeaders(token)` (L551) = the same object with `Accept` overridden to `"application/json"`
(used by every non-streaming call).

| Header | Exact value |
|---|---|
| `Authorization` | `Bearer <access_token>` |
| `Content-Type` | `application/json` |
| `Accept` | `text/event-stream` (stream) / `application/json` (JSON calls) |
| `User-Agent` | `antigravity/1.15.8 <os>/<arch>` — `os` ∈ `darwin`,`windows`,`linux`; `arch` = `amd64` when `process.arch === "x64"`, else `process.arch` (`defaultUserAgent()`, L514–518) |
| `X-Goog-Api-Client` | `google-cloud-sdk vscode_cloudshelleditor/0.1` |
| `Client-Metadata` | `{"ideType":"ANTIGRAVITY","platform":"MACOS"\|"WINDOWS"\|"LINUX","pluginType":"GEMINI"}` |
| `anthropic-beta` | `"interleaved-thinking-2025-05-14"` — added **only** when `model.id.startsWith("claude-")` (L2612) |

`PLATFORM` (L75–76):

```js
const PLATFORM =
  process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
```

**`[DRIFT]` User-Agent header collision.** The chat path merges DSH attribution headers:

```js
// L2609-2613
const requestHeaders = {
  ...antigravityHeaders(token),
  ...attributionHeaderBag(),
  ...(model.id.startsWith("claude-") ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
};
```

with

```js
function attributionHeaderBag() {
  try { return attributionHeaders() || {}; } catch { return {}; }
}
```

Verified against the installed `dsh-llm@0.1.1-rc.2`
(`lib/types/attribution.js:43-45`), `attributionHeaders()` returns exactly
`{ "user-agent": "deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)" }`
— **lowercase** `user-agent`. The object literal therefore carries both `"User-Agent"` and
`"user-agent"`, and the Fetch spec's `Headers` normalization lowercases and **comma-joins**
duplicate names. The wire value effectively becomes
`antigravity/1.15.8 darwin/arm64, deepseek-harness/<v> (+https://github.com/deepseek-ai/deepseek-harness)`.
Since Google's backend may fingerprint the UA, a new plugin should build **one** merged UA
string deliberately rather than relying on this accident.

### 4.5 Project / account discovery

Three-tier strategy, all POST `v1internal:*`:

1. **`loadCodeAssist`** (L619–646) — primary. Body:

```js
const body = JSON.stringify({
  metadata: {
    ideType: "ANTIGRAVITY",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  },
});
```

Note the **body** uses `platform: "PLATFORM_UNSPECIFIED"` while the **header**
`Client-Metadata` uses the real `PLATFORM`. Both spellings ship in every discovery call.
On `!response.ok` it `continue`s to the next endpoint (it does not throw). On success it
extracts the project; if none, falls through to step 2. 8-second `AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)`.

2. **`listCloudAICompanionProjects`** (L599–617) — fallback, body `{}`, same 8 s timeout,
   returns `extractProjectId(await response.json())`.

3. **Synthetic deterministic UUID** — `stableProjectId(seed)` (L558–564):

```js
function stableProjectId(seed) {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultProjectId(seed = "antigravity-default") {
  return antigravityEnv("PROJECT_ID")?.trim() || stableProjectId(seed);
}
```

This is a **SHA-1 derived UUIDv5-like identifier** (version nibble forced to `5`, variant
nibble `10`) — not a registered Google Cloud project. It is a "distinct stable bucket per
account" identity hack.

Project-id extraction order (L570–597):

```js
const direct =
  data.antigravityProjectId ??
  data.projectId ??
  data.backendProjectId ??
  data.userDefinedCloudaicompanionProject ??
  data.cloudaicompanionProject ??
  data.project;
```

…then `direct.id` when `direct` is an object, then recursion over the arrays
`["projects", "projectIds", "cloudaicompanionProjects"]`, accepting either nested objects or
bare strings.

Final precedence (L664–671):

```js
function resolveProjectId(options) {
  return (
    antigravityEnv("PROJECT_ID")?.trim() ||
    options.warmedProject ||
    options.credentialProjectId ||
    defaultProjectId(options.email || "antigravity-default")
  );
}
```

`loadCodeAssist` caches per token for `PROJECT_CACHE_TTL_MS = 30 * 60 * 1000` (L37, L648–662),
with LRU-ish re-insertion on hit and a 32-entry cap.

### 4.6 Chat request body — exact shape (`buildRequest`, L1729–1778)

```js
function buildRequest(options, model, projectId, runtimeModel, effort) {
  const request = {
    contents: convertMessages(options, model, runtimeModel),
    systemInstruction: {
      role: GEMINI_ROLE.user,
      parts: [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        { text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
        { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION },
        ...(options.system ? [{ text: sanitizeText(options.system) }] : []),
      ],
    },
  };
  const generationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (runtimeModel === "gemini-3.7-flash-tiered") {
    const selected = effort || "off";
    generationConfig.thinkingConfig = {
      thinkingLevel: selected === "high" || selected === "xhigh" ? "HIGH" : selected === "medium" ? "MEDIUM" : "LOW",
    };
  }
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  generationConfig.maxOutputTokens =
    options.maxTokens !== undefined
      ? Math.min(options.maxTokens, maxAllowed)
      : Math.min(maxAllowed, model.maxTokens || maxAllowed);
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const usesLegacyToolSchema = model.id.startsWith("claude-") || model.id.startsWith("gpt-oss-");
  const tools = convertTools(options.tools, usesLegacyToolSchema);
  if (tools) {
    request.tools = tools;
    if (model.id.startsWith("claude-")) {
      request.toolConfig = options.toolChoice
        ? { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } }
        : { functionCallingConfig: { mode: TOOL_CALLING_MODE.validated } };
    } else if (options.toolChoice) {
      request.toolConfig = { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } };
    }
  }
  if (options.sessionId) request.sessionId = String(options.sessionId);
  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: nowRequestId(),
  };
}
```

Resulting wire body:

```json
{
  "project": "<projectId>",
  "model": "<runtimeModel>",
  "requestType": "agent",
  "userAgent": "antigravity",
  "requestId": "antigravity-1750000000000-3f9a1c22b7d4",
  "request": {
    "contents": [
      { "role": "user",  "parts": [ { "text": "..." }, { "inlineData": { "mimeType": "image/png", "data": "<base64>" } } ] },
      { "role": "model", "parts": [ { "text": "..." }, { "thought": true, "text": "...", "thoughtSignature": "..." }, { "functionCall": { "name": "read_file", "args": { }, "id": "call_1" }, "thoughtSignature": "..." } ] },
      { "role": "user",  "parts": [ { "functionResponse": { "name": "read_file", "response": { "output": "..." }, "id": "call_1" } } ] }
    ],
    "systemInstruction": {
      "role": "user",
      "parts": [
        { "text": "<ANTIGRAVITY_SYSTEM_INSTRUCTION>" },
        { "text": "Please ignore following [ignore]<ANTIGRAVITY_SYSTEM_INSTRUCTION>[/ignore]" },
        { "text": "<ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION>" },
        { "text": "<options.system>" }
      ]
    },
    "generationConfig": { "temperature": 0.7, "maxOutputTokens": 65536, "thinkingConfig": { "thinkingLevel": "HIGH" } },
    "tools": [ { "functionDeclarations": [ { "name": "...", "description": "...", "parametersJsonSchema": { } } ] } ],
    "toolConfig": { "functionCallingConfig": { "mode": "VALIDATED" } },
    "sessionId": "<options.sessionId>"
  }
}
```

`requestId` format (L385–387): `` `antigravity-${Date.now()}-${randomBytes(6).toString("hex")}` ``.

Constants (L69–73):

```js
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";
const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/preamble preambles in the final response. Output only the final response.';
```

(Note the literal duplication `thinking/preamble preambles` in the source.)

The redundant `[ignore]…[/ignore]` system part is a prompt-injection-resistance trick copied
from Antigravity's own client: it tells the model to disregard the very instruction block it
was just given, which empirically suppresses the model echoing its system prompt.

Enums (L77–86):

```js
const GEMINI_ROLE = { user: "user", model: "model" };
const TOOL_CALLING_MODE = { none: "NONE", any: "ANY", auto: "AUTO", validated: "VALIDATED" };
```

### 4.7 Message conversion (L1468–1642)

| DSH input | Cloud Code Assist output |
|---|---|
| `role: "system"` message with content | `{ role: "user", parts: [ {text} ] }` (system text is *not* special-cased; only `options.system` goes to `systemInstruction`) |
| `role: "user"`, string content | one `{ role: "user", parts: [{ text }] }` |
| `role: "user"`, `{type:"text"}` blocks | `{ text }` parts |
| `role: "user"`, `{type:"image"}` blocks | `{ inlineData: { mimeType, data } }` (data-URL prefix parsed; default mime `image/png`) |
| `role: "assistant"`, `{type:"text"}` | `{ role: "model", parts: [{ text }] }` |
| `role: "assistant"`, `{type:"reasoning"}` | `{ thought: true, text, thoughtSignature }` **only** when replay state carries `thinkingSignature`; otherwise a plain `{ text }` |
| `role: "assistant"`, `{type:"tool-call"}` | `{ functionCall: { name, args, id? }, thoughtSignature? }` |
| `{type:"tool-result"}` block | appended as `{ role: "user", parts: [{ functionResponse }] }`, merged into the immediately preceding user turn when it already holds a `functionResponse` |

Tool-call ids are only sent for Claude/GPT (`toolCallIdNeeded`, L1484):

```js
function toolCallIdNeeded(modelId, runtimeModel) {
  return (
    modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("claude-") || runtimeModel.startsWith("gpt-oss-")
  );
}
```

Ids are sanitized to `[a-zA-Z0-9_-]`, capped at 64 chars, with a synthetic fallback
`${fallbackName}_${Date.now()}_${++toolCallCounter}` (L1478–1482).

All text passes through `sanitizeText` (L368–370), which replaces lone-surrogate code units
with `U+FFFD`:

```js
function sanitizeText(text) {
  return String(text ?? "").replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}
```

### 4.8 Tool schema conversion (L1644–1721)

`stripMetaSchema` recursively removes `$schema`, `$id`, `$anchor`, `$dynamicAnchor`,
`$vocabulary`, `$comment`, `$defs`, `definitions`. Then:

```js
const CUSTOM_TOOL_SCHEMA_ALLOW = new Set(["type", "description", "properties", "required", "items", "enum"]);

function normalizeCustomToolType(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.find((entry) => typeof entry === "string" && entry !== "null");
}

function convertTools(tools, useLegacyParameters) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = stripMetaSchema(tool.parameters);
        return {
          name: tool.name,
          description: tool.description,
          ...(useLegacyParameters
            ? { parameters: normalizeCustomToolSchema(schema) }
            : { parametersJsonSchema: schema }),
        };
      }),
    },
  ];
}
```

**Key wire difference:** Gemini models receive the full JSON Schema as
`parametersJsonSchema`; Claude/GPT (`gpt-oss-*`) receive a **whitelisted, recursively
normalized** `parameters` object (only `type`/`description`/`properties`/`required`/`items`/`enum`;
`enum` values must all be strings or the key is dropped; union types collapse to the first
non-`"null"` string).

`mapToolChoiceMode` (L1723–1727): `"none"→NONE`, `"any"|"required"→ANY`, everything else → `AUTO`.

**`[DRIFT]`** `options.toolChoice` does not exist on `GenerateOptions` in the installed
`dsh-llm@0.1.1-rc.2` (verified in `lib/types/types.d.ts:332-368`). It is therefore always
`undefined`, so: Claude always gets `VALIDATED`, and non-Claude models get **no** `toolConfig`
at all. A new plugin must not rely on `options.toolChoice`.

### 4.9 Model id resolution (ROUTING → dynamic → static fallback)

`[DRIFT]/[DESIGN]` Resolution happens **per stream call**, three layers deep:

```js
// L2574-2584
async function resolveRuntimeCandidates(token, projectId, model, effort) {
  const baseRuntimeModel =
    antigravityEnv("RUNTIME_MODEL")?.trim() || getAntigravityRequestModelId(model.id, effort);
  const dynamic = await fetchAvailableRuntimeModel(token, projectId, baseRuntimeModel);
  const initialRuntimeModel =
    dynamic?.id && isUsableRuntimeModelId(dynamic.id) ? dynamic.id : baseRuntimeModel;
  const runtimeCandidates = [initialRuntimeModel];
  const fallback = getFallbackRuntimeModel(initialRuntimeModel, effort);
  if (fallback && fallback !== initialRuntimeModel) runtimeCandidates.push(fallback);
  return runtimeCandidates;
}
```

**Layer 1 — static `ROUTING` table (L88–210).** Maps a *public* id + DSH `reasoningEffort`
to a *provider* runtime id. Shape:

```js
const ROUTING = {
  "claude-opus-4-6": {
    off: "claude-opus-4-6-thinking",
    routing: { minimal: "...", low: "...", medium: "...", high: "...", xhigh: "..." },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  // ...
};
```

Resolution (L1405–1431): `effort === undefined || "off"` → `route.off ?? route.routing?.high ?? route.defaultRequestId ?? modelId`;
`xhigh` → first of `routing.xhigh → high → medium → low → off → defaultRequestId`;
otherwise `routing[effort] → high → medium → low → off → defaultRequestId`.

Full table:

| Public model id | `off` | `minimal` | `low` | `medium` | `high` | `xhigh` | `defaultRequestId` |
|---|---|---|---|---|---|---|---|
| `claude-opus-4-6` | `claude-opus-4-6-thinking` | ″ | ″ | ″ | ″ | ″ | `claude-opus-4-6-thinking` |
| `claude-sonnet-4-6` | `claude-sonnet-4-6-thinking` | ″ | ″ | ″ | ″ | ″ | `claude-sonnet-4-6-thinking` |
| `gemini-3.7-flash` | `gemini-3.7-flash-tiered` | ″ | ″ | ″ | ″ | ″ | `gemini-3.7-flash-tiered` |
| `gemini-3.6-flash` | `gemini-3.6-flash-low` | `gemini-3.6-flash-low` | `gemini-3.6-flash-low` | `gemini-3.6-flash-medium` | `gemini-3.6-flash-high` | `gemini-3.6-flash-high` | `gemini-3.6-flash-high` |
| `gemini-3.5-flash` | `gemini-3.5-flash-extra-low` | `gemini-3.5-flash-extra-low` | `gemini-3.5-flash-low` | `gemini-3.5-flash-low` | `gemini-3-flash-agent` | `gemini-3-flash-agent` | `gemini-3-flash-agent` |
| `gemini-3.1-pro` | `gemini-3.1-pro-low` | `gemini-3.1-pro-low` | `gemini-3.1-pro-low` | `gemini-pro-agent` | `gemini-pro-agent` | `gemini-pro-agent` | `gemini-pro-agent` |
| `gemini-3.1-flash-image` | `gemini-3.1-flash-image` | ″ | ″ | ″ | ″ | ″ | `gemini-3.1-flash-image` |
| `gemini-3-flash` | `gemini-3-flash` | ″ | ″ | ″ | ″ | ″ | `gemini-3-flash` |
| `gemini-2.5-pro` | `gemini-2.5-pro` | ″ | ″ | ″ | ″ | ″ | `gemini-2.5-pro` |
| `gemini-2.5-flash` | `gemini-2.5-flash` | ″ | ″ | ″ | ″ | ″ | `gemini-2.5-flash` |
| `gpt-oss-120b` | `gpt-oss-120b-medium` | ″ | ″ | ″ | ″ | ″ | `gpt-oss-120b-medium` |

The `reasoningEfforts` array published by `listModels` is what the UI shows, and
`resolveReasoning` (L1460–1466) **clamps**: an unsupported effort falls back to `"high"`, else
the first declared effort, else `"high"`.

**Layer 2 — dynamic catalog lookup.** `fetchAvailableRuntimeModel(token, projectId, requestedRuntimeModel)`
(L831–855) caches `modelCache` per `token::projectId::requestedModel` for
`MODEL_CACHE_TTL_MS = 30 * 60 * 1000`, with an `inFlightModelLookups` de-dup map so
concurrent identical lookups share one promise. The uncached body (L792–829) posts
`{"project": projectId}` to `/v1internal:fetchAvailableModels` on every endpoint
**in parallel** (`Promise.all`), 8 s timeout each, then walks results calling
`findDynamicModel(data, requestedRuntimeModel)` (L750–790):

- Requires `isRecord(value.models)` and takes the **first** match.
- Fast path: exact key hit when `isUsableRuntimeModelId(requestedId) && requestedId in modelsMap`.
- Otherwise iterates `Object.entries(modelsMap)`, skipping ids failing
  `isUsableRuntimeModelId` (`/^(gemini-|claude-|gpt-oss-)/i` and no whitespace and not
  `/^MODEL_/i`, L706–708), testing `buildModelMatchRegex(requestedId)` against the **id**
  then against `info.label ?? info.displayName ?? info.name`.
- `buildModelMatchRegex` (L710–734) is a hand-written ladder of special cases
  (tier suffixes map to `"Gemini 3.x Flash (low|medium|high)"` display text; Claude/GPT match
  `claude.*opus.*4\.6`, `claude.*sonnet.*4\.6`, `gpt.*oss.*120b`), with a generic
  `escapeRegExp(requested).replace(/\\-/g, "[- ]")` fallback.
- Returns `{ id, experiments, apiProvider, modelProvider }` via `dynamicModelFromInfo` (L736–748),
  which also records `diagnostics.matchedModelDebug` from `summarizeModelCandidate`
  (secrets/emails filtered, values truncated at 1200 chars).

**Layer 3 — hard-coded downgrade fallback** (L1433–1442):

```js
function getFallbackRuntimeModel(runtimeModel, effort) {
  if (runtimeModel === "gemini-3.7-flash-tiered") {
    return getAntigravityRequestModelId("gemini-3.6-flash", effort);
  }
  if (runtimeModel.startsWith("gemini-3.7-flash-")) {
    return runtimeModel.replace("gemini-3.7-flash-", "gemini-3.6-flash-");
  }
  if (runtimeModel === "gemini-3.7-flash") return "gemini-3.6-flash-low";
  return undefined;
}
```

This exists because `gemini-3.7-flash` may be unavailable; on `404` the candidate loop
advances to the 3.6 id (L2642).

**Retry matrix** (`requestAntigravityChunks`, L2619–2662) — three nested loops:

```js
for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {          // empty-response retries
  if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED");
  if (emptyAttempt > 0) {
    const delay = 500 * 2 ** (emptyAttempt - 1);                        // 500ms, 1000ms
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  for (let candidateIndex = 0; candidateIndex < runtimeCandidates.length; candidateIndex++) {
    runtimeModel = runtimeCandidates[candidateIndex];
    setLastResolvedRuntimeModel(runtimeModel);
    const body = JSON.stringify(buildRequest(options, model, projectId, runtimeModel, effort));
    for (const endpoint of endpointCandidates()) {                      // endpoint failover
      setLastEndpoint(endpoint);
      response = await fetchStreamResponse(endpoint, requestHeaders, body, signal);
      setLastStatus(response.status);
      if (response.ok) break;
      lastText = await response.text();
      if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
      if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
    }
    if (response?.ok) break;
    if (response?.status === 404 && candidateIndex + 1 < runtimeCandidates.length) continue;
    break;
  }
  if (!response || !response.ok) { /* throw friendly LlmError */ }
  const state = createStreamState();
  for await (const chunk of streamResponseToChunks(response, model, runtimeModel, state)) yield chunk;
  if (state.hasContent) return;                                          // else retry the whole thing
}
throw new LlmError("Antigravity API returned an empty response", EMPTY_RESPONSE_CODE);
```

Retryable statuses for endpoint failover: **403, 404, 429, 500, 502, 503, 504**. Everything
else fails immediately. `429` + `/Individual quota reached/i` short-circuits the endpoint loop.

### 4.10 Error classification

`classifyAntigravityError` (L1790–1800) maps message text → DSH code:

| Pattern | Code |
|---|---|
| `\b(?:401|403)\b` | `AUTH` |
| `isQuotaExceededError(message)` | `QUOTA_EXCEEDED_CODE` (= `"QUOTA"`) |
| `\b429\b` or `/rate.?limit/i` | `RATE_LIMIT` |
| `\b400\b` or `/invalid.?request/i` | `INVALID_REQUEST` |
| `\b5\d\d\b` | `SERVER` |
| `/time(?:d)?\s*out\b¦timeout/i` | `TIMEOUT` |
| `/stream ended (?:before¦without)\b/i` | `TRANSPORT` |
| `/network¦connection¦socket¦fetch¦ECONN[A-Z]+/i` | `TRANSPORT` |
| otherwise | `ANTIGRAVITY_ERROR` |

`friendlyAntigravityError(status, text)` (L1802–1830) produces user-facing copy per status
(400/401/403/404/408/409/429/500/502/503/504), extracting a `Resets? in …` hint from 429
bodies and special-casing `No capacity available` on 503. `jsonOrTextError` prefers
`body.error.message` over raw text.

---

## 5. Streaming response handling

### 5.1 Wire format

**Server-Sent Events.** Request:

```js
// L2586-2599
async function fetchStreamResponse(endpoint, headers, body, signal) {
  try {
    return await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body,
      signal,
    });
  } catch (error) {
    setLastError(error);
    if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error });
    throw error;
  }
}
```

The `?alt=sse` query parameter is what selects SSE over the default JSON-array encoding.
Request `Accept: text/event-stream`. One JSON object per `data:` line; the stream may or may
not end with `data: [DONE]` (the parser tolerates both). No `event:` field handling, no
multi-line `data:` continuation joining, no `id:`/`retry:` handling — Gemini never emits them.

### 5.2 The byte → line → JSON loop — exact code (L1965–2015)

```js
async function* streamResponseToChunks(response, model, runtimeModel, state) {
  if (!response.body) throw new LlmError("Antigravity response has no body", "TRANSPORT");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitLine = (line) => processStreamLine(line.replace(/\r$/, ""), state);
  const emitBufferedLines = function* () {
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      yield* emitLine(line);
    }
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) continue;
    buffer += decoder.decode(result.value, { stream: true });
    yield* emitBufferedLines();
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield* emitLine(buffer.trimEnd());
    buffer = "";
  }

  if (state.currentBlock) {
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      yield { type: "block-end", index, block: { type: "text", text: state.currentBlock.text } };
    } else {
      yield {
        type: "block-end",
        index,
        block: { type: "reasoning", text: state.currentBlock.text },
      };
    }
    state.currentBlock = null;
  }

  if (!state.hasContent) return;
  yield { type: "usage", usage: mapUsage(state.usage || {}) };
  yield {
    type: "finish",
    reason: finishReasonOf(state.finishReason, state.hasToolCall, state.hasContent),
    replayState: replayStateOf(model, runtimeModel, state.replayBlocks),
  };
}
```

Notes: `TextDecoder` is created without `{ fatal: false }` (default) and reused across the
whole stream so multi-byte UTF-8 sequences split across TCP frames are handled correctly by
`{ stream: true }`; the trailing `decoder.decode()` flush emits any final partial sequence;
`\r` is stripped only at end-of-line; a trailing line without `\n` is still processed.

### 5.3 The SSE-line → DSH-event parser (L1866–1963)

```js
function processStreamLine(line, state) {
  if (!line.startsWith("data:")) return [];
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return [];
  const chunk = safeJsonParse(json);
  if (!isRecord(chunk)) return [];
  if (isRecord(chunk.error)) {
    const message = chunk.error.message || JSON.stringify(chunk.error);
    throw new LlmError(String(message), classifyAntigravityError(String(message)));
  }
  const responseData = isRecord(chunk.response) ? chunk.response : chunk;
  const candidate = Array.isArray(responseData.candidates) ? responseData.candidates[0] : undefined;
  const parts = isRecord(candidate?.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const out = [];

  const closeCurrentBlock = () => {
    if (!state.currentBlock) return;
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      out.push({ type: "block-end", index, block: { type: "text", text: state.currentBlock.text } });
    } else {
      out.push({ type: "block-end", index, block: { type: "reasoning", text: state.currentBlock.text } });
    }
    state.currentBlock = null;
  };

  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.text !== undefined) {
      const isThinking = part.thought === true;
      const blockType = isThinking ? "reasoning" : "text";
      if (!state.currentBlock || state.currentBlock.type !== blockType) {
        closeCurrentBlock();
        state.currentBlock = { type: blockType, text: "", thinkingSignature: undefined, textSignature: undefined };
        state.blocks.push(state.currentBlock);
        state.replayBlocks.push({ type: blockType });
        out.push({ type: "block-start", index: state.blocks.length - 1, blockType });
      }
      const delta = sanitizeText(part.text);
      state.currentBlock.text += delta;
      state.hasContent = true;
      if (isThinking && part.thoughtSignature) {
        state.currentBlock.thinkingSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].thinkingSignature = part.thoughtSignature;
      } else if (!isThinking && part.thoughtSignature) {
        state.currentBlock.textSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].textSignature = part.thoughtSignature;
      }
      out.push({ type: isThinking ? "reasoning-delta" : "text-delta", index: state.blocks.length - 1, text: delta });
    }
    if (isRecord(part.functionCall)) {
      closeCurrentBlock();
      const toolName = asString(part.functionCall.name) || "";
      const toolId = sanitizeToolCallId(part.functionCall.id || "", toolName);
      const args = isRecord(part.functionCall.args) ? part.functionCall.args : {};
      const argsText = JSON.stringify(args);
      const index = state.blocks.length;
      const block = { type: "tool-call", id: CallId(toolId), name: toolName, arguments: argsText };
      state.blocks.push(block);
      state.replayBlocks.push({
        type: "tool-call",
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      });
      state.hasContent = true;
      state.hasToolCall = true;
      out.push({ type: "block-start", index, blockType: "tool-call" });
      out.push({
        type: "tool-call-delta",
        index,
        id: CallId(toolId),
        ...(toolName ? { name: toolName } : {}),
        argumentsDelta: argsText,
      });
      out.push({ type: "block-end", index, block });
    }
  }

  if (candidate?.finishReason) state.finishReason = candidate.finishReason;
  if (isRecord(responseData.usageMetadata)) state.usage = responseData.usageMetadata;
  return out;
}
```

Response envelope tolerance: the parser accepts either the raw
`{"candidates":[...],"usageMetadata":{...}}` shape **or** the Vertex-style wrapped
`{"response": { ... }}` shape, via `const responseData = isRecord(chunk.response) ? chunk.response : chunk;`.
Only `candidates[0]` is read (multi-candidate never happens here).

Tool calls are **not** streamed incrementally — the whole `functionCall` arrives in one part,
so the plugin emits `block-start` → `tool-call-delta` (with the complete JSON as
`argumentsDelta`) → `block-end` back-to-back. Text/reasoning are genuinely incremental.

`JSON.stringify(args)` ordering is preserved from the provider payload since `args` is used as
a plain object.

### 5.4 State object (L2017–2027)

```js
function createStreamState() {
  return {
    blocks: [], replayBlocks: [], currentBlock: null,
    finishReason: undefined, usage: undefined,
    hasContent: false, hasToolCall: false,
  };
}
```

### 5.5 Event mapping table

| Cloud Code Assist wire element | DSH `StreamChunk` emitted |
|---|---|
| first `part.text` with `part.thought !== true` | `{ type: "block-start", index, blockType: "text" }` |
| subsequent `part.text`, non-thought | `{ type: "text-delta", index, text }` |
| first `part.text` with `part.thought === true` | `{ type: "block-start", index, blockType: "reasoning" }` |
| subsequent thought `part.text` | `{ type: "reasoning-delta", index, text }` |
| block type switches, or `functionCall` encountered | `{ type: "block-end", index, block: { type: "text"\|"reasoning", text } }` |
| `part.functionCall` | `{ type: "block-start", index, blockType: "tool-call" }` then `{ type: "tool-call-delta", index, id, name?, argumentsDelta }` then `{ type: "block-end", index, block: { type:"tool-call", id, name, arguments } }` |
| `responseData.usageMetadata` (accumulated, last wins) | `{ type: "usage", usage: { inputTokens, outputTokens, cacheReadTokens? } }` |
| end of stream | `{ type: "finish", reason, replayState }` |

Usage mapping (L1780–1788):

```js
function mapUsage(usage) {
  const inputTokens = Math.max(0, (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0));
  const outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  return {
    inputTokens,
    outputTokens,
    ...(usage.cachedContentTokenCount > 0 ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
  };
}
```

Fields read: `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`,
`thoughtsTokenCount`. Fields **not** populated: `cacheWriteTokens`, `reasoningTokens` (both
exist on the installed `TokenUsage`).

Finish mapping (L1836–1853):

```js
function finishReasonOf(rawReason, hasToolCall, hasContent, errorMessage) {
  if (errorMessage && isContextWindowExceededError(errorMessage)) {
    return { kind: "error", failure: { message: errorMessage, code: CONTEXT_WINDOW_EXCEEDED_CODE } };
  }
  if (!hasContent) {
    return { kind: "error", failure: { message: "Antigravity returned a completed response with no content", code: EMPTY_RESPONSE_CODE } };
  }
  if (hasToolCall) return { kind: "tool-calls" };
  if (rawReason === "MAX_TOKENS") return { kind: "max-tokens" };
  if (!rawReason || rawReason === "STOP") return { kind: "stop" };
  return { kind: "error", failure: { message: `Antigravity finished with reason ${rawReason}`, code: "ANTIGRAVITY_FINISH_REASON" } };
}
```

Wire `finishReason` → DSH `kind`: `STOP`/absent → `stop`; `MAX_TOKENS` → `max-tokens`;
`hasToolCall` overrides everything → `tool-calls`; any other non-empty reason → `error`
with code `ANTIGRAVITY_FINISH_REASON`.

**Dead branches (documented, not bugs to copy):** the call site passes only three arguments
(`finishReasonOf(state.finishReason, state.hasToolCall, state.hasContent)`), so `errorMessage`
is always `undefined` and the `CONTEXT_WINDOW_EXCEEDED` branch is unreachable. The
`!hasContent` branch is also unreachable from this path because `streamResponseToChunks`
already returns early on `!state.hasContent` before yielding `finish`.

### 5.6 Replay state

```js
// L1855-1864
function replayStateOf(model, runtimeModel, replayBlocks) {
  return {
    kind: "antigravity",
    version: 1,
    provider: PROVIDER,
    model: model.id,
    runtimeModel,
    blocks: replayBlocks,
  };
}
```

Per-block replay entries: `{ type: "text" }`, `{ type: "reasoning", thinkingSignature? }`,
`{ type: "tool-call", thoughtSignature? }`. Read back by `replayBlockFor` (L1547–1556):

```js
function replayBlockFor(message, index) {
  const source = message.source;
  if (!source || source.kind !== "model") return undefined;
  const state = source.replayState;
  if (!isRecord(state)) return undefined;
  if (state.kind !== "antigravity" || state.version !== 1) return undefined;
  if (state.provider !== PROVIDER || state.model !== source.model) return undefined;
  if (!Array.isArray(state.blocks)) return undefined;
  return state.blocks[index];
}
```

The guard `state.model !== source.model` is the important one: it drops replay metadata whose
public model id no longer matches, so a model switch mid-session does not inject stale
signatures. `blocks[index]` is positional against `message.content[index]` — a fragile but
cheap contract.

Signatures consumed: `thinkingSignature` (reasoning → re-emitted as `thoughtSignature` inside
`{ thought: true, ... }`) and `thoughtSignature` (tool-call → merged alongside `functionCall`).
**`textSignature` is written to `replayBlocks` (L1925) but never read** — dead metadata.

**`[DRIFT]`** The installed `dsh-llm@0.1.1-rc.2` declares
`finish.replayState?: ReplayEnvelope` = `{ response: unknown; blocks?: readonly unknown[] }`
(`lib/types/types.d.ts:266-278, 315-316`) and its assembler aligns `blocks` positionally
against emitted blocks. The plugin instead puts everything at the top level with `kind`/
`version`/`provider`/`model`/`runtimeModel`/`blocks` and no `response`. A new plugin targeting
the current runtime must either keep its adapter-private payload under `response` or confirm
the runtime still passes unknown state through unchanged.

### 5.7 Idle-timeout wrapper (`AntigravityAdapter.stream`, L2706–2746)

```js
const STREAM_IDLE_TIMEOUT_MS = 300000;                       // L34
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";   // L35
```

```js
async *stream(options) {
  const settings = await this.#modelSettings.read();
  const model = modelFromSettings(settings, options.model);

  const consumer = new AbortController();
  const upstream =
    options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
  const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE);
  const iterator = requestAntigravityChunks(options, model, watchdog.signal, this.#store)[Symbol.asyncIterator]();

  let exhausted = false;
  try {
    while (true) {
      const result = await watchdog.next(iterator);
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`antigravity stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT");
      }
      if (result.done) { exhausted = true; return; }
      yield result.value;
    }
  } catch (error) {
    if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
      throw new LlmError(`antigravity stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT", { cause: error });
    }
    if (options.signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error });
    throw error;
  } finally {
    consumer.abort("antigravity stream consumer stopped");
    if (!exhausted) {
      try { await iterator.return(undefined); } catch { /* ... */ }
    }
    watchdog[Symbol.dispose]();
  }
}
```

This is the single most reusable piece of the plugin: `idleWatchdog` only arms its timer while
a `next()` demand is outstanding, so consumer think-time is not counted as provider idle time,
while the whole chain shares one abort signal (`AbortSignal.any`). `watchdog.next(iterator)`
wraps the demand; `timeoutOf(signal, code)` distinguishes *this* deadline from a foreign abort.

---

## 6. Model catalog

### 6.1 Static list (L237–326) — the authoritative table

| `id` | `name` | `inputModalities` | `contextWindow` | `maxTokens` | `reasoningEfforts` | Quota pool (README) |
|---|---|---|---|---|---|---|
| `gemini-3.7-flash` | Gemini 3.7 Flash | `["text","image"]` | 1048576 | 65536 | `["low","medium","high"]` | Gemini |
| `gemini-3.6-flash` | Gemini 3.6 Flash | `["text","image"]` | 1048576 | 65536 | `["low","medium","high"]` | Gemini |
| `gemini-3.5-flash` | Gemini 3.5 Flash | `["text","image"]` | 1048576 | 65536 | `["low","medium","high"]` | Gemini |
| `gemini-3.1-pro` | Gemini 3.1 Pro | `["text","image"]` | 1048576 | 65535 | `["low","high"]` | Gemini |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | `["text","image"]` | 1048576 | 65536 | `["low","medium","high"]` | Gemini |
| `gemini-3-flash` | Gemini 3 Flash | `["text","image"]` | 1048576 | 65536 | `["low","medium","high"]` | Gemini |
| `gemini-2.5-pro` | Gemini 2.5 Pro | `["text","image"]` | 1048576 | 65536 | `["low","high"]` | Gemini |
| `gemini-2.5-flash` | Gemini 2.5 Flash | `["text","image"]` | 1048576 | 65536 | `["low","medium","high"]` | Gemini |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | `["text","image"]` | 200000 | 64000 | `["high"]` | Claude & GPT (3P) |
| `claude-opus-4-6` | Claude Opus 4.6 | `["text","image"]` | 250000 | 64000 | `["high"]` | Claude & GPT (3P) |
| `gpt-oss-120b` | GPT-OSS 120B | `["text"]` | 131072 | 32768 | `["medium"]` | Claude & GPT (3P) |

Declaration order is exactly the order above; `claude-sonnet-4-6` precedes `claude-opus-4-6`
in the array, but `compareAntigravityModels` re-sorts for display.

**Note the plural key:** the static list uses `contextWindow`, and `listModels`/
`resolveModel` translate it into the DSH shape `context: { contextWindow }`.

Quota pooling is **not** encoded in the plugin as a data structure. The grouping is derived:
group membership comes from `retrieveUserQuotaSummary().groups` (two groups returned by the
backend), and the client merely color-codes a group cyan when
`/claude|gpt|3p|openai|anthropic/i` matches its `displayName`+`description`
(`lib/client.js:595`). `MODELS` order and the README's pool column are documentation only.

### 6.2 Runtime output caps (L212–235)

```js
const RUNTIME_MAX_OUTPUT_TOKENS = {
  "gemini-3.7-flash": 65536, "gemini-3.7-flash-tiered": 65536,
  "gemini-3.7-flash-low": 65536, "gemini-3.7-flash-medium": 65536, "gemini-3.7-flash-high": 65536,
  "gemini-3.6-flash": 65536, "gemini-3.6-flash-low": 65536,
  "gemini-3.6-flash-medium": 65536, "gemini-3.6-flash-high": 65536,
  "gemini-3.5-flash": 65536, "gemini-3.5-flash-extra-low": 65536, "gemini-3.5-flash-low": 65536,
  "gemini-3-flash-agent": 65536,
  "gemini-3.1-pro": 65535, "gemini-3.1-pro-low": 65535, "gemini-3.1-pro-high": 65535,
  "gemini-pro-agent": 65535,
  "claude-opus-4-6": 64000, "claude-opus-4-6-thinking": 64000,
  "claude-sonnet-4-6": 64000,
  "gpt-oss-120b": 32768, "gpt-oss-120b-medium": 32768,
};
```

`getMaxOutputTokens(modelId, runtimeModel)` (L1389–1403) prefers the runtime id, then the
public id, then a prefix guess (`claude-`→64000, `gpt-oss-`→32768, `gemini-3.1-pro*`/`gemini-pro-agent`→65535,
other `gemini-`→65536), defaulting to **8192**. The final value sent is
`min(options.maxTokens ?? model.maxTokens, maxAllowed)`.

### 6.3 Dynamic catalog merge (`parseCatalogModels`, L1194–1265)

Input: the merged `fetchAvailableModels` payload (`fetchMergedAvailableModels`, L946–975).

**`fetchMergedAvailableModels`** posts to *every* endpoint in parallel and shallow-merges:

```js
if (isRecord(result.data) && isRecord(result.data.models)) {
  Object.assign(mergedModels, result.data.models);
}
if (isRecord(result.data) && typeof result.data.defaultAgentModelId === "string") {
  defaultAgentModelId = result.data.defaultAgentModelId;
}
```

(later endpoints win on key collision; the *last successful* endpoint/status is what gets
recorded in diagnostics). Returns `{ endpoint, status, data: { models: mergedModels, defaultAgentModelId } }`
and throws `"/v1internal:fetchAvailableModels failed: no endpoint available"` when nothing
succeeded.

**Raw filtering:** skip `!isRecord(infoRaw)`, `infoRaw.isInternal`, ids starting with `chat_`
or `tab_`, and ids failing `isUsableRuntimeModelId`. Each survivor becomes:

```js
rawModels.push({
  id: modelId,
  name: inferred.name,
  inputModalities: inferred.inputModalities,
  contextWindow: inferred.contextWindow,
  maxTokens: inferred.maxTokens,
  reasoningEfforts: inferred.reasoningEfforts,
  available: true,
  remainingFraction: clampFraction(quotaInfo.remainingFraction),
  resetTime: quotaInfo.resetTime ? String(quotaInfo.resetTime) : undefined,
  modelProvider: typeof infoRaw.modelProvider === "string" ? infoRaw.modelProvider
    : typeof infoRaw.apiProvider === "string" ? infoRaw.apiProvider : undefined,
});
```

**`inferModelShape(modelId, info)`** (L1126–1163) — returns the static entry when the id is
known (`modelById`), else infers:

| Inferred field | Rule |
|---|---|
| `inputModalities` | `["text","image"]` when `info.supportsImages` or id matches `/gemini¦claude/i`, else `["text"]` |
| `reasoningEfforts` | `gpt-oss`→`["medium"]`; `claude`→`["high"]`; `/pro/`→`["low","high"]`; `gemini`→`["low","medium","high"]`; else `[]` |
| `contextWindow` | `claude`→200000, `gpt-oss`→131072, else 1048576 |
| `maxTokens` | `getMaxOutputTokens(id, id)` |
| `name` | `info.displayName ?? info.label ?? info.modelName ?? modelNameFromId(id)`; special case `gemini-3.7-flash-tiered` → `"Gemini 3.7 Flash"`; if the id's version and the name's version disagree, the name is regenerated from the id |

`modelNameFromId` (L1118–1124) title-cases `-`/`_` separators and fixes `Gpt`→`GPT`, `Oss`→`OSS`.

**Consolidation:** for each static `MODELS` entry, `baseModelMatcher(base.id)` (L1165–1192) is
applied to both `rawModels[].id` and `.name`:

| Base id | Matcher regex |
|---|---|
| `gemini-3.7-flash` | `/gemini[- ]3\.7[- ]flash/i` |
| `gemini-3.6-flash` | `/gemini[- ]3\.6[- ]flash/i` |
| `gemini-3.5-flash` | `/gemini[- ]3\.5[- ]flash¦gemini[- ]3[- ]flash[- ]agent/i` |
| `gemini-3.1-pro` | `/gemini[- ]3\.1[- ]pro¦gemini[- ]pro[- ]agent/i` |
| `gemini-3.1-flash-image` | `/gemini[- ]3\.1[- ]flash[- ]image/i` |
| `gemini-3-flash` | `/^gemini[- ]3[- ]flash$/i` |
| `gemini-2.5-pro` | `/gemini[- ]2\.5[- ]pro/i` |
| `gemini-2.5-flash` | `/gemini[- ]2\.5[- ]flash¦gemini[- ]3\.1[- ]flash[- ]lite/i` |
| `claude-sonnet-4-6` | `/claude[- ]sonnet/i` |
| `claude-opus-4-6` | `/claude[- ]opus/i` |
| `gpt-oss-120b` | `/gpt[- ]oss/i` |
| default | case-insensitive substring of the base id |

The public entry **always wins** its name/modalities/context/maxTokens/reasoningEfforts (the
static definition), but inherits `remainingFraction`/`resetTime`/`modelProvider` from the
matching raw entry — preferring the first match that actually has a numeric
`remainingFraction`. Unmatched raw models are appended verbatim. Finally
`consolidated.sort(compareAntigravityModels)`.

**Sort order** (`compareAntigravityModels`, L1094–1109): family (`gemini`=1, `claude`=2,
`gpt`=3, else 4) → version descending (`extractModelVersion` pulls the first numeric version
from id, else name) → variant score (ultra=1, pro=2, flash=3, flash+thinking=4, image=5,
lite=6, lite+thinking=7, else 10) → `name` then `id` locale compare.
`compareAntigravityModelOptions` (L1111–1116) puts `enabled` models **first**, then applies
the above.

### 6.4 How `listModels` resolves at runtime (L2678–2704)

```js
  async listModels(provider) {
    const settings = await this.#modelSettings.read();
    return configuredModels(settings).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    }));
  }
```

with

```js
function reasoningInfo(model) {
  if (!model.reasoningEfforts.length) return {};
  return {
    reasoning: {
      efforts: model.reasoningEfforts.map((level) => ({
        id: ReasoningEffortId(level),
        name: level.charAt(0).toUpperCase() + level.slice(1),
      })),
    },
  };
}
```

`configuredModels` = `catalogModelsOf(settings)` ∩ `enabledModelIds`, sorted. `catalogModelsOf`
falls back to the static `MODELS` array when the stored catalog is empty — so the plugin
advertises all 11 models before the first successful quota fetch. A settings **file read
happens on every `listModels` and every `stream` call** (no in-memory cache).

`resolveModel(provider, modelId, signal)` uses `modelFromSettings`, which will still resolve
a **disabled** model via `catalogModelsOf(...).find(...) || modelById(...) || inferModelShape(...)`,
and emits an `"ABORTED"` `LlmError` when `signal.aborted` at entry (L2692).

---

## 7. Quota

### 7.1 Fetch (`fetchAccountQuota`, L1277–1335)

```js
export async function fetchAccountQuota(store = new FileCredentialStore(), modelSettings) {
  const { token, projectId: credentialProjectId } = await ensureApiKey(store);
  const [assistResult, summary] = await Promise.all([
    postJson("/v1internal:loadCodeAssist", token, {
      metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
    }).catch(() => null),
    postJson("/v1internal:retrieveUserQuotaSummary", token, {}),
  ]);
  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({ credentialProjectId, warmedProject: discoveredProject ?? null });
  setLastProjectId(projectId);

  const available = await fetchMergedAvailableModels(token, projectId);
  const { groups, description } = parseQuotaSummary(summary.data);
  const { models, defaultAgentModelId } = parseModels(available.data);
  const catalogModels = parseCatalogModels(available.data);
  const assistData = isRecord(assistResult?.data) ? assistResult.data : {};
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;
  cachedQuota = { projectId, endpoint: summary.endpoint, productTier, paidTier, planLabel, groups,
    groupDescription: description, models, catalogModels, defaultAgentModelId, fetchedAt: Date.now() };
  // ... persists catalogModels into modelSettings
  return cachedQuota;
}
```

`postJson(path, token, body)` (L890–920) iterates endpoints, uses `jsonHeaders`, parses text →
`JSON.parse` or `{ raw: text }`, and **fails over on 403/404/429/500/502/503/504** (any other
status throws immediately with `\`${path} failed (${status}): …\`` truncated to 300 chars).
Exhausting all endpoints throws `` `${path} failed: ${lastErrorText || "no endpoint available"}` ``.

### 7.2 Response fields consumed

`parseQuotaSummary(data)` (L977–1007):

| Wire path | Used as |
|---|---|
| `data.description` | `groupDescription` |
| `data.groups[]` | one quota group |
| `groups[].displayName` | `displayName` (fallback `"Quota group"`) |
| `groups[].description` | `description` |
| `groups[].buckets[]` | the 5-hour / weekly limits |
| `buckets[].bucketId` | `bucketId` (fallback `displayName`, then `"unknown"`) |
| `buckets[].displayName` | `displayName` (fallback `bucketId`, then `"Limit"`) |
| `buckets[].window` | `window` (string; e.g. the window duration label) |
| `buckets[].resetTime` | `resetTime` (ISO-8601 string) |
| `buckets[].description` | `description` |
| `buckets[].remainingFraction` | `remainingFraction`, clamped to `[0,1]` |

A bucket is kept when `clampFraction(bucket.remainingFraction)` is defined **or**
`bucket.bucketId` is truthy; a group is kept when it has buckets **or** a `displayName`.
`clampFraction` (L857–862) returns `0`/`1` for out-of-range finite numbers and `undefined`
for non-numbers/NaN.

`parseModels(data)` (L1009–1048) is the **per-model** view (distinct from `parseCatalogModels`):
it skips non-records, `isInternal`, and `chat_*` ids, and reads `displayName`→`label`→`modelName`,
`quotaInfo.remainingFraction`, `quotaInfo.resetTime`, `modelProvider`→`apiProvider`,
`supportsThinking`, `supportsImages`, `recommended`; sorted by `modelId.localeCompare`; plus
`defaultAgentModelId` (falls back to `defaultAgentModel`).

`parseTier(value)` (L1267–1275) reads `{ id, name, description }`, requiring at least `id` or `name`.

### 7.3 How quota is cached and surfaced

`cachedQuota` is a single module-global (L341), reset to `undefined` on login success
(L2327) and on logout (L3010). `getCachedQuota()` returns it.

**Host API payload** — `quotaCardRows(quota)` (L2780–2823) produces three views:

```json
{
  "modelRows":  [ { "id","label","remainingPercent","remainingFraction","resetLabel","resetTime","provider","recommended","supportsThinking","supportsImages" } ],
  "bucketRows": [ { "id","label","group","window","remainingPercent","remainingFraction","resetLabel","resetTime","description" } ],
  "groups":     [ { "displayName","description","buckets":[ { "id","label","window","remainingPercent","remainingFraction","resetLabel","resetTime","description" } ] } ],
  "groupDescription": "…"
}
```

`remainingPercent = Math.round(remaining * 1000) / 10` (one decimal place, L864–867).
`formatReset(resetTime)` (L875–888) diffs `Date.parse(resetTime)` against now and renders
`"now"`, `"<d>d <h>h"`, `"<h>h <m>m"` or `"<m>m"`; unparseable input is passed through
verbatim; missing input is `"n/a"`.

**Per-model quota fallback** for the model selector
(`publicModelMatchNeedles` L2825–2844, `rowsForPublicModel` L2846–2854,
`publicModelQuotaSummary` L2856–2872): when `catalogModels` has no entry for a public id, the
plugin searches `modelRows` for needle strings and takes the **best remainingFraction** row:

| Public id | Needles |
|---|---|
| `gemini-3.7-flash` | `gemini-3.7-flash`, `gemini 3.7 flash` |
| `gemini-3.6-flash` | `gemini-3.6-flash`, `gemini 3.6 flash` |
| `gemini-3.5-flash` | `gemini-3.5-flash`, `gemini 3.5 flash`, `gemini-3-flash-agent` |
| `gemini-3.1-pro` | `gemini-3.1-pro`, `gemini 3.1 pro`, `gemini-pro-agent` |
| `claude-sonnet-4-6` | `claude-sonnet-4-6`, `claude sonnet 4.6` |
| `claude-opus-4-6` | `claude-opus-4-6`, `claude opus 4.6` |
| `gpt-oss-120b` | `gpt-oss-120b`, `gpt oss 120b` |

`modelOptionsPayload(settings, quota)` (L2874–2909) builds the selector payload — catalog
quota wins when `catalogModels[].remainingFraction !== undefined`, else the `modelRows`
fallback:

```json
{
  "enabledModelIds": ["…"],
  "options": [ { "id","name","inputModalities","reasoningEfforts","enabled",
                 "available"?,"remainingFraction"?,"remainingPercent"?,"resetLabel"?,"resetTime"? } ]
}
```

Sorted by `compareAntigravityModelOptions` (enabled first).

**Text rendering** for the CLI/diagnostics path — `formatQuotaSummary(quota)` (L1341–1387)
draws `progressBar(remaining, width = 20)` as `[#####-----]` and one line per model, ending
with the caveat `"Note: remaining % is pool-shared, not a private per-model budget."`
(**exported but never called anywhere in the package**).

### 7.4 Quota persistence side effect

`fetchAccountQuota` writes the live catalog into the settings file (L1324–1332):

```js
  if (modelSettings) {
    const current = await modelSettings.read();
    const isFirstTime = current.catalogModels.length === 0 && current.enabledModelIds.length === 0;
    const catalogIds = new Set(catalogModels.map((m) => m.id));
    const mergedEnabled = isFirstTime
      ? catalogModels.map((m) => m.id)
      : current.enabledModelIds.filter((id) => catalogIds.has(id));
    await modelSettings.setCatalogModels(catalogModels, { enabledModelIds: mergedEnabled });
  }
```

First-ever fetch enables **every** discovered model; afterwards, enabled ids not present in
the new catalog are **dropped** (note: ids the user disabled are also gone from
`enabledModelIds`, so disabling is stable — but a model that temporarily disappears from the
catalog and later returns will come back disabled).

---

## 8. DSH integration surface

### 8.1 Services and hooks used

| API | Where | Purpose |
|---|---|---|
| `ctx.llm.registerAdapter([PROVIDER], adapter)` | L3028 | Register the `LlmAdapter` for the `antigravity` route |
| `ctx.emit("llm/adapters-updated")` | L2943 | Force the model picker to re-read `listModels` after a settings/quota change |
| `ctx.inject(["webServer"], (webCtx) => …)` | L2950 | Wait for the web server service |
| `webCtx.effect(() => webCtx.webServer.register({…}), "dsh-antigravity: web api")` | L2951–3020 | Register the HTTP route with fiber-scoped disposal |
| `apply.inject = ["llm"]` / `export const inject = ["llm"]` | L32, L3032 | Declare the hard dependency |
| `@deepseek-ai/dsh-home-paths` `dshHomePath` | L347, L351 | Resolve `$DSH_HOME` paths |
| `@deepseek-ai/dsh-timeout` `idleWatchdog`, `timeoutOf` | L2713–2744 | Stream idle deadline |

**There is no `Config` schema and no `ctx.command`/`ctx.tool`/`ctx.hook` usage** beyond
`ctx.emit`. No `directory`/`registerConfigurableProviders`, no `registerModelDiscovery`, no
`prepareCall`, no `providerRetryPolicy`.

Verified against the installed `dsh-llm@0.1.1-rc.2`:

- `LlmRuntime.registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle`
  — throws `LlmError` code `DUPLICATE_ADAPTER` on conflict; disposed with the fiber; the
  returned handle is callable as a disposer and carries `.replace(providers: string[])`.
  **The plugin discards the handle** (L3028), relying on fiber disposal.
- `'llm/adapters-updated'(): void` is a real `emit` event on the Cordis `Events` interface
  (`lib/types/types.d.ts:21`), and `LlmRuntime.emitAdaptersUpdated` / `commitRoutes` publish
  it. So the manual `ctx.emit` at L2943 is redundant for registration changes but is
  legitimately how a settings write notifies the picker.
- `LlmAdapter` abstract members: only `stream(options)` is abstract. `providerInfo(provider)`,
  `providerRetryPolicy(provider)`, `listModels(provider)`, `resolveModel(provider, model, signal)`
  and `prepareCall(provider, model, signal)` have base implementations.
- `WebServer.register(route: WebRoute): () => void` with
  `WebRoute = { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`
  — **exactly** the shape used. Duplicate `(kind, path)` throws. `ctx.effect(fn, label)` ties
  the returned disposer to the fiber.

### 8.2 The registration code (L3024–3034)

```js
export function apply(ctx) {
  const store = new FileCredentialStore(credentialPath());
  const modelSettings = new FileModelSettingsStore(modelSettingsPath());
  const adapter = new AntigravityAdapter(store, modelSettings);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  registerWebApi(ctx, store, modelSettings);
}

apply.inject = ["llm"];

export default apply;
```

### 8.3 Adapter class (L2664–2747)

```js
export class AntigravityAdapter extends LlmAdapter {
  #store;
  #modelSettings;

  constructor(store = new FileCredentialStore(), modelSettings = new FileModelSettingsStore()) {
    super();
    this.#store = store;
    this.#modelSettings = modelSettings;
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  async listModels(provider) { /* … see §6.4 … */ }

  async resolveModel(provider, modelId, signal) {
    if (signal?.aborted) return Promise.reject(new LlmError("antigravity model resolution aborted", "ABORTED"));
    const settings = await this.#modelSettings.read();
    const model = modelFromSettings(settings, modelId);
    return { provider, id: model.id, name: model.name, inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow }, defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model) };
  }

  async *stream(options) { /* … see §5.7 … */ }
}
```

`LlmModelInfo` requires `provider`/`id`/`name` (plus optional `description`/`inputModalities`);
`LlmResolvedModelInfo` adds `context`/`defaultMaxTokens`/`reasoning`.
**`[DRIFT]`** `LlmModelReasoningInfo` is `{ efforts: readonly LlmReasoningEffortInfo[], defaultEffort?: ReasoningEffortId }`
— the plugin sets `efforts` only, so `refreshAntigravityToken`-independent effort defaulting
relies on the caller. Also note `resolveModel`'s parameter is named `modelId` while the base
declaration names it `model`; positional compatibility only.

Adapter gaps vs. the current interface: no `prepareCall` override (so a settings change
between preparation and dispatch can, in principle, swap model metadata — the plugin's
`stream()` re-reads settings and re-resolves anyway, which partly mitigates this), no
`providerRetryPolicy`, and `GenerateOptions.stop` / `purpose` are ignored.

### 8.4 The host HTTP API (`registerWebApi`, L2949–3022)

```js
function registerWebApi(ctx, store, modelSettings) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: "/antigravity/api",
          handler: async (request, response) => {
            const url = new URL(request.url || "/", "http://dsh.local");
            const path = url.pathname.replace(/^\/antigravity\/api\/?/, "");
            try {
              if (path === "status" || path === "") { /* … */ }
              // …
            } catch (error) {
              return sendJson(response, 500, { ok: false, error: safeError(error) });
            }
          },
        }),
      "dsh-antigravity: web api",
    );
  });
}
```

**Client↔host RPC is plain same-origin HTTP `fetch`** — there is no typert / `api-remotes` /
websocket channel in this plugin. Envelope is always
`{ "ok": true, "value": … }` or `{ "ok": false, "error": "<redacted message>" }`, with
`content-type: application/json; charset=utf-8`, `cache-control: no-store`,
`x-content-type-options: nosniff` (`sendJson`, L2767–2774). Method mismatch →
`405 { ok: false, error: "method-not-allowed" }` (L2776–2778).

| Method | Path | Handler | Response `value` |
|---|---|---|---|
| `GET` | `/antigravity/api/status` (and `""`) | `webStatus(store, modelSettings)` | `{ authenticated, email?, projectId?, expires?, login, models, quota? }` |
| `POST` | `/antigravity/api/login` | `beginWebLogin(store)` | `{ status, authUrl, startedAt }` |
| `GET`/`POST` | `/antigravity/api/quota` | `fetchAccountQuota(store, modelSettings)` then `emitLlmAdaptersUpdated(ctx)` | `{ projectId, planLabel, fetchedAt, …quotaCardRows(quota), models }` |
| `GET` | `/antigravity/api/models` | `modelOptionsPayload(await modelSettings.read(), getCachedQuota())` | `{ enabledModelIds, options }` |
| `POST` | `/antigravity/api/models` | body `{ enabledModelIds: string[] }` → `setEnabledModelIds` then `emitLlmAdaptersUpdated(ctx)` | `{ enabledModelIds, options }` |
| `POST` | `/antigravity/api/logout` | `store.delete()`, `cachedQuota = undefined` | fresh `webStatus(...)` |
| — | anything else | — | `404 { ok: false, error: "not-found" }` |

`webStatus` (L2911–2929):

```js
async function webStatus(store, modelSettings) {
  const credentials = await store.read();
  const quota = getCachedQuota();
  const settings = await modelSettings.read();
  return {
    ...credentialSummary(credentials),
    login: getWebLoginStatus(),
    models: modelOptionsPayload(settings, quota),
    quota: quota === undefined ? undefined : {
      projectId: quota.projectId, planLabel: quota.planLabel, fetchedAt: quota.fetchedAt,
      ...quotaCardRows(quota),
    },
  };
}
```

`POST /models` rejects a missing/`non-array` `enabledModelIds` with
`400 { ok:false, error:"enabledModelIds must be an array" }`. Request bodies are read with
`readRequestJson` (L2931–2939), which throws `"invalid JSON request body"` when the parsed
value is not a plain record (empty body → `{}`).

`emitLlmAdaptersUpdated` (L2941–2947):

```js
function emitLlmAdaptersUpdated(ctx) {
  try {
    ctx.emit("llm/adapters-updated");
  } catch (error) {
    setLastError(error);
  }
}
```

### 8.5 Diagnostics plumbing

Ten `setLast*` writers feed the module-level `diagnostics` object (L328–336, L417–443), read
by `getAntigravityDiagnostics()` (L445). `formatRequestDiagnostics` (L1832) embeds
`endpoint`, `project`, `runtimeModel`, `matched`, `available` into every error message.
`doctorText()` (L2749–2765) renders a multi-line report — **the function is never called**
(dead code) but it documents intent, including `transport=native-cloud-code-assist-sse`,
`runtimeCli=not-used`, and the four aspirational commands.

### 8.6 Packaging surface

`package.json`:

```json
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"],
      "platform": "web"
    }
  },
  "bin": { "antigravity-login": "bin/antigravity-login.mjs" }
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-antigravity
      name: dsh-antigravity
```

(README's manual-install example uses `id: llm-antigravity` — an inconsistency; the id is
arbitrary but pick one.)

Verified against the web shell (`app.asar`): `dsh.client` is validated as
`{ platform: string (required), inject?: string[], external?: string[], immediately?: boolean }`,
and the accepted entry-point contract is
`` window.__ModuleLoader__.load({ id, factory }) `` where **`factory(require)` is lazy** —
"executing a plugin bundle only REGISTERS its factory; every module body side effect… lives
inside the factory closure and runs at materialization, not at script execution." Specifier
normalization strips a trailing `/client`, so `<pkg>/client` and `<pkg>` resolve to the same
bundle.

---

## 9. Client plugin

### 9.1 Module shell (L1–12, L644–660)

```js
window.__ModuleLoader__.load({
  id: "dsh-antigravity",
  factory(require) {
    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const STYLE_ID = "dsh-antigravity-settings-style";
    const API = "/antigravity/api";
    const NS = "dsh-antigravity";
    // …
    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        installStyle();
        initNavObserver();
        if (ctx.locale && typeof ctx.locale.register === "function") {
          ctx.locale.register(NS, { zh, en });
        }
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "antigravity",
          order: 12,
          label: () => "Antigravity",
        }, (props) => React.createElement(AntigravitySettings, { ...props, ctx })));
      },
    };
  },
});
```

Only `react` is required — **no DSH UI-kit import**. The component receives the composed
props and is handed the client `ctx` by the closure, which is how it reaches `ctx.locale`.

### 9.2 Settings slot

| Aspect | Value |
|---|---|
| Slot | `"settings.section"` (declared by `@deepseek-ai/dsh-client-ui-settings`, `kind: 'list'`, `scope: 'root'`) |
| Registration API | `ctx.slots.inject(key, () => ctx.slots.register({ name, id, order, label }, Component))` |
| Options | `name: "settings.section"`, `id: "antigravity"`, `order: 12`, `label: () => "Antigravity"` |
| Preceding hook | `ctx.slots.inject(...)` — installs the declaration through the caller's `ctx.effect` |
| Other slots available | `settings.trigger`, `settings.header`, `settings.action`, `settings.close`, `settings.plugins.tab`, `settings.onboarding`, `settings.general.item` |

Verified against the installed packages: `SlotRegistry.register` and
`SlotRegistry.inject(key, callback)` both exist and the `settings.section` SlotMap entry
documents options `id`, `order`, `label`. Two caveats for a new plugin:

- The installed `label` contract is described as *"registrant-localized display text — the
  registrant re-registers with fresh text on locale change"*, i.e. a **string**. The plugin
  passes a **function** `() => "Antigravity"`. It is a constant so it survives either
  interpretation, but do not assume a function is accepted for dynamic labels.
- The installed locale plugin passes a `locale: SETTINGS_NS` option to `register` to have the
  framework inject `t`. The reference plugin does not use it (see §9.4).

### 9.3 Host calls

```js
// L200-213
async function api(path, options) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options && options.headers ? options.headers : {}),
    },
  });
  const body = await response.json().catch(() => ({ ok: false, error: "invalid-json" }));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body.value;
}
```

Calls made: `api("/status")`, `api("/quota", {method:"POST"})`, `api("/login", {method:"POST"})`,
`api("/logout", {method:"POST"})`, `api("/models", {method:"POST", body: JSON.stringify({enabledModelIds})})`.
Login opens `window.open(value.authUrl, "_blank", "noopener,noreferrer")` and then polls
`/status` with `window.setInterval(..., 2000)`, clearing the interval on
`login.status === "complete"` (then refreshing quota) or `"error"` (then surfacing
`login.error`).

State: `status`, `quota`, `modelConfig`, `busy`, `modelBusy`, `error`, `pollRef`.
On mount: `installStyle()` → `initNavObserver()` → `patchNavIcon()` → `refreshStatus()`, and
`if (value.authenticated) void refreshQuota()`. Model checkboxes auto-save
(`toggleModel` → `saveModels([...set])`), with "Select all"/"Deselect all" buttons.

### 9.4 i18n wiring (L75–100, L394–403)

```js
    function createTranslator(ctx) {
      const boundT = (ctx && ctx.locale && typeof ctx.locale.bind === "function")
        ? ctx.locale.bind(NS)
        : null;

      return function t(key, params) {
        if (boundT) {
          try {
            const res = boundT(key, params);
            if (res && res !== key && res !== `${NS}.${key}`) return res;
          } catch (_) {}
        }
        const active = (ctx && ctx.locale && typeof ctx.locale.getLocale === "function")
          ? ctx.locale.getLocale()?.active
          : null;
        const isZh = active ? active.startsWith("zh") : (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("zh"));
        const dict = isZh ? zh : en;
        let text = dict[key] || en[key] || zh[key] || key;
        if (params && typeof params === "object") {
          for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return text;
      };
    }
```

Re-render on locale change (L395–403):

```js
      const [, setLocaleRev] = useState(0);
      useEffect(() => {
        if (!ctx || !ctx.locale || typeof ctx.locale.subscribe !== "function") return;
        return ctx.locale.subscribe(() => {
          setLocaleRev((r) => r + 1);
        });
      }, [ctx]);

      const tr = useMemo(() => createTranslator(ctx), [ctx]);
```

Verified against `dsh-client-locale@0.1.1-rc.2`:

```js
// lib/client.js:1121-1122 — the implementation accepts BOTH call shapes
register(ns, localeOrDicts, dict) {
  const pairs = typeof localeOrDicts === "string" ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
```

so `ctx.locale.register(NS, { zh, en })` is valid; `ctx.locale.bind(ns)`,
`ctx.locale.getLocale()` (returns `{ active, locales, revision }`) and
`ctx.locale.subscribe(fn)` all match. `LocaleDict` is `Record<string, string>` — a **flat
key → template string** map with `{name}` placeholders, exactly as used. The locale runtime's
own fallback chain is *active namespace → en fallback → `common` → the key itself*; the
plugin's hand-rolled `t` duplicates that chain defensively (`dict[key] || en[key] || zh[key] || key`).

Default namespace `NS = "dsh-antigravity"`. Dictionaries are `zh` (L13–42) and `en` (L44–73),
each with the same 28 keys: `pageDesc`, `currentAccount`, `login`, `loggingIn`, `refresh`,
`refreshing`, `logout`, `loading`, `notSignedIn`, `notSignedInDesc`, `noQuotaDesc`,
`fetchingQuota`, `quota`, `resetPrefix`, `resetUnavailable`, `resetNow`, `timeDayHour`,
`timeHourMin`, `timeMin`, `updatedAt`, `modelSelector`, `modelSelectorDesc`, `selectAll`,
`unselectAll`, `loadingModels`, `modelSelectorNote`, `quotaLabel`, `loginFailed`.

**`[DRIFT]` / improvement:** the modern pattern is to pass `locale: NS` to
`ctx.slots.register` and read the framework-injected `t` prop instead of building a
translator and subscribing to `locale/change` manually:

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section", id: "…", order: 12, locale: SETTINGS_NS,
}, Component));  // Component receives `t: TranslateNS<typeof SETTINGS_NS>`
```

### 9.5 UI construction and DOM hacks

The page is hand-rendered with `React.createElement` and one injected `<style>` block
(`installStyle`, L136–198; ~60 `dsha-*` CSS classes, id `dsh-antigravity-settings-style`).
Components: `AntigravityIcon`, `QuotaRow`, `QuotaGroup`, `ModelOptionRow`, `AntigravitySettings`.
Accent colouring: a group/bucket is `cyan` when
`/claude|gpt|3p|openai|anthropic/i` matches `displayName + description` (L595), else `green`.
A `PRO` badge appears when `/pro|paid|plus/i` matches `quota.planLabel` (L560).

Quota rendering has two shapes: prefer `quota.groups`; otherwise rebuild groups from
`quota.bucketRows` by their `group` field; otherwise fall back to flat `quota.modelRows`
filtered to numeric `remainingFraction` (L532–553).

**Nav-icon DOM patching (L102–134) — a hack to avoid:**

```js
    function patchNavIcon() {
      const spans = document.querySelectorAll("span");
      for (const span of spans) {
        if (span.textContent && span.textContent.trim() === "Antigravity") {
          const btn = span.closest("button");
          if (btn) {
            const svg = btn.querySelector("svg");
            if (svg) { /* overwrite viewBox/width/height/fill and innerHTML with a hard-coded path */ }
          }
        }
      }
    }

    function initNavObserver() {
      patchNavIcon();
      if (window.__antigravityNavObserver) return;
      const observer = new MutationObserver(() => { patchNavIcon(); });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
      window.addEventListener("click", patchNavIcon, true);
      window.setInterval(patchNavIcon, 300);
      window.__antigravityNavObserver = observer;
    }
```

Why it exists: to replace the model-picker's auto-generated provider icon with a brand mark.
Cost: a document-wide `MutationObserver` plus a **300 ms polling interval** for the lifetime
of the page, and it matches any `<span>` in the whole app whose exact trimmed text is
`"Antigravity"`. A new plugin should provide an icon through the supported slot/`providerInfo`
surface instead. The same SVG path is duplicated three times (`patchNavIcon`'s innerHTML and
`AntigravityIcon`, L10–11, L116, L229):

```js
"M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z"
```

Client-side sorting is duplicated from the host (`extractModelVersion`, `compareVersionsDesc`,
`getFamilyOrder`, `getVariantScore`, `compareAntigravityModels`, `compareAntigravityModelOptions`,
`formatReset`, L235–316) — the host already sorts, so this is redundant except as a guard
against a stale payload.

---

## 10. Reusable vs. avoid

### 10.1 Copy verbatim (drop-in quality)

| Item | Location | Why |
|---|---|---|
| `FileCredentialStore` | L2406–2455 | Atomic tmp+rename write, `0o600`, `ENOENT`→`undefined`, serialized `modify()` chain |
| `FileModelSettingsStore` + `normalizeModelSettings` | L2457–2520 | Same durability properties for a user-settings document |
| `redactSecrets` / `safeError` / `sanitizeOAuthProviderError` | L397–415, L2040–2050 | Token-shaped regex redaction suitable for any OAuth provider |
| `generatePKCE` / `base64Url` | L2052–2060 | Canonical S256 PKCE |
| `startCallbackServer` + `oauthCallbackHeaders` | L2029–2139 | Loopback callback with state check, loopback-only bind, strict CSP/no-store headers, 405/404 handling |
| `openBrowser` | L2141–2153 | Cross-platform, `detached`, `stdio: "ignore"`, never throws |
| `needsRefresh` + the `ensureApiKey` double-checked `store.modify` refresh | L2363–2365, L2546–2557 | Exactly-one refresh under concurrency |
| `idleWatchdog`/`timeoutOf` stream wrapper | L2706–2746 | Correct idle-vs-think-time semantics + `AbortSignal.any` fusion |
| `sanitizeText` | L368–370 | Lone-surrogate → `U+FFFD`; prevents provider 400s |
| `stripMetaSchema` + `normalizeCustomToolSchema` + `CUSTOM_TOOL_SCHEMA_ALLOW` | L1644–1703 | Google-shaped tool schema conversion |
| `accumulated line-buffer` SSE reader | L1965–1993 | Handles split UTF-8, `\r\n`, and a final line without `\n` |
| `assertSafeApiBaseUrl` / `resolveCallbackHost` / `callbackPort` | L449–500 | Host allow-listing and loopback validation |
| `clampFraction` / `remainingPercent` / `formatReset` / `progressBar` | L857–888 | Quota presentation math |
| `extractProjectId` | L570–597 | Broad, defensive project-id mining |
| `attributionHeaderBag` (the idea) | L535–541 | Never let a provider request go out without DSH attribution — but fix the casing (see below) |

### 10.2 Adapt, don't copy

| Item | Issue |
|---|---|
| `attributionHeaders()` merge | Lowercase `user-agent` collides with `User-Agent`; build one merged UA string |
| `options.toolChoice` | Does not exist on `GenerateOptions` in the installed `dsh-llm`; the whole branch is dead |
| `replayState` shape | The plugin's top-level `{kind,version,provider,model,runtimeModel,blocks}` predates `ReplayEnvelope { response, blocks? }` |
| Reasoning metadata | `LlmModelReasoningInfo` also has `defaultEffort`; the plugin omits it |
| `finishReasonOf` | Declares `(rawReason, hasToolCall, hasContent, errorMessage)` but the call site (L2012) passes only three args, so `errorMessage` is always `undefined`; the `CONTEXT_WINDOW_EXCEEDED` and `!hasContent` branches are unreachable |
| `ctx.emit("llm/adapters-updated")` | Legitimate, but registration already emits it; keep only for settings writes |
| `label: () => "Antigravity"` | Installed contract documents `label` as a localized **string** |
| `listModels`/`stream` per-call `read()` | A file read on every call; cache the settings in memory and invalidate on write |
| `parseCatalogModels` consolidation | Faithful to Antigravity's slugs but ~5 ad-hoc regex ladders (`buildModelMatchRegex`, `baseModelMatcher`, `publicModelMatchNeedles`) that must all be kept in sync |
| `MODELS` context/maxTokens | Hand-copied per model; the live `fetchAvailableModels` payload has no such fields, so they cannot be derived |

### 10.3 Avoid

| Item | Why |
|---|---|
| `patchNavIcon` + `MutationObserver` + `setInterval(300)` + capture-phase click listener | Global DOM mutation, hard-coded brand path, matches any `<span>` reading `"Antigravity"`; 3 duplicate copies of the SVG path |
| Hand-rolled `createTranslator` + `useState` revision counter | Replaced by `locale: NS` on `register` + the framework `t` prop; the host's fallback chain already covers `en`/`common` |
| `getApiKey`, `formatQuotaSummary`, `doctorText` | Exported but never called; `getApiKey` returns a JSON blob `{"token":…,"projectId":…}` that implies an obsolete credential interface |
| `projectCache`/`modelCache` keyed by raw access token | Leaks token strings as Map keys and loses the cache on every refresh; key by `email`/`projectId` instead |
| `defaultProjectId` / `stableProjectId` | Synthesizes a SHA-1 pseudo-UUID as a "project id" when discovery fails; send `undefined` and let the backend assign, or fail loudly |
| The `[ignore]…[/ignore]` duplicated system-instruction part | Two copies of `ANTIGRAVITY_SYSTEM_INSTRUCTION` per request (wasted tokens); empirical hack, not a documented contract |
| `diagnostics` module-global + ten `setLast*` mutators | Global mutable state shared by all sessions; return structured per-call results instead |
| `webLoginFlow` module-global | One browser login per **process**, not per session; a second user's login collides with the first |
| Long `friendlyAntigravityError` string ladder | Matches on human-readable text instead of `LlmFailure.code`; the newer contract is explicit that you must route on `error.code` |
| Regex-based error classification (`/\b(?:401|403)\b/` etc.) | Classifies on message text, so any 401-like substring in a provider message misclassifies |
| `emptyAttempt` retry of a whole successful-but-empty response | Up to 3 full re-requests with the same body (only the requestId differs) — doubles/triples cost on degenerate completions |

### 10.4 Minimal checklist for a new, related plugin

1. Host plugin: `export const name`, `export const inject = ["llm"]` (or the services you need),
   `export function apply(ctx)`, `export default apply`, `apply.inject = [...]`.
2. Add `dsh.bundle.patch` → a `cordis.patch.yml` with `- insert: [{ id, name }]`.
3. Import contracts from `@deepseek-ai/dsh-llm`; register with
   `ctx.llm.registerAdapter([PROVIDER], adapter)` and **keep the returned handle** so you can
   `.replace()` routes on settings change.
4. Store credentials under `dshHomePath("storages", "<ns>-oauth.json")` with `0o600` + tmp/rename.
5. Refresh lazily inside `store.modify()` with a double-checked `needsRefresh`.
6. Wrap your stream generator in `idleWatchdog` + `AbortSignal.any`.
7. Register the settings page with
   `ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id, order, locale: NS }, Component))`
   and let the framework inject `t`.
8. Expose host state over a `webServer` prefix route returning `{ ok, value }` / `{ ok, error }`,
   registered inside `ctx.effect(() => webServer.register({ kind: "prefix", path, handler }), label)`.
9. Declare `dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"] }`
   and ship `lib/client.js` as `window.__ModuleLoader__.load({ id, factory: (require) => ({ inject, apply }) })`.
10. Emit `ctx.emit("llm/adapters-updated")` after settings writes so the model picker refreshes.
