# dsh-antigravity-connect

English | [简体中文](./README.zh.md)

A **Google Antigravity / Cloud Code Assist model provider plugin** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It does one thing: it brings the models available to your Google account through Antigravity into DSH, where they show up in the model picker. It **listens on no external port** and is not a proxy service — the small HTTP API behind its settings page rides the web server DSH already runs.

> Unofficial integration. Not affiliated with or endorsed by Google. Use it only with accounts and services you are entitled to use.

---

## How it differs from `dsh-antigravity`

Both solve the same problem; this is a lighter rewrite that borrows the former's OAuth approach.

- **A native DSH plugin rather than a separate process.** Configuration is a schemastery `Config` plus a DSH settings namespace, so it can live in the profile patch or be edited from the settings page; credentials and preferences stay under `$DSH_HOME`.
- **Aligned with the current DSH contracts** (checked line by line against the installed `@deepseek-ai/dsh-llm`): `replayState` uses the `ReplayEnvelope { response, blocks }` shape, thought signatures replay per block, the `user-agent` is merged into one value (two spellings would be comma-joined by `fetch`), and `LlmModelReasoningInfo` does not invent a `defaultEffort`.
- **No DOM hacks.** No injected `MutationObserver`, no `setInterval` polling, no rewriting someone else's navigation icon.
- **The idle timeout actually fires.** A silent backend is raced and cut off, releasing the socket, instead of left hanging.
- **Fully offline tests.** 48 of them, including mounting the plugin into a real Cordis + `LlmRuntime` + `WebServer` app and completing a full generation.

---

## Install

```sh
# From GitHub
dsh plugin --profile web add github:<your-username>/dsh-antigravity-connect

# Or from a local checkout
dsh plugin --profile web add /absolute/path/to/dsh-antigravity-connect
```

Then restart DSH:

```sh
dsh web
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` records it in the profile's `dsh.profile.bundles` and it appears in **Settings > Plugins** inventory.

### Manual install

If `dsh plugin` is unavailable, drop the package into the profile and edit its patch:

```sh
cp -R dsh-antigravity-connect "$DSH_HOME/profiles/web/node_modules/"
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: antigravity-connect
      name: dsh-antigravity-connect
```

---

## Sign in

Open **Settings > Antigravity** and choose **Sign in**. The browser completes the Google OAuth round-trip and the page refreshes itself when it finishes.

The plugin runs a loopback callback listener on `127.0.0.1:51121`. The port is fixed because Google requires the redirect URI to match the registered value exactly. If the browser does not open, the settings page offers the authorization URL to open by hand.

**Headless or remote hosts** can use the command-line helper:

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-antigravity-connect/bin/antigravity-connect-login.mjs"
```

It prints the authorization URL, waits for the callback, and writes the credential. Add `--no-open` to skip launching a browser, or `--logout` to remove a stored credential.

Credentials live at:

```text
$DSH_HOME/storages/antigravity-connect-oauth.json   (mode 0600)
```

> That file holds a refresh token. Treat it as a secret.

---

## Models

Models appear in the DSH model picker after signing in. The settings page lets you check and uncheck them; unchecked models are not offered (changes save automatically).

| Model ID | Name | Quota pool | Context | Max output |
|---|---|---|---|---|
| `gemini-3.7-flash` | Gemini 3.7 Flash | Gemini | 1,048,576 | 65,536 |
| `gemini-3.6-flash` | Gemini 3.6 Flash | Gemini | 1,048,576 | 65,536 |
| `gemini-3.5-flash` | Gemini 3.5 Flash | Gemini | 1,048,576 | 65,536 |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Gemini | 1,048,576 | 65,535 |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | Gemini | 1,048,576 | 65,536 |
| `gemini-3-flash` | Gemini 3 Flash | Gemini | 1,048,576 | 65,536 |
| `gemini-2.5-pro` | Gemini 2.5 Pro | Gemini | 1,048,576 | 65,536 |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Gemini | 1,048,576 | 65,536 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Claude & GPT (3P) | 200,000 | 64,000 |
| `claude-opus-4-6` | Claude Opus 4.6 | Claude & GPT (3P) | 250,000 | 64,000 |
| `gpt-oss-120b` | GPT-OSS 120B | Claude & GPT (3P) | 131,072 | 32,768 |

Models in one pool share its 5-hour and weekly limits. Usage is charged in proportion to token cost, so heavy models such as Claude Opus drain a pool faster. The settings page shows each pool's live remaining percentage and reset countdown.

Reasoning efforts (`off`, `low`, `high`, and so on) are offered per model's own supported set, and the plugin does not override the backend's own default.

---

## Configuration

Nothing needs configuring on first install. To change something, add `config` in `cordis.patch.yml`:

```yaml
- insert:
    - id: antigravity-connect
      name: dsh-antigravity-connect
      config:
        endpoint: https://cloudcode-pa.googleapis.com
        callbackPort: 51121
        streamIdleTimeoutMs: 300000
        systemInstruction: |
          You are a pragmatic coding assistant. Keep answers concise.
```

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | `https://cloudcode-pa.googleapis.com` | Cloud Code Assist base URL. Falls back to the sandbox host on 5xx and network errors only. |
| `callbackPort` | `51121` | OAuth loopback port; must match the registered redirect URI. |
| `streamIdleTimeoutMs` | `300000` | How long the backend may stay silent during one read before the stream is cut and the socket released. |
| `systemInstruction` | The Antigravity baseline | Baseline system prompt; `options.system` is appended after it. |

The preference document (which models are checked) lives at `$DSH_HOME/storages/antigravity-connect-preferences.json`.

---

## Development

The plugin is plain ESM with no build step. So that peer dependencies under `@deepseek-ai/*` resolve, a development checkout needs a link to the profile's dependency layer:

```sh
ln -s ~/.dsh/profiles/node_modules node_modules
npm test        # 48 tests
npm run check   # syntax and module-load check
```

The client half (`client.js`) is hand-written and is **not** bundled by DSH — DSH serves it to the browser as-is at `/plugins/<id>/client.js`. It must therefore use the `window.__ModuleLoader__.load({ id, factory })` closure-factory format and may only `require` platform-shared modules (only `react` is used here). Save the file and HMR picks it up.

### Module map

| File | Responsibility |
|---|---|
| `index.js` | Plugin entry: config resolution, wiring, provider route registration |
| `lib/constants.js` | Endpoints, scopes, OAuth client, timeouts, wire headers |
| `lib/oauth.js` | PKCE, loopback callback server, code exchange, lazy refresh |
| `lib/credentials.js` | Credential file (0600, atomic write, serialized read-modify-write) |
| `lib/cloudcode.js` | Cloud Code Assist transport: project discovery, catalog, quota, SSE stream |
| `lib/serialize.js` | DSH messages ↔ Gemini `contents` / tool schemas |
| `lib/adapter.js` | The `LlmAdapter` implementation: SSE → DSH stream chunks |
| `lib/api.js` | The settings page's HTTP routes |
| `lib/preferences.js` | Model selection state |
| `lib/catalog.js` | Model catalog, public-id → runtime-id routing, output caps |

---

## License

[MIT](./LICENSE)
