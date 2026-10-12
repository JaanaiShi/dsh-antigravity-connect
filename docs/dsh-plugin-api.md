# DSH Host + Client Plugin Authoring Guide

A practical, example-driven guide to writing a **DSH (DeepSeek Harness) plugin** that
(a) runs an HTTP API and (b) exposes a settings UI in the DSH Web GUI.

Every code snippet below is copied from the real trees on this machine. Cite paths are
repo-relative to the source checkout; see [§0](#0-where-the-code-lives) for the absolute
prefixes.

---

## 0. Where the code lives

Three trees matter, and two of them are the same files.

| Tree | Path | What it is |
|---|---|---|
| Source monorepo | `/Users/shiwenhui/code/tsProject/deepseek-harness` | The full pnpm workspace: `packages/`, `apps/`, `docs/`, `examples/`, `scripts/`. **Everything below was read here.** |
| Profile resolution mirror | `/Users/shiwenhui/.dsh/profiles/node_modules/@deepseek-ai/` | Not a copy — every entry is a **symlink** into the source checkout's `apps/cli/node_modules`. Example: `dsh-host-webserver -> /Users/shiwenhui/code/tsProject/deepseek-harness/apps/cli/node_modules/@deepseek-ai/dsh-host-webserver`. |
| Electron bundle | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` | The **packaged, built** `lib/*.js` of the same packages, under `app.asar/dsh/node_modules/@deepseek-ai/`. Only needed if the source tree is absent. |

Because the profile mirror symlinks into a source checkout, **`./src/*` is readable**. Almost
every DSH package publishes a `./src/*` export escape hatch
(`packages/host/webserver/package.json`):

```jsonc
"exports": {
  ".":          { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./invariant":{ "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
  "./src/*":    "./src/*",
  "./package.json": "./package.json"
}
```

Note there is **one** real third-party plugin already working on this machine, and it is the
best end-to-end reference for §1/§2:
`/Users/shiwenhui/code/home/dsh-plugin-content-studio` (installed into the `desktop` profile).

Two up-front corrections to common assumptions:

- **DSH does not use Hono.** `hono@4.13.2` and `@hono/node-server@2.1.0` are physically present at
  `/Users/shiwenhui/.dsh/profiles/node_modules/hono/` and `.../@hono/`, but **no DSH package
  declares them as a dependency** (`grep -rn '"hono"' --include=package.json packages/ apps/`
  returns nothing) and the webserver is raw `node:http`. Treat Hono as unavailable-by-contract,
  not as the framework.
- **`dsh` is not on `PATH`** on this machine (`command -v dsh` → nothing). See §2.4 for the
  exact invocation that works.

---

## 1. Plugin anatomy

### 1.1 The three shapes

`docs/user/develop/basic/index.md` states the contract: *"a plugin is a TypeScript module that
exports an `apply` function."* There are three forms — function, object, and class.

**Function form (the default).** This is what nearly every plugin uses. The canonical minimal
example, from `docs/user/develop/basic/index.md`:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // Register capabilities here.
}
```

**Object form** (same file):

```ts
import type { Context } from '@deepseek-ai/cordis'

export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) {
    // ...
  },
}
```

**Class form** — use it when the plugin *provides a service* to other plugins
(`docs/user/develop/basic/index.md`):

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MyService extends Service {
  static inject = ['tools']

  constructor(ctx: Context) {
    super(ctx, 'myService')
    // Perform synchronous initialization in the constructor.
  }
}
```

The class form's `super(ctx, 'myService')` is what registers `ctx.myService`. The webserver is
the reference implementation of this (`packages/host/webserver/src/index.ts:73-90`):

```ts
export class WebServer extends Service {
  static Config: z<Config> = z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
    port: z.natural().max(65535).required(),
  })
  // ...
  constructor(ctx: Context, private config: Config) {
    super(ctx, 'webServer')
  }
```

and it declares its own context key by module augmentation, in the same file
(`packages/host/webserver/src/index.ts:22-36`):

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
  interface Events {
    'webserver/index-inject'(table: IndexInjection[]): void
  }
}
```

### 1.2 ⚠️ The default-export trap (named function plugins)

The existing third-party plugin carries an explicit warning at the top of its entry file,
`/Users/shiwenhui/code/home/dsh-plugin-content-studio/index.js:10-12`:

```js
 * 注意：function plugin 必须具名导出 name / inject / Config / apply，且**不能有 default export**
 * （default export 会让 Loader 丢掉 inject，插件启动即崩）。
```

Translation: *a function plugin must **named-export** `name` / `inject` / `Config` / `apply`,
and must **not** have a default export — a default export makes the Loader drop `inject`, and
the plugin crashes at startup.*

This matches the loader surface: the object/class forms put everything inside the default
export; the function form must hoist every field to a named export. **Do not mix them.**

### 1.3 `Config` with `Schema.object(...)`

The schema package is `@deepseek-ai/schemastery`, whose default export is conventionally
imported as `z`. From the real third-party plugin
(`/Users/shiwenhui/code/home/dsh-plugin-content-studio/index.js:16-32`):

```js
import z from '@deepseek-ai/schemastery'

export const name = 'content-studio'

export const inject = ['tools']

/** 插件配置：可换默认预设、可整体关闭技能注册 */
export const Config = z.object({
  /** 默认品牌预设 id */
  defaultPreset: z.string().default('zhuji'),
  /** 是否随插件注册 content-studio 技能 */
  registerSkill: z.boolean().default(true),
})

export function apply(ctx, config = {}) {
  const defaults = { defaultPreset: 'zhuji', registerSkill: true, ...config }
```

A richer typed example, from `packages/llm/llm-deepseek/src/index.ts:160-186`. Note the
`z<Config>` annotation tying the schema to the interface, and schema-driven `.default()`:

```ts
export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
```

And the smallest real one, from `packages/client/hmr/src/index.ts:33-42`:

```ts
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(1).default(500),
})
```

`z.role('credential-ref')` and `z.role('secret')` are the two role annotations that matter for
settings — see §5.2.

### 1.4 `inject`

`inject` names the **services that must be ready before `apply` runs**; the framework waits.
From `docs/user/develop/basic/index.md`:

```ts ignore-check
export const name = 'my-tool-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  // ctx.tools is ready here.
  ctx.tools.register(/* ... */)
}
```

Real examples:

| Plugin | `inject` | File |
|---|---|---|
| `content-studio` | `['tools']` | `/Users/shiwenhui/code/home/dsh-plugin-content-studio/index.js:27` |
| `llm-deepseek` | `['llm']` | `packages/llm/llm-deepseek/src/index.ts:66-67` |
| `client-hmr` | `['clientModules', 'webServer']` | `packages/client/hmr/src/index.ts:29-30` |
| `ui-jobs` (browser) | `['sessions', 'slots', 'locale']` | `packages/client/ui-jobs/src/client/index.ts:22` |

For a plugin doing HTTP + settings you will typically want
`inject = ['webServer', 'settings']` — but **only list what you truly require**.
`installSettingsSection` (§5.1) is specifically designed so `settings` can be *optional*: it uses
`ctx.inject(['settings'], ...)` internally, so your plugin keeps working when no settings
provider is mounted. Register `webServer` eagerly; reach settings optionally.

### 1.5 Cleanup via `ctx.effect()`

Anything registered through `ctx` is disposed with the plugin. For a resource you own
yourself, return a disposer from `ctx.effect()`. From `docs/user/develop/basic/index.md`:

```ts
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log('heartbeat')
    }, 5000)

    // The returned function runs when the plugin unloads.
    return () => clearInterval(timer)
  })
}
```

The convention across the codebase is a **second label argument**, which shows up in
diagnostics. `packages/host/frontend-static/src/index.ts:109-121`:

```ts
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
```

and with the label, `packages/client/modules/src/index.ts:339-342`:

```ts
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: '/plugins', handler: this.serveBundle }),
      'client-modules: bundle route',
    )
```

### 1.6 A complete minimal host plugin that serves HTTP + declares config

This is the shape you should start from. It is assembled entirely from the real APIs quoted in
this document; the only thing trimmed is business logic.

`index.js` (plain ESM — see §8.1, no build step needed for the host half):

```js
/**
 * my-plugin — DSH host plugin: one HTTP route + a settings section.
 */
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

// Function form: NAMED exports only. Never add `export default` here (§1.2).
export const name = 'my-plugin'

// Only what apply() truly requires at activation time.
export const inject = ['webServer']

const NS = settingsNamespace('my-plugin')          // the join key for the settings card

export const Config = z.object({
  endpoint: z.string().default('http://127.0.0.1:4000'),
  apiKey: z.string().role('secret'),               // never returned by a settings read
  retries: z.number().step(1).min(0).default(3),
})

export function apply(ctx, config = {}) {
  // Live view of config: starts as the cordis.yml entry, is swapped to the
  // merged user document once a settings provider is present (see §5.1).
  let source = () => config

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (next) => { source = next },
    onChange: () => { ctx.logger.info('my-plugin: settings changed') },
  })

  // Register the route and tie its lifetime to this plugin's fiber.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/my-plugin/api',
    handler: async (req, res) => {
      // Raw node:http handler. Read the body yourself (§3.4).
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')

      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        ok: true,
        endpoint: source().endpoint,   // read config live, per request
        echo: raw.length > 0 ? JSON.parse(raw) : null,
      }))
    },
  }), 'my-plugin: api routes')
}
```

`cordis.patch.yml` (inside the plugin package — see §2.2):

```yaml
# Insert this plugin's row into whatever profile mounts the bundle.
- insert:
    - id: my-plugin
      name: 'dsh-plugin-my-plugin'
```

`package.json` (see §2.1):

```jsonc
{
  "name": "dsh-plugin-my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./package.json": "./package.json"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "workspace:^",
    "@deepseek-ai/dsh-settings": "workspace:^"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

> The `workspace:^` dependency specs above are only placeholders for the pattern. For an
> out-of-tree plugin, do **not** install `@deepseek-ai/*` packages: they are already resolvable
> through the profile's flat fallback directory (§2.3). In the working third-party plugin,
> `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` are imported with **no dependency
> entry at all** — `/Users/shiwenhui/code/home/dsh-plugin-content-studio/package.json` declares
> no `dependencies` key whatsoever.

---

## 2. Packaging & discovery

### 2.1 The `dsh` field in `package.json`

The profile-launcher's slice of the `dsh` field is typed in
`packages/boot/app-boot/src/profile.ts:41-70`:

```ts
/** The bundle half of the `dsh` manifest section: what a bundle package exports. */
export interface DshBundleManifest {
  /** The patch layer this bundle exports, relative to its package root. */
  patch: string
}

/** The profile half of the `dsh` manifest section: what a profile directory composes. */
export interface DshProfileManifest {
  /** Ordered bundle layer list (package names). */
  bundles?: string[]
}

/**
 * The profile-launcher slice of the `dsh`-owned package.json section. A
 * manifest may declare both roles; other consumers own additional keys.
 */
export interface DshManifestSection {
  bundle?: DshBundleManifest
  profile?: DshProfileManifest
}
```

The comment *"other consumers own additional keys"* is the key phrase: **`dsh.client` is NOT
declared here.** It is parsed by the client module system, in
`packages/client/modules/src/index.ts:116-143`:

```ts
/** package.json `dsh.client` declaration fields, validated one by one after reading the file. */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  /** Boot phase-one prefetch mark; absent means lazy (fetched on demand). */
  immediately?: boolean
  /**
   * Exact module-table requests beyond the implicit client baseline. Any
   * specifier is valid, including subpaths such as `<pkg>/client`; each
   * importing package declares its own exceptional requests. A type-only
   * import is not a request because the transform erases it before resolution.
   * Absent means the package uses only the baseline externals.
   */
  external?: string[]
}
```

and validated in `parseDshClient` (`packages/client/modules/src/index.ts:120-138`) — **`platform`
is a required string**, and the resolution gate is
`packages/client/modules/src/index.ts:442-460`:

```ts
    const dsh = pkg.dsh
    const decl = parseDshClient(
      pkgName,
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined,
    )
    if (decl === undefined || decl.platform !== 'web') {
      this.pkgMeta.set(pkgName, null)
      return null
    }
    const clientRel = clientExportOf(pkgName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`client-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`)
    }
```

**Summary of the `dsh` field:**

| Key | Type | Meaning |
|---|---|---|
| `dsh.bundle.patch` | `string` (required if `bundle` present) | Path to this package's `cordis.patch.yml`, relative to the package root. **Makes the package a profile bundle layer.** |
| `dsh.profile.bundles` | `string[]` | *Only on a profile directory's own `package.json`.* Ordered bundle layer list. |
| `dsh.client.platform` | `string`, **must be `"web"`** | Marks the package as having a browser half. |
| `dsh.client.inject` | `string[]` | Client **module graph edges** — other client package names whose rows must load first. |
| `dsh.client.external` | `string[]` | Extra module-table specifiers this bundle `require`s (beyond the baseline). |
| `dsh.client.immediately` | `boolean` | Prefetch in boot phase one. |

A real dual-face `package.json`, `packages/client/ui-goal/package.json` (abridged to the two
load-bearing halves):

```jsonc
{
  "name": "@deepseek-ai/dsh-client-ui-goal",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation"
      ],
      "platform": "web"
    }
  },
  "scripts": {
    "bundle": "tsdown",
    "watch": "tsdown --watch"
  }
}
```

Note `dsh.client.inject` here names **client packages**, and `exports["./client"]` points at the
prebuilt browser artifact `lib/client.js`.

### 2.2 `cordis.patch.yml` format

The type is `PatchOptions` from `@deepseek-ai/cordis-plugin-include`
(`apps/cli/node_modules/@deepseek-ai/cordis-plugin-include/src/index.ts:144-156`):

```ts
/** Runtime patch applied to entries loaded from an included config file. */
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

Semantics, from `applyEntryPatches` (`.../cordis-plugin-include/src/index.ts:44-82`):

- The file is a **top-level YAML array** of patches, applied **in order**.
- `- id: <entryId>` with no `insert` **targets an existing row**; the remaining fields (`config`,
  `disabled`, `name`, …) override it. **A patch `config` replaces the targeted row's whole
  `config`.**
- `- insert: [...]` **appends new rows**. If combined with `id`, it inserts into the group entry
  bearing that id.
- *"Inserted entries are indexed as they are added, so a later patch in the same list can target
  a row an earlier patch inserted. A patch that matches nothing warns and is skipped."*

**Real insert-only example** — the third-party plugin's own patch file,
`/Users/shiwenhui/code/home/dsh-plugin-content-studio/cordis.patch.yml`:

```yaml
# 内容工坊 bundle 补丁层：把自己的插件行插进 profile 的插件树。
# 安装后由 plugin_manager 写入 profile 的 dsh.profile.bundles，本文件不需要手改。
- insert:
    - id: content-studio
      name: 'dsh-plugin-content-studio'
```

**Real mixed example** — a shipped demo overlay,
`examples/web-cordis/cordis.yml`, showing an id-targeted config override *and* an insert in one
file:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3081

- insert:
    - id: cordis-host-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
```

**`!!js` expressions** are allowed in patch values. From the web bundle layer,
`packages/bundle/web-app/cordis.patch.yml`:

```yaml
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      inject: [webStartup]
      config:
        host: !!js ctx.webStartup.host ?? '127.0.0.1'
        port: !!js ctx.webStartup.port ?? 3080
```

`disabled: true` disables a row without deleting it — the web layer uses this extensively,
e.g.:

```yaml
# TODO: Re-enable shared HMR for Web after its reload lifecycle is tested.
- id: hmr
  disabled: true
```

> **Authoritative schema, generated from the live tree.** The CLI can print a JSON Schema for
> entries and patches:
> ```
> dsh --profile <name> --dump-config-schema
> ```
> Its `$comment` restates the composition contract: *"Bundle, profile, home, and CLI layers apply
> in that order. A patch config replaces the whole config."* (The command writes
> `profiles/<name>/cordis.yml` first, so it needs a writable `$DSH_HOME`; see §2.4.)

### 2.3 Layer composition & name resolution

From the module doc of `packages/boot/app-boot/src/profile.ts:1-23`, this is the whole model:

> A profile is a directory under `$DSH_HOME/profiles/<name>` holding a `package.json`
> (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its ordered
> `bundles` list) and a `cordis.patch.yml` (the user's own patch layer, applied after every
> bundle layer). Bundles are npm packages whose manifest declares
> `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is composed by applying
> each bundle's patch list in `dsh.profile.bundles` order over an empty entry list, then the
> profile's own patches, then any launcher layers (`--patch` files and flag-derived patches).

**Composition order (the part that decides who wins):**

```
empty root
  → bundle layers, in dsh.profile.bundles order
  → the profile's own cordis.patch.yml
  → --patch overlays, in argv order
```

`packages/boot/app-boot/src/profile.ts:405-420` is the single call that does it:

```ts
export function composeEntries(
  layers: readonly PatchOptions[][],
  warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, _args: unknown[]) => {
```

**Name resolution is two-anchor, installation first.** From
`packages/boot/app-boot/src/profile.ts:332-355`:

```ts
/**
 * Resolve one bundle package's directory: installation anchor first, then the
 * profile directory. The installation-first order is the contract that
 * `@deepseek-ai/dsh-base` (and every other in-box bundle) always comes from
 * the same installation as the running dsh, never from a profile-local copy.
 * ...
 */
export function resolveBundleDir(
  binName: string, packageName: string, installAnchor: string, profileDir: string,
): string {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== undefined) return dir
  }
  throw new Error(
    `${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation or ${profileDir}; `
    + `run 'dsh plugin --profile ${basename(profileDir)} install' if its dependency is not installed`,
  )
}
```

**How `@deepseek-ai/*` resolves from an out-of-tree plugin.** The Loader's `baseUrl` is the
profile directory, and the profile's `node_modules` is pnpm-managed. But that is not enough for
`@deepseek-ai/*`, which the plugin does not depend on. The trick is a maintained flat fallback,
`healProfilesModuleFallback` (`packages/boot/app-boot/src/profile.ts:204-255`):

> Maintain the flat module fallback `$DSH_HOME/profiles/node_modules`: one symlink per package in
> the dsh app's resolvable dependency CLOSURE (BFS over `dependencies` from the app manifest),
> each resolved from its own real location. Node's parent-directory walk from any profile finds
> this directory after the profile's own `node_modules`, so every in-box plugin resolves without
> pnpm ever managing it — the exact "bundles come from the installation" contract.

This is precisely why `/Users/shiwenhui/.dsh/profiles/node_modules/@deepseek-ai/` exists and is
populated with symlinks, and why the third-party plugin can `import z from '@deepseek-ai/schemastery'`
with an empty `dependencies` object.

The profile's pnpm settings exist to keep one shared cordis instance
(`packages/boot/app-boot/src/profile.ts:133-143`):

```ts
// The hoisted linker gives out-of-tree plugins a flat node_modules whose
// missing peers (cordis and friends) fall through to the healed
// profiles/node_modules installation fallback, so every plugin shares the
// installation's single cordis instance instead of a duplicate. pnpm ≥10
// reads its settings from pnpm-workspace.yaml, not .npmrc.
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`
```

**These are exactly the contents of `/Users/shiwenhui/.dsh/profiles/web/pnpm-workspace.yaml`** —
confirming the shipped profile matches the source contract.

The `web` profile's own manifest on this machine,
`/Users/shiwenhui/.dsh/profiles/web/package.json`:

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
```

And the `desktop` profile, which **already demonstrates a third-party bundle**
(`/Users/shiwenhui/.dsh/profiles/desktop/package.json`):

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-plugin-content-studio": "link:/Users/shiwenhui/code/home/dsh-plugin-content-studio"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-content-studio"
      ]
    }
  }
}
```

A third-party package sits in `dependencies` (via `link:`) **and** in `dsh.profile.bundles`, and
its own `cordis.patch.yml` supplies the entry row. That is the whole install shape.

### 2.4 `dsh plugin --profile <name> <pnpm-args...>`

It is a **thin pnpm forwarder**. Module doc,
`apps/cli/src/plugin.ts:1-11`:

> `dsh plugin --profile <name> <args...>` — profile plugin management as a thin pnpm
> forwarder: initialize the profile on first use, run `pnpm <args...>` in the profile
> directory, then reconcile the `dsh.profile.bundles` layer list against the installed state
> (a dependency resolving to a package that declares `dsh.bundle` joins the layer stack; a
> removed or bundle-less dependency leaves it).

The core of `runPlugin` (`apps/cli/src/plugin.ts:120-133`):

```ts
export function runPlugin(profile: string, args: readonly string[]): number {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir)
  // Windows resolves pnpm through its .cmd shim, which spawn() refuses
  // without a shell since the CVE-2024-27980 hardening.
  const result = spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, process.cwd())), {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
```

So: **it writes no YAML.** It runs pnpm in the profile directory, then `reconcilePlugins`
(`apps/cli/src/plugin.ts:59-91`) re-derives `dsh.profile.bundles` from installed state:

```ts
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      process.stderr.write(
        `${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer `
        + '(a later update that gains one activates it automatically)\n',
      )
    }
  }
```

with `exportsPatch` (`apps/cli/src/plugin.ts:36-45`) being *exactly* "does the resolved package
declare `dsh.bundle.patch`".

Two practical consequences:

1. **Your package must declare `dsh.bundle.patch` before you install it**, or it lands as a
   plain dependency with a warning and your row never mounts.
2. Relative path specs are anchored to *your* invoking directory, not the profile
   (`apps/cli/src/plugin.ts:93-112`), so `dsh plugin --profile web add .` from your plugin
   checkout does the right thing rather than self-linking the profile.

Both `add` and `remove` are just pnpm verbs; there is no DSH-specific subcommand set. The
`dsh --help` text on this machine states it as
`dsh plugin --profile <name> <pnpm-args...>`, and the examples use
`dsh plugin --profile tui add <package>`.

### 2.5 The exact CLI invocation that works on this machine

`dsh` is **not on `PATH`**:

```
$ command -v dsh
(nothing)
$ command -v pnpm
/Users/shiwenhui/.nvm/versions/node/v24.18.0/bin/pnpm
```

`pnpm` **is** on `PATH`, which matters because `runPlugin` shells out to it.

The launcher is a `sh` script at
`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`
(verified working: `--help` exits 0):

```sh
#!/bin/sh
# Run the installed CLI without changing the invoking shell or working directory.
set -e
launcher=$0
while [ -L "$launcher" ]; do
  directory=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd -P)
  target=$(readlink "$launcher")
  case "$target" in
    /*) launcher=$target ;;
    *) launcher=$directory/$target ;;
  esac
done
resources=$(CDPATH= cd -- "$(dirname -- "$launcher")/../../.." && pwd -P)
ELECTRON_RUN_AS_NODE=1 exec "$resources/../MacOS/DeepSeek Harness" --expose-internals "$resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"
```

So the **working invocation** is (quote it — the path contains a space):

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# install a plugin into the web profile
"$DSH" plugin --profile web add /absolute/path/to/dsh-plugin-my-plugin

# boot the web GUI
"$DSH" --profile web
```

Notes:

- `link-entry` (in the same directory) is a compiled Mach-O helper that creates a symlink to the
  launcher; `command-manager.js` is the packaged helper that manages those links. Neither is
  needed to invoke `dsh` — the `bin/dsh` script above is the entry point.
- The launcher sets `ELECTRON_RUN_AS_NODE=1` and reuses the Electron binary as Node. You do not
  need to reproduce that; just call the script.
- `--dump-config-schema` and `--dump-config` **write `profiles/<name>/cordis.yml` first**. Under
  the workspace-write sandbox that fails with `EPERM` against `~/.dsh`. Redirect the home to a
  writable directory instead: `DSH_HOME=/tmp/dshhome "$DSH" --profile x --dump-config-schema`
  (`DSH_HOME` is honored by `resolveDshHome`, `packages/util/home-paths/src/index.ts:87-97`).
- `dsh rescue --from-default-profile web` creates an independent profile from the shipped
  template — useful for experimenting without touching `web`.

---

## 3. HTTP routes

This is the most important section. **The service you inject is `webServer`, from
`@deepseek-ai/dsh-host-webserver`.** It is a raw `node:http` server; it is not Hono, Express, or
anything else.

### 3.1 The service and its three registration methods

From `packages/host/webserver/src/index.ts:38-56`:

```ts
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}
```

The three registration methods (`packages/host/webserver/src/index.ts:102-160`):

```ts
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    }
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  registerFallback(handler: WebRoute['handler']): () => void {
    if (this.fallback !== undefined) {
      throw new Error('webserver: fallback already registered')
    }
    this.fallback = handler
    return () => { this.fallback = undefined }
  }
```

**Each returns a disposer.** Always wire it through `ctx.effect` so it is removed on unload:

```ts
ctx.effect(() => ctx.webServer.register(route), 'my-plugin: /my-plugin route')
```

> `registerFallback` is **already claimed** in the shipped web profile by
> `@deepseek-ai/dsh-host-frontend-static` (`packages/host/frontend-static/src/index.ts:109`),
> which serves the SPA. A second registration throws
> `webserver: fallback already registered`. **Do not call `registerFallback`.**

### 3.2 Match order and namespacing

From `packages/host/webserver/src/index.ts:256-266`:

```ts
  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }
```

**Order is fixed: exact hit → longest prefix → fallback.** Registration order carries no
request-facing semantics (webserver README). Also from the README: *"A duplicate path within
either table throws because route patterns are a composition-level contract."*

**Namespacing is by convention, not by the framework.** There is no automatic prefix. Paths are
absolute and must not have a trailing slash. The namespaces actually claimed in the shipped web
composition:

| Path | Kind | Owner | File |
|---|---|---|---|
| `/api` | prefix | client-connection RPC bridge | `packages/client/connection/src/index.ts:164-173` |
| `/plugins` | prefix | client module bundles (`/plugins/<id>/client.js`) | `packages/client/modules/src/index.ts:340` |
| `/plugins/events` | exact | client HMR SSE channel | `packages/client/hmr/src/index.ts:166` |
| *(fallback)* | — | SPA dist | `packages/host/frontend-static/src/index.ts:109` |

So **pick your own namespace**: `/my-plugin/...`. Do not squat `/api` or `/plugins`.

### 3.3 Real route registrations

**A `prefix` route with auth, from `packages/client/connection/src/index.ts:164-173`:**

```ts
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
```

**A served-bundle `prefix` route, `packages/client/modules/src/index.ts:339-342`:**

```ts
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: '/plugins', handler: this.serveBundle }),
      'client-modules: bundle route',
    )
```

**A WebSocket `registerUpgrade` route, `packages/client/connection/src/index.ts:181-193`:**

```ts
      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => {
          if (!isTrustedApiRequest(req, trustedHosts)) {
            rejectWebSocketUpgrade(socket)
            return
          }
          return handle(req, socket, head)
        },
      }), `client-connection: ${path} WebSocket`)
```

### 3.4 Reading request bodies (JSON + streaming)

Handlers get raw `IncomingMessage`/`ServerResponse`. **Nothing parses the body for you.** The
idiomatic reader, copied verbatim from a real in-tree HTTP server,
`packages/test-support/llm-mock-server/src/index.ts:301-306`:

```ts
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  const body = Buffer.concat(chunks).toString('utf8')
  return body.length === 0 ? undefined : JSON.parse(body)
}
```

A complete JSON endpoint:

```ts
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: '/my-plugin/api/echo',
  handler: async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let payload: unknown
    try {
      payload = await readJsonBody(req)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid JSON' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, payload }))
  },
}), 'my-plugin: echo')
```

**For streaming request bodies** just consume the async iterator incrementally instead of
buffering:

```ts
handler: async (req, res) => {
  let bytes = 0
  for await (const chunk of req) {
    bytes += (chunk as Buffer).byteLength
    // ... forward, transform, or discard ...
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ bytes }))
}
```

**If you want the fetch-shaped ergonomics instead**, DSH already has a bridge, but it is not on
the public root export of the connection package — it lives behind the `./src/*` escape hatch
(`packages/client/connection/src/http-bridge.ts`):

```ts
/**
 * Bridge one node:http request to the fetch-shaped handler (client close
 * aborts; SSE bodies stream out chunk by chunk).
 */
export async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  apiHandler: FetchHandler,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<void> {
```

You *can* import it as `@deepseek-ai/dsh-client-connection/src/http-bridge.ts` (the `./src/*`
export makes that legal), but note it buffers the whole body with a 300 MiB default cap and
reaches into an internal module. For a normal API, hand-roll §3.4's reader — that is what the
rest of the tree does.

### 3.5 SSE / chunked responses

**SSE is a first-class, in-tree pattern.** The client HMR plugin is the cleanest example,
`packages/client/hmr/src/index.ts:150-175`:

```ts
  const connect = (res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })
    // Comment line on open so clients/proxies see a live channel even when
    // no rebuild ever happens; EventSource frame parsing skips it naturally.
    res.write(': connected\n\n')
    res.write(sseData({ type: 'graph', graph: ctx.clientModules.graph() }))
    connections.add(res)
    res.on('close', () => { connections.delete(res) })
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_ENDPOINT,
      handler: (req, res) => {
        // Named routes match ahead of the carrier's method gate; keep the old
        // global 405 semantics for non-GET hits on this endpoint.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        connect(res)
      },
    })
    const unsubscribe = ctx.clientModules.onRebuilt((id, rev) => {
      const line = sseData({ type: 'rebuilt', id, rev })
      for (const res of connections) res.write(line)
    })
    return () => {
      unsubscribe()
      disposeRoute()
      for (const res of connections) res.destroy()
      connections.clear()
    }
  }, 'client-hmr: /plugins/events channel')
```

with the frame serializer (`packages/client/hmr/src/index.ts:44-46`):

```ts
/** Serialize one frame as an SSE data line. */
function sseData(frame: PluginsEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}
```

**The four rules that make this work**, all visible above:

1. `content-type: text/event-stream`, plus `cache-control: no-cache` and
   `connection: keep-alive`.
2. Write a `: comment\n\n` line immediately — it forces headers onto the wire so proxies and
   `EventSource` see a live channel before the first real event.
3. **Track your open responses in a `Set` and clean up on `res.on('close')`.** The webserver's
   handler contract explicitly permits *"may hold the response open, e.g. SSE"*
   (`packages/host/webserver/src/index.ts:46`).
4. **The disposer must `res.destroy()` every open response** and clear the set. SSE connections
   keep sockets alive; leaking them blocks server shutdown.

`flushHeaders()` is the lower-level alternative, used by the mock server
(`packages/test-support/llm-mock-server/src/index.ts:311-317`):

```ts
function openSse(response: ServerResponse, contentType = 'text/event-stream; charset=utf-8'): void {
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  response.flushHeaders()
}
```

**Chunked (non-SSE) streaming** is the same idea without the `data:` framing: write headers,
then `res.write(chunk)` repeatedly, then `res.end()`. Node uses chunked transfer-encoding
automatically when no `content-length` is set.

The reference implementation of *backpressure-aware* streaming on the response side is
`packages/client/connection/src/http-bridge.ts:81-98`:

```ts
  for await (const chunk of response.body) {
    // Backpressure: a false return means the socket buffer is full — wait for drain
    // instead of buffering unboundedly (slow/suspended SSE consumers). 'close' also
    // resolves so a mid-wait disconnect can't park this loop forever; the close
    // handler above aborts the handler stream, which then ends the iteration.
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
```

Copy this shape if you stream a lot of data to a slow consumer.

### 3.6 CORS — there is none, by design

**`grep -rni "cors\|access-control-allow" --include=*.ts packages/ apps/` finds no CORS
headers anywhere in DSH.** The webserver sets none, and the module doc is explicit that this is
out of scope (`packages/host/webserver/README.md`):

> **No TLS, auth, or origin policy** — binding a non-loopback address exposes the server to that
> network; deployment hardening (or fronting it with a real reverse proxy) is deliberately out
> of scope for the dev-facing v1.

**Implications for your plugin:**

- **Same-origin browser code needs no CORS at all.** The Web GUI is served from the same origin
  as your route, so `fetch('/my-plugin/api/...')` just works. This is the intended path.
- If you want to be callable from *another* local origin, **you must write the CORS headers
  yourself**, including the `OPTIONS` preflight, because `register` gives you the raw request:

  ```ts
  const CORS = {
    'access-control-allow-origin': 'http://127.0.0.1:5173',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  }
  handler: async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' })
    res.end('{}')
  }
  ```
- **Do not use `access-control-allow-origin: *` for a localhost API.** See §3.7 — that is
  exactly the confused-deputy hole DSH's own fence exists to close.

### 3.7 Auth / token requirement for localhost

Short answer: **there is no token, and `webServer` routes you register are open.**
The only auth machinery in DSH is a *Host-and-Origin fence*, and it is applied by the
connection plugin to **its own `/api` route** — not by the webserver to every route.

The fence, `packages/client/connection/src/api-request-trust.ts:90-122`:

```ts
/**
 * Decide whether one /api request may reach the RPC bridge.
 * @param request - Node HTTP or Fetch request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves: exact `host:port`, or port-less `host` matching any port.
 * @returns true when the Host is ours (loopback or trusted) and any attached browser markers are same-origin.
 */
export function isTrustedApiRequest(request: ApiTrustRequest, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  // Cross-site fence: ...
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin fence: ...
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
```

Its doc header explains what it defends and — importantly — what it is not
(`packages/client/connection/src/api-request-trust.ts:1-14`):

> Browser-trust fence for every /api request. Defends the two confused-deputy paths a browser
> opens against a local HTTP API — DNS rebinding (Host names the attacker's domain while the
> socket reaches this server) and cross-site requests fired from a malicious page. …
> **Network reachability and authentication stay out of scope:** binding policy belongs to the
> webserver config, and **this fence is not an auth layer.**

The `/api` route invokes it explicitly
(`packages/client/connection/src/index.ts:167-170`), and defaults to loopback-only authority:

```ts
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
```

**Concretely, for a plugin route:**

- The **bind address** is the real access control. The shipped web profile binds
  `host: 127.0.0.1` (`packages/bundle/web-app/cordis.patch.yml`), and the config schema only
  permits `'127.0.0.1' | '0.0.0.0'`
  (`packages/host/webserver/src/index.ts:74-77`). On loopback, only local processes can reach
  you.
- **Any local process can call your route** with no credential. That is the same trust level as
  the DSH process itself.
- **A malicious web page in the user's browser can attempt a cross-site request** to
  `http://127.0.0.1:3080/my-plugin/...`. Browsers will send it for "simple" requests
  (no preflight). If you need protection, **copy the fence**: require a loopback `Host`, reject
  `sec-fetch-site: cross-site`, and reject a mismatched `Origin`. The private helper is
  importable via the `./src/*` export:
  `@deepseek-ai/dsh-client-connection/src/api-request-trust.ts`.
- If you must expose a non-loopback bind, the config supports `0.0.0.0` plus a `trustedHosts`
  allowlist on the connection plugin
  (`packages/client/connection/src/index.ts:59-65`), and the webserver README warns that
  hardening is then your job. **Do not do this for a personal plugin.**

### 3.8 Is raw `http.createServer` inside a plugin acceptable?

**Technically yes; it is used in-tree — but it is the wrong choice for a plugin, and you should
not do it.**

It *is* used, by a test-support library that deliberately does not want to be a plugin:
`packages/test-support/llm-mock-server/src/index.ts:11` does
`import { createServer } from 'node:http'`, and its `package.json` has **no `dsh` field at all**
(confirmed: `dsh` is `null`), i.e. it is a library the tests call, never a Loader entry.

Reasons not to do it in a plugin:

| | `ctx.webServer.register(...)` | private `http.createServer` |
|---|---|---|
| Port | Shares the one profile port (3080) — reachable from the GUI with a relative URL | Needs its own port; the GUI cannot reach it relatively, and you must invent config for it |
| Auth/trust posture | Same origin as the GUI; webserver bind policy already applies | New listener, new exposure surface, no policy |
| Same-origin fetch from the GUI | Works | Requires CORS + a second origin |
| Lifecycle | Disposer wired into your fiber; server shutdown handled by `WebServer`'s own `ctx.effect` (`packages/host/webserver/src/index.ts:243-253`) | You must dispose it yourself, or you leak a listening socket across reloads |
| Duplicate/collision detection | Throws on duplicate path | None |
| HMR / dev loop | Participates in the profile's single server | Invisible to it |

If you nonetheless need a private listener (e.g. a protocol the shared server cannot carry),
the mandatory minimum is to bind it inside `ctx.effect` and close it on dispose:

```ts
ctx.effect(() => {
  const server = createServer(...)
  server.listen(0, '127.0.0.1')
  return () => { server.close(); server.closeAllConnections() }
}, 'my-plugin: private listener')
```

Note `closeAllConnections()` — the webserver itself had to add it because *"Node does not
include upgraded sockets in `closeAllConnections()`"*
(`packages/host/webserver/src/index.ts:241-247`).

---

## 4. LLM adapter registration

You need this only if the plugin *is* a model provider. For a general HTTP + settings plugin you
can skip it.

### 4.1 The abstract class

`LlmAdapter` is exported from `@deepseek-ai/dsh-llm`
(`packages/llm/llm/src/index.ts:185-260`). **Only `stream` is abstract** — every other method has
a default:

```ts
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove the headers are added in the wire request or library header hook.
 */
export abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * Return the provider-owned retry policy captured with this route.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * Resolve all metadata available for one exact model.
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * Bind exact model metadata and the eventual request dispatch to one adapter generation.
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

| Method | Required | Purpose |
|---|---|---|
| `stream(options)` | **✅ abstract** | Yield the chunk stream. |
| `providerInfo(provider)` | optional | Display metadata; `id` must equal the route. |
| `providerRetryPolicy(provider)` | optional | Provider-owned retry policy. |
| `listModels(provider)` | optional | Advisory catalog. Absence must not reject requests. |
| `resolveModel(provider, model, signal)` | optional | Exact-model metadata (context window, modalities, reasoning). |
| `prepareCall(provider, model, signal)` | optional | Bind metadata + dispatch to one generation. Override it when your endpoint is *dynamic* (see §4.5). |

### 4.2 The streaming event types it must emit

`StreamChunk` is a closed union, `packages/llm/llm/src/types.ts:312-324`:

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    /** Replay metadata for a successful response; see {@link ReplayEnvelope}. */
    replayState?: ReplayEnvelope
  }
```

The request shape you receive, `packages/llm/llm/src/types.ts:340-357`:

```ts
/** A single model request, fully assembled. */
export interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). ...
   */
  messages: Message[]
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  temperature?: number
```

**The block protocol in practice:** open a block with `block-start` (carrying its `index` and
`blockType`), emit `*-delta` chunks against that index, close it with `block-end` (carrying the
assembled `ContentBlock`), then exactly one `finish`. `usage` may arrive before `finish`. **No
chunk may follow `finish`.**

The real translation loop, `packages/llm/llm-deepseek/src/translate.ts:104-163`:

```ts
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      yield {
        /* ... finish, with mapped reason ... */
      }
```

```ts
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        if (reasoning.length > 0) {
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
        }
```

```ts
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        if (content.length > 0) {
          yield { type: 'text-delta', index: textBlock.index, text: content }
        }
```

```ts
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
```

Its module doc (`packages/llm/llm-deepseek/src/translate.ts:1-7`) states the ordering contract:

> Translate DeepSeek SSE payloads with one stateful harness block per content, reasoning, or tool
> call index. An empty initial reasoning delta does not open a block. Finish reason and the latest
> usage are deferred until `[DONE]`, covering both finish-attached and trailing usage-only shapes
> while ensuring no chunk follows `finish`.

`FinishReason` mapping is a plain switch (`packages/llm/llm-deepseek/src/translate.ts:30-46`):

```ts
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
```

### 4.3 The provider-route registration call

Two calls, in this order. Both from `packages/llm/llm-deepseek/src/index.ts`.

**1. Declare the provider as user-configurable** (so it appears in the Models settings UI):

```ts
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: NS, settingsPath: [] },
  ])
```

Signature (`packages/llm/llm/src/index.ts:452-458`):

```ts
   * Registers the set of providers this plugin owns, making each visible to the
   * configuration surface ...
   * Registration is all-or-nothing: an empty list, invalid
   * entry, or a provider already declared by any registration throws
   * `LlmError` without registering the rest. Disposed with the fiber.
   * @param entries - every configurable provider this plugin owns.
   * @returns a handle that withdraws all of them, and can atomically replace them.
   */
  registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle {
```

**2. Register the adapter against one or more routes:**

```ts
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
```

Signature (`packages/llm/llm/src/index.ts:357-365`):

```ts
   * @param providers - provider route names this adapter owns.
   * @param adapter - the adapter instance.
   * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle {
```

The returned handle is a **disposer function with an atomic `.replace()`**
(`packages/llm/llm/src/index.ts:262-279`):

```ts
export interface AdapterRegistrationHandle {
  /** Release every route this registration currently holds. */
  (): void
  /**
   * Replace this registration's routes with `providers`, keeping the same
   * adapter instance. The candidate set is validated in full first — a
   * conflict with another adapter, an invalid name, or bad provider metadata
   * throws and leaves the current routes untouched — and the swap itself is
   * one synchronous section, so no request can observe a gap. ...
   */
```

### 4.4 A real provider plugin, end to end

`packages/llm/llm-deepseek/src/index.ts`. The essential skeleton (imports and the model catalog
elided):

```ts
export const name = 'llm-deepseek'
export const inject = ['llm']

const NS = settingsNamespace('llm-deepseek')
/** The single provider route this plugin owns. */
const PROVIDER = 'deepseek-official'

const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: DEFAULT_CONTEXT_WINDOW },
  // ...
]

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  // ...
})

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  // ...
  const options = (): ResolvedDeepSeekOptions => { /* resolve per request */ }
  options()

  const adapter = new DeepSeekAdapter({
    options,
    resolveApiKey,
    resolveUserId,
    resolveAttachments: () => ctx.get('attachments'),
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: NS, settingsPath: [] },
  ])

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
```

Note `apiKeyEnv: z.string().role('credential-ref')` and the corresponding credential lookup —
the plugin stores a **reference** (an env var name), never a literal key
(`packages/llm/llm-deepseek/src/index.ts`, `resolveApiKey`, and the `DeepSeekConnectionOptions`
doc: *"Configuration carries only this name — a literal key is not a configuration value."*):

```ts
    throw new LlmError(
      `llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
```

The adapter's concrete methods (`packages/llm/llm-deepseek/src/adapter.ts:354-431`):

```ts
export class DeepSeekAdapter extends LlmAdapter {
  private readonly files: DeepSeekFileStore

  constructor(private readonly config: DeepSeekAdapterOptions) {
    super()
    this.files = config.resolveFiles?.() ?? new DeepSeekFileStore()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.modelInfoFor(this.config.options(), provider, model))
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options()
    return Promise.resolve({
      model: this.modelInfoFor(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options())
  }
```

and the transport tail — fetch, then delegate chunk emission
(`packages/llm/llm-deepseek/src/adapter.ts:655-662`):

```ts
      if (!response.body) {
        throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
      }

      yield* translate(parseSse(response.body, onActivity))
      return
```

**Key design point:** the adapter is transport-only and reads connection facts through a thunk
(`options: () => DeepSeekConnectionOptions`) *once per operation*. The plugin owns validation,
layering, and credential policy. That is why a settings change reaches the next request with no
re-registration.

### 4.5 `prepareCall` and the dynamic-configuration problem

If your endpoint, catalog, or key can change at runtime, override `prepareCall` (as DeepSeek
does) so one request cannot pair generation A's capabilities with generation B's endpoint. The
class doc (`packages/llm/llm/src/index.ts:238-246`) is explicit:

> Bind exact model metadata and the eventual request dispatch to one adapter generation.
> **Dynamic adapters override this** so settings changes between preparation and dispatch cannot
> combine one generation's capabilities with another's endpoint.

Conversely, anything the registry *captures at registration time* cannot be refreshed per
request. DeepSeek hits exactly this with the retry policy and calls `.replace()` instead
(`packages/llm/llm-deepseek/src/index.ts`):

```ts
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two, and an observer that reacted
    // to it would see this provider disappear and come back.
    registration.replace([PROVIDER])
```

### 4.6 Attribution headers

Non-negotiable, per the class doc (`packages/llm/llm/src/index.ts:185-190`):

> Every provider HTTP request must include `attributionHeaders()`; prove the headers are added in
> the wire request or library header hook.

`attributionHeaders` is exported from `@deepseek-ai/dsh-llm` and imported by the DeepSeek adapter
at `packages/llm/llm-deepseek/src/adapter.ts:10`.

---

## 5. Config schema & settings

### 5.1 Wiring a namespace — `installSettingsSection`

The canonical helper is exported from `@deepseek-ai/dsh-settings`
(`packages/settings/settings/src/index.ts:850-897`):

```ts
/**
 * Install the canonical optional-settings consumer wiring: while a settings
 * service exists, register `ns` with the consumer's composition entry as the
 * `base` layer and point the source thunk at the resolved scope; when the
 * service goes away (disposal, provider reload), fall back to the entry so
 * the consumer keeps working exactly as composed. The registration rides the
 * scoped fiber, so no settings service ever mounted means none of this runs.
 * @param ctx - consumer plugin context owning the wiring.
 * @param ns - the consumer-owned settings namespace.
 * @param schema - schema resolving the namespace (typically the plugin Config).
 * @param entry - the consumer's composition entry config, used as `base`.
 * @param hooks - source sink and change notification.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, {
      base: entry,
      ...hooks.validate === undefined ? {} : { validate: hooks.validate },
    })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      // This disposer runs for two different reasons. A settings provider
      // detaching leaves the consumer running, so it must fall back to its
      // composition entry and re-judge what it derived. ...
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}
```

Because it wraps `ctx.inject(['settings'], …)`, **you do not put `settings` in your own
`inject`** — your plugin works with or without a settings provider. The `docs/cookbook/adding-a-settings-card.md`
formulation:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const MY_PLUGIN_NS = settingsNamespace('my-plugin')

export interface Config {
  endpoint?: string
  retries?: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string(),
  retries: z.number().step(1).min(0).default(3),
})

export function apply(ctx: Context, config: Config) {
  let source = () => config
  installSettingsSection(ctx, MY_PLUGIN_NS, Config, config, {
    // Constraints the schema cannot express refuse the write, not the next use.
    validate: value => void assertReachable(value.endpoint),
    setSource: (current) => { source = current },
    onChange: () => { rebuildFromSettings(source()) },
  })
}
```

**Three layers.** The namespace resolves to a merged document over a `base` (your `cordis.yml`
entry config), a `user` layer (what the settings UI wrote), and the resolved `value`. Per the
cookbook: *"the resolved `value`, the composition `base`, and the raw `user` layer, whose key
**presence** — not its value — is what marks a field overridden."*

**Two schema roles worth knowing** (cookbook):

- `role('secret')` — *"keeps its value off every response; the card writes such a field into an
  `update`/`mutate` payload, or addresses a credential reference through the `credentials`
  domain instead."* DeepSeek uses `role('credential-ref')` for the env-var name instead of a
  literal secret.
- `applies: 'restart'` — *"tells a configuration surface the owner acts on a change only at the
  next start."*

### 5.2 How values reach the Web settings UI

The join key is the **namespace string**, spelled identically in both halves. Nothing is
registered centrally. From `docs/cookbook/adding-a-settings-card.md`:

> the Host serves every registered settings namespace, and the **Plugins** section keys its cards
> on the namespace they edit, so a plugin that registers both halves is paired up automatically.

- **Host half**: `installSettingsSection(ctx, NS, Config, config, …)` → the namespace becomes
  *served*.
- **Browser half**: register a card into the `settings.plugin.item` slot **with `key: NS`**.
- The tab *"reads which namespaces the Host serves and dispatches one slot key per namespace. A
  card is rendered when the Host serves its key and skipped when it does not, so a deployment
  that never composed the Host half shows no trace of the card."*

Three real slot mechanisms to choose from:

| Slot | Kind | Needs a Host namespace? | Use when |
|---|---|---|---|
| `settings.plugin.item` | `keyed` | **Yes** — `key` must equal the namespace | You want a dedicated, full configuration card in the **Plugins → Configuration** tab. Best fit for a plugin whose `Config` is its settings. |
| `settings.section` | `list` | No | You want your **own top-level settings page** (its own nav row in the Settings panel). |
| `settings.general.item` | `list` | No | You want a small card on the **General** page. |

**All three are `list`/`keyed` — none is `single`**, so registering into any of them *adds* a
row and never shadows the shipped UI. `settings.section` is declared as
(`packages/client/ui-settings/src/client/contract/slots.ts:53`):

```ts
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
```

with owner props (`packages/client/ui-settings/src/client/contract/slots.ts:122-125`):

```ts
export interface SettingsSectionOwnerProps {
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
}
```

`settings.section` is the right choice when your plugin owns a whole page rather than one config
card — it was authored for exactly that (*"A feature owns its own settings pages — adding a
setting never means editing the shell"*). A real registration, from
`packages/client/ui-settings-plugins/src/client/index.ts`:

```ts
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugins',
    order: 15,
    label: () => t('nav'),
    locale: NS,
    inject: sectionInjected,
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  }, PluginsSettingsSection))
```

Note `label: () => t('nav')` — for a `list`-kind nav entry the label is a **function**, and
`children` is how an owner declares the child slots it will render. A page that needs no child
slots can omit `children` entirely.

`settings.general.item` is declared by ui-settings-general
(`packages/client/ui-settings-general/src/client/index.ts:171-176`):

```ts
    id: 'general',
    order: 0,
    label: () => t('general.nav'),
    locale: NS,
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
  }, GeneralSection))
```

Being `list`-kind, it takes `id` + `order` on the registration rather than a `key`.

The shipped roster confirms the cards you will join: the `ui-settings-plugins` row is mounted in
the web bundle (`packages/bundle/web-app/cordis.patch.yml`):

```yaml
    # Plugin configuration: the host-plane sections a user owns, as expandable
    # cards. A namespace this deployment does not expose renders nothing.
    - id: ui-settings-plugins
      name: '@deepseek-ai/dsh-client-ui-settings-plugins'
```

### 5.3 Host↔client sync — `ctx.settingsScope`

The browser half reads and writes through the `settingsScope` client service. From the cookbook:

```ts ignore-check
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the keyed slot's declaration. Cross-plugin collaboration goes
// through cordis services; a value import fails the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const card = new MyPluginCardController(ctx.settingsScope.bind({ namespace: 'my-plugin' }))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'my-plugin',
    locale: 'settings.myPlugin',
    inject: () => card.inject(),
  }, MyPluginCard),
  )
}
```

API surface (cookbook):

- `ctx.settingsScope.bind({ namespace })` → a scope.
- Snapshot: `value` (resolved), `base` (composition layer), `user` (raw user layer).
- `scope.set(field, value)` — store one field.
- `scope.unset(field)` — clear it back to the composition layer.
- *"each write is fenced with the revision it read"* — so two surfaces cannot clobber each other.
- `ctx.settingsScope.describe()` — which namespaces the Host serves (the shared describe mirror,
  refreshed on document commits and reconnects).

**Write path:** the card stages drafts; a save is *"the single point where a draft becomes a
document mutation"* (`packages/client/ui-settings-plugins/src/client/fields.tsx:1-8`). The
controls themselves never write:

```tsx
/**
 * Hand-written controls for the plugin configuration forms. Each renders one
 * field's label, its staged text, whether saving would leave an override, and
 * — when one stands — the reset that stages a clear back to the composition
 * layer. Nothing here writes: a control reports what the user typed, and the
 * card's save is the single point where a draft becomes a document mutation.
 */
```

`ctx.settingsScope` comes from `@deepseek-ai/dsh-client-ui-settings`, described as *"Settings
domain base plugin: the settings-namespace scope service and the canonical settings slot-type
contract."*

---

## 6. Client (web) plugins

### 6.1 The minimal complete client plugin

The smallest real one in the tree is `packages/client/ui-jobs/src/client/index.ts` — quoted in
full, because it is exactly the template you want:

```ts
/**
 * Background-job plugin, browser half: contributes one session-header action
 * that renders this session's `ctx.jobs` records. The data arrives entirely
 * through the `jobsBySession` list mirror, so the plugin issues no RPC and
 * holds no state of its own beyond popover visibility.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { JobListAction } from './JobListAction.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type JobKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}

export type { JobListActionProps } from './JobListAction.tsx'

/** Required services for locale registration and header-slot contribution. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-job: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'job-list',
      // After the subagent catalog: session lineage reads before process work.
      order: 20,
      locale: NS,
    }, JobListAction),
  )
}
```

Everything you need is visible here:

- `ClientContext` is a **type-only** import from `@deepseek-ai/dsh-client-runtime/client`.
- `inject` names **client services** (`sessions`, `slots`, `locale`), not host services.
- `locale: NS` on the registration is what puts the typed `t` standard seat on the component's
  props.
- Registration is wrapped in `ctx.slots.inject(slotName, () => …)` — this waits for the slot to
  be declared by its owner.

### 6.2 Slot names

Slots are declared by **declaration merging** into `SlotMap`
(`packages/client/ui-slots/src/index.ts:24`):

```ts
/** Slot contract table. Owners extend via declaration merging; entries are {@link SlotEntryDef}. */
export interface SlotMap {}
```

The real slot names available in the shipped web profile, extracted from the `interface SlotMap`
blocks of each owning package:

**Settings** (`packages/client/ui-settings/src/client/contract/slots.ts`,
`.../ui-settings-plugins/src/client/slot-contract.ts`):

```
settings.trigger          settings.header            settings.action
settings.close            settings.section           settings.plugins.tab
settings.onboarding       settings.general.item      settings.plugin.item
```

**Frame** (`packages/client/ui-layout/src/client/index.ts`):

```
sidebar        conversation        details        shell.overlay
root           (the built-in built-in render-tree root — DO NOT register)
```

**Sidebar** (`packages/client/ui-sidebar/src/client/contract/slots.ts`):

```
sidebar.brand.mark     sidebar.brand.name      sidebar.workspaces
sidebar.settings       sidebar.footer.action   sidebar.workspaces.directoryFlow
```

**Conversation** (`packages/client/ui-conversation/src/client/contract/slots.ts`):

```
conversation.session                        conversation.session.header
conversation.session.header.lineage         conversation.session.header.actions
conversation.session.header.utilities       conversation.view
conversation.chat.node                      conversation.chat.commandview
conversation.chat.turnTail                  conversation.chat.assistant-actions
conversation.message.images                 conversation.details.tool
conversation.composer                       conversation.composer.bar
conversation.composer.dock                  conversation.hero.workspace
conversation.hero.workspace.directoryFlow   conversation.hero.brand.mark
conversation.hero.agentPreset               conversation.input.dock
conversation.input.left                     conversation.input.right
conversation.input.attachments              conversation.input.plan
conversation.input.model                    conversation.input.overlay
```

**Tools / workspace:**

```
tool.call.toolview                          (packages/client/ui-tool/src/client/contract/slots.ts)
sidebar.workspaces.directoryFlow            (packages/client/ui-workspace/src/client/contract/slots.ts)
```

> **`root` is off-limits.** From `packages/client/runtime/src/client/slots.ts:27-34`:
> *"DO NOT register here. This is a single slot, so a second entry does not sit beside the frame —
> it shadows it."*

**For a settings page, use `settings.plugin.item`** (§5.2). Registration options seen in real
code: `name` (required), `id` (list/single kinds), `key` (keyed kinds), `order`, `label`,
`locale`, `inject`, `children`.

### 6.3 The UI kit — what actually exists

`@deepseek-ai/dsh-client-ui-primitives` — *"Pure React atoms for the dsh web UI: controls, icons,
markdown, and JSON inspectors (zero cordis)."* It is a **baseline module-table external**, so you
can import it with no `dsh.client.external` entry (§7.2).

Its real exports, from `packages/client/ui-primitives/src/index.ts`:

```ts
export { StateDot } from './StateDot.tsx'
export type { StateDotState } from './StateDot.tsx'
export { DisclosureRow } from './DisclosureRow.tsx'
export type { DisclosureRowProps } from './DisclosureRow.tsx'
export { Button } from './Button.tsx'
export type { ButtonVariant } from './Button.tsx'
export { Pill } from './Pill.tsx'
export { Input } from './Input.tsx'
export { Menu } from './Menu.tsx'
export type { MenuEntry, MenuItem, MenuSeparator, MenuLabel } from './Menu.tsx'
export { useAnchoredMaxHeight } from './useAnchoredMaxHeight.ts'
export { useAnchoredPosition } from './useAnchoredPosition.ts'
export type { AnchoredPositionOptions } from './useAnchoredPosition.ts'
export { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer.ts'
export { HoverCard } from './HoverCard.tsx'
export { Modal } from './Modal.tsx'
export { OnboardingSurface } from './OnboardingSurface.tsx'
export { RiskConfirmation } from './RiskConfirmation.tsx'
export type { RiskConfirmationProps } from './RiskConfirmation.tsx'
export { ConnectionBanner } from './ConnectionBanner.tsx'
export { FishLogo } from './FishLogo.tsx'
export { BrandWordmark } from './BrandWordmark.tsx'
export type { BrandWordmarkProps } from './BrandWordmark.tsx'
export { Tooltip } from './Tooltip.tsx'
export type { TooltipSide } from './Tooltip.tsx'
export { Toast } from './Toast.tsx'
export { writeClipboard } from './clipboard.ts'
export { JsonTree } from './JsonTree.tsx'
export type { JsonTreeProps, JsonTreeLabels } from './JsonTree.tsx'
export { TerminalBlock, DEFAULT_TERMINAL_MAX_LINES } from './TerminalBlock.tsx'
export type { TerminalBlockProps, TerminalBlockLabels } from './TerminalBlock.tsx'
export { ReadBlock, DEFAULT_READ_MAX_LINES } from './ReadBlock.tsx'
export type { ReadBlockProps, ReadBlockLine } from './ReadBlock.tsx'
export { DiffBlock, DEFAULT_DIFF_MAX_LINES } from './DiffBlock.tsx'
export type { DiffBlockProps, DiffHunk } from './DiffBlock.tsx'
export { SearchBlock, DEFAULT_SEARCH_MAX_LINES } from './SearchBlock.tsx'
export type { /* ... */ } from './SearchBlock.tsx'
export { WebBlock } from './WebBlock.tsx'
export type { WebBlockProps, WebSearchBlockProps, WebFetchBlockProps, WebSourceView } from './WebBlock.tsx'
export { CodeBlock } from './markdown/CodeBlock.tsx'
export type { CodeBlockProps } from './markdown/CodeBlock.tsx'
export { JsonBlock } from './markdown/JsonBlock.tsx'
export { MarkdownText } from './markdown/MarkdownText.tsx'
export type { MarkdownCodeLabels, MarkdownFileMentions } from './markdown/MarkdownText.tsx'
export { MessageText } from './markdown/MessageText.tsx'
export { extractMarkdownPlainText } from './markdown/plain-text.ts'
export type { MarkdownPlainTextMode, MarkdownPlainTextOptions } from './markdown/plain-text.ts'
export * from './icons/index.tsx'
```

**⚠️ There is no `Switch`, `Toggle`, `Progress`, `Slider`, `Select`, `Checkbox`, or `Field`
atom.** A repo-wide search for those exports across `packages/client/**/*.tsx` returns nothing.
This is a real gap, and it matters if you were planning a settings form:

- **Checkbox:** use a native `<input type="checkbox">`. DSH's own settings cards do exactly this
  — `packages/client/ui-settings-plugins/src/client/fields.tsx` writes its controls by hand and
  imports only CSS, not a kit.
- **Select / dropdown:** use `Menu`, or a native `<select>`.
- **Progress bar:** you must build it (a styled `<div>`; the theme tokens in
  `docs/web-styling.md` are the styling contract).
- **Switch:** not available; use a checkbox.

The components actually worth using, with their real signatures:

**`Button`** (`packages/client/ui-primitives/src/Button.tsx:17-25`):

```tsx
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

export function Button({ variant = 'ghost', size = 'md', icon, className, children, ...rest }: {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  className?: string | undefined
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
```

**`Input`** (`packages/client/ui-primitives/src/Input.tsx:12-20`) — single-line text only:

```tsx
export function Input({ icon, className, ...rest }: {
  icon?: ReactNode
  className?: string
} & InputHTMLAttributes<HTMLInputElement>) {
```

**`StateDot`** (`export type { StateDotState }`) — status dot; states used in real code are
`'ongoing' | 'warning' | 'done' | 'error'` (`packages/client/ui-jobs/src/client/JobListAction.tsx:38-48`).

Others worth knowing: `Pill` (badges), `DisclosureRow` (collapsible row), `Modal`,
`RiskConfirmation` (destructive confirmation), `Tooltip`, `Toast`, `HoverCard`, `Menu`
(dropdown), `JsonTree`, `MarkdownText`/`MessageText`, `CodeBlock`, `TerminalBlock`, `DiffBlock`,
`SearchBlock`, `ReadBlock`, `WebBlock`, plus the `icons` barrel
(`IconChevronDownOutline14`, …).

**Import statement form**, from `packages/client/ui-jobs/src/client/JobListAction.tsx:1-8`:

```tsx
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { JobView } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14, StateDot, useDismissOnOutsidePointer, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './JobListAction.module.css'
```

Note `react` is imported bare (it is a baseline external), types come from
`@deepseek-ai/dsh-client-ui-slots`, and CSS Modules (`./X.module.css`) are supported by the
build preset.

**Props types** come from `@deepseek-ai/dsh-client-ui-slots`. From
`packages/client/ui-jobs/src/client/JobListAction.tsx:11-12`:

```tsx
export type JobListActionProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS>
```

`PropsRuntime<SlotName>` gives the slot's runtime props; `PropsLocale<typeof NS>` adds the typed
`t`. `packages/client/ui-slots/src/index.ts:76-80` describes the seat:

> `locale:` … puts the typed `t` standard seat on the component props.

### 6.4 i18n via `@deepseek-ai/dsh-client-locale`

Two steps: (1) a dictionary module, (2) `ctx.locale.register(NS, { zh, en })`.

**The dictionary module** — `packages/client/ui-jobs/src/client/locales.ts`, quoted in full
because it is the exact pattern to copy:

```ts
/** `job` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'job'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'count.live.one': '{count} 个后台任务运行中',
  'count.live.other': '{count} 个后台任务运行中',
  'count.idle.one': '{count} 个后台任务',
  'count.idle.other': '{count} 个后台任务',
  'list.aria': '后台任务',
  'status.running': '运行中',
  'status.stopping': '正在停止',
  'status.completed': '已完成',
  'status.killed': '已取消',
  'status.failed': '已失败',
  'duration.seconds': '{seconds}秒',
  'duration.minutes': '{minutes}分{seconds}秒',
  'duration.hours': '{hours}小时{minutes}分',
  'duration.title.live': '已运行 {duration}',
  'duration.title.done': '耗时 {duration}',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<JobKey, string> = {
  'count.live.one': '{count} background job running',
  // ...
}

/** Key domain of the `job` namespace (zh is the source of truth). */
export type JobKey = keyof typeof zh
```

Calling it **inside a component**, `packages/client/ui-jobs/src/client/JobListAction.tsx:49-51`:

```tsx
/** Human status word for the row and its accessible name. */
function statusLabel(status: JobView['status'], t: TranslateNS<typeof NS>): string {
  switch (status) {
    case 'running': return t('status.running')
```

**The declaration merge** makes the namespace type-safe
(`packages/client/ui-jobs/src/client/index.ts:14-19`):

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}
```

`LocaleNamespaceMap` is the mirror of `SlotMap`
(`packages/client/ui-slots/src/index.ts:26-36`):

```ts
/**
 * Locale namespace table. Dictionary owners extend via declaration merging
 * (exactly like {@link SlotMap}, and declared in this entry module for the
 * same lexical-merge reason): the key is the namespace string, the value is
 * the union of its dictionary keys. Register sites declare one of these
 * namespaces (`locale:`), which puts the typed `t` standard seat on the
 * component props.
 */
export interface LocaleNamespaceMap {}
```

Interpolation uses `{name}` template params (`packages/client/ui-slots/src/index.ts:38-43`):

```ts
/**
 * Translate a dictionary key with optional `{name}` template params.
 * `K` narrows the accepted keys to the owning namespace's dictionary union
 * (plus the shared common vocabulary where composed).
 */
export type Translate<K extends string = string> =
  (key: K, params?: Record<string, unknown>) => string
```

Beyond component props, `ctx.locale` also offers `bind` (a pre-bound `t`) and `subscribe` — see
`packages/client/ui-settings-plugins/src/client/index.ts`:

```ts
  const t = ctx.locale.bind(NS)
```

and the snapshot/revision API used by the tab store:

```ts
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.plugins.tab', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
```

**`.i18n.yaml` files are a docs-build concern, not yours.** The `*.i18n.yaml` siblings throughout
`docs/` are the documentation translation pipeline (`docs/i18n/`). A client plugin's runtime
dictionaries live in TypeScript, as above.

### 6.5 A complete minimal settings-page client plugin

Combining §5.3 and §6.1–6.4. The host half is §1.6.

`src/client/locales.ts`:

```ts
export const NS = 'my-plugin'

export const zh = {
  'nav': '我的插件',
  'endpoint.label': '接口地址',
  'endpoint.hint': '该插件转发请求到的基础地址。',
  'retries.label': '重试次数',
  'save': '保存',
  'saved': '已保存',
} as const

export const en: Record<MyPluginKey, string> = {
  'nav': 'My Plugin',
  'endpoint.label': 'Endpoint',
  'endpoint.hint': 'Base address this plugin forwards requests to.',
  'retries.label': 'Retries',
  'save': 'Save',
  'saved': 'Saved',
}

export type MyPluginKey = keyof typeof zh
```

`src/client/index.ts`:

```ts
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls in the LocaleNamespaceMap merge and the settings slot contract.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { MyPluginCard } from './MyPluginCard.tsx'
import { en, NS, zh, type MyPluginKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'my-plugin': MyPluginKey
  }
}

/** `settingsScope` is the read/write service; `slots`+`locale` are the contribution seats. */
export const inject = ['slots', 'locale', 'settingsScope']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'my-plugin: dictionaries')

  const scope = ctx.settingsScope.bind({ namespace: NS })

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,                       // the join key, identical to the Host namespace
    locale: NS,
    inject: () => scope.snapshot(),  // whatever the card needs re-rendered on
  }, MyPluginCard))
}
```

`src/client/MyPluginCard.tsx`:

```tsx
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

export type MyPluginCardProps =
  PropsLocale<typeof NS> & { /* + whatever `inject` supplied */ }

export function MyPluginCard({ t, snapshot, scope }: MyPluginCardProps) {
  const [endpoint, setEndpoint] = useState(snapshot?.value?.endpoint ?? '')
  const [retries, setRetries] = useState(String(snapshot?.value?.retries ?? 3))

  return (
    <div>
      <label htmlFor="mp-endpoint">{t('endpoint.label')}</label>
      <Input
        id="mp-endpoint"
        value={endpoint}
        onChange={(event) => { setEndpoint(event.target.value) }}
      />
      <p>{t('endpoint.hint')}</p>

      <label htmlFor="mp-retries">{t('retries.label')}</label>
      {/* No Switch/Select atom exists (§6.3) — a native input is the honest choice. */}
      <input
        id="mp-retries"
        type="number"
        min={0}
        value={retries}
        onChange={(event) => { setRetries(event.target.value) }}
      />

      <Button
        variant="primary"
        onClick={() => { scope.set('endpoint', endpoint); scope.set('retries', Number(retries)) }}
      >
        {t('save')}
      </Button>
    </div>
  )
}
```

`package.json` — the dual-face manifest:

```jsonc
{
  "name": "dsh-plugin-my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-settings-plugins"
      ]
    }
  }
}
```

> `dsh.client.inject` here names **client packages**: it creates the module-graph edges so those
> packages' rows load before yours (and `dsh-client-ui-settings` is what provides
> `ctx.settingsScope`, `dsh-client-locale` what provides `ctx.locale`).
>
> **`dsh.bundle.patch` and `dsh.client` coexist in one manifest.** The bundle field supplies the
> host row (§2.2); the client field supplies the browser half.

---

## 7. Available import specifiers

### 7.1 Host-side packages

| Package | Purpose (verbatim `description`) | Main exports you'll use |
|---|---|---|
| `@deepseek-ai/cordis` | The plugin framework itself. | `Context`, `Service`, `Service.init`, events |
| `@deepseek-ai/schemastery` | Schema validation. **Default export**, conventionally `z`. | `z.object`, `z.string`, `z.number`, `z.boolean`, `z.array`, `z.union`, `z.const`, `.default()`, `.role()` |
| `@deepseek-ai/dsh-host-webserver` | *"Web route-registration plugin: HTTP and upgrade routes, index transform taps, and static dist fallback; knows no harness concepts"* | default `WebServer`; the `ctx.webServer` service; types `WebRoute`, `WebRouteKind`, `WebUpgradeRoute`, `IndexInjection`; `renderIndexInjections` |
| `@deepseek-ai/dsh-settings` | *"Abstract user-settings seam (ctx.settings) for the DeepSeek Harness"* | `installSettingsSection`, `settingsNamespace`, `deepEqualJson`, `SettingsConflictError`, `SettingsProvider`, types `SettingsScope`, `SettingsNamespace`, `SettingsApplies` |
| `@deepseek-ai/dsh-home-paths` | *"Shared filesystem path helpers for the DeepSeek Harness"* | `resolveDshHome`, `dshHomePath`, `defaultDshHome`, `expandHomePath`, `dshHomeDisplay`, `canonicalizeWatchPath`, `DSH_HOME_ENV` |
| `@deepseek-ai/dsh-timeout` | *"Zero-dependency timeout/deadline primitive: clampTimeout, deadline, timeoutOf, TimeoutReason (timing + classification only, no termination)"* | `clampTimeout`, `deadline`, `timeoutOf`, `TimeoutReason`, `MAX_TIMER_DELAY_MS` |
| `@deepseek-ai/dsh-llm` | *"Provider-neutral LLM service interface for the DeepSeek Harness"* | default `LlmRuntime`; `LlmAdapter`, `LlmError`, `attributionHeaders`, `resolveRetryPolicy`, `RetryPolicySchema`, `assertUsableApiKey`; types `StreamChunk`, `GenerateOptions`, `LlmProviderInfo`, `LlmModelInfo`, `LlmResolvedModelInfo` |
| `@deepseek-ai/dsh-base` | *"The shared dsh core as a profile bundle: every profile's first patch layer…"* | **Not an import target** — it's a bundle layer (`dsh.profile.bundles[0]`). |
| `@deepseek-ai/dsh-web-app` | *"The dsh browser-surface bundle: the web patch layer over dsh-base plus the runtime glue plugin (frontend dist serving, web-surface prompt, bash runtime…)"* | **Not an import target** — a bundle layer. Subpath `@deepseek-ai/dsh-web-app/startup` is a real row. |
| `@deepseek-ai/dsh-credentials` | Credential store seam. | `credentialRef`, `CredentialRef` |
| `@deepseek-ai/dsh-launch-environment` | Launch env layers. | `launchEnvironmentOf`, `LaunchEnvironmentSnapshot` |
| `@deepseek-ai/dsh-host-apiproxy` | *"API gateway: the ApiProxy contract (api/), the fetch carrier pair (fetch/), and the host-side gateway plugin providing ctx.apiProxy"* | `ctx.apiProxy` |
| `@deepseek-ai/dsh-client-connection` | The `/api` bridge + trust fence. | `bridge`/`isTrustedApiRequest` via `./src/*` (§3.4, §3.7) |
| `@deepseek-ai/dsh-client-modules` | Node half of the client module system; serves `/plugins`. | `ctx.clientModules`, `stripClientSuffix` |
| `@deepseek-ai/dsh-tools` | Tool registration DSL. | `defineTool` |
| `@deepseek-ai/dsh-atomic-write` | *"Zero-dependency atomic file replacement and writer coordination."* | `writeFileAtomic`, `withFileLock` |

### 7.2 Client-side packages

| Package | Purpose (verbatim `description`) | Main exports |
|---|---|---|
| `@deepseek-ai/dsh-client-runtime` | *"Client core services: SlotRegistry, SessionRuntime (scope tree + object layer)"* | `ClientContext` (**type-only**, from `/client`) |
| `@deepseek-ai/dsh-client-ui-slots` | *"Slot registry pure core: SlotMap declaration merging, single register composition API, four-share props types, store-seat types, renderer install seam"* | `SlotMap`, `LocaleNamespaceMap`, `Translate`, `LocaleKeysOf`, `PropsRuntime`, `PropsLocale`, `TranslateNS`, `resolveSlotLabel` |
| `@deepseek-ai/dsh-client-ui-primitives` | *"Pure React atoms for the dsh web UI: controls, icons, markdown, and JSON inspectors (zero cordis)"* | §6.3 |
| `@deepseek-ai/dsh-client-locale` | *"Locale plugin: Host-backed zh/en preference, browser-derived fallback, locale snapshots, and typed namespace dictionaries"* | `ctx.locale` (`.register`, `.bind`, `.subscribe`, `.getSnapshot`) |
| `@deepseek-ai/dsh-client-ui-settings` | *"Settings domain base plugin: the settings-namespace scope service and the canonical settings slot-type contract"* | `ctx.settingsScope` |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | The Plugins settings page; owns the `settings.plugin.item` card slot. | Type-only for the slot contract |
| `@deepseek-ai/dsh-client-connection` | Browser transport. | `ConnectionHandle` (**type-only**, `/client`) |
| `@deepseek-ai/dsh-api-remotes` | Remote method transport. | `ctx.remote` (`.$on`, …), forwarded-event keys |
| `@deepseek-ai/dsh-client-hmr` | The reload chain (`/plugins/events` SSE). | — |

### 7.3 What a browser bundle may import for free

This is the single most constrained part of client plugin authoring. The baseline externals are
declared once, in `packages/client/web/src/platform.ts`:

```ts
/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
  '@deepseek-ai/dsh-client-runtime/client',
] as const
```

So the free list is **exactly**:

```
react
react/jsx-runtime
react-dom
react-dom/client
@deepseek-ai/cordis
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-runtime/client
```

Anything else follows one of three fates, enforced at build time by the **bundle purity gate**
(`packages/client/tsdown.client.ts`):

```ts
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null // requested module-table row: external wins
        if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${id}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
```

with the two allowlists in the same file:

```ts
/**
 * Wire/type layers a client bundle may inline: browser-safe contracts
 * with no runtime identity to share (no Symbol/instanceof/singleton state).
 * Everything else under @deepseek-ai/* is either a module-table entry
 * (external) or a leak the purity gate rejects.
 */
export const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand)(\/|$)/

const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
```

**The practical rules:**

1. Non-`@deepseek-ai` packages (zod, clsx, zustand…) are **inlined** into your bundle. Just
   import them; add them to `dependencies`.
2. `@deepseek-ai/*` value imports **must** be either baseline, in the `INLINE_SAFE` regex, or
   declared in `dsh.client.external` **and** be a client row that actually loads.
3. **Cross-plugin value imports are forbidden.** Collaborate through cordis services.
4. **Type-only imports are free** — they are erased before resolution. This is why every real
   client plugin is full of `import type {} from '...'` lines: they exist purely to pull in
   `declare module` merges (the `ctx.locale`, `ctx.settingsScope`, and `SlotMap` contracts).

---

## 8. Build/serve reality check

### 8.1 Host side: plain ESM, no bundling

**Yes — the host half is plain ESM JavaScript loaded directly by the Loader. DSH does not bundle
it.** Evidence:

- Every host `package.json` uses `"type": "module"` with `"main": "lib/index.js"` and an
  `exports["."]` pointing at a **prebuilt** file — e.g. `packages/host/webserver/package.json`.
  The `lib/` output is produced by the package's own build (`tsc` for the node half), never by
  the Loader.
- The loader resolves the entry `name` as an ordinary module specifier and `import()`s it. The
  name-resolution contract is the two-anchor walk in §2.3 — pure Node resolution.
- The existing third-party plugin proves out-of-tree viability: it ships `index.js` + `lib/*.js`
  as **hand-written ESM**, has **no build step at all** (`/Users/shiwenhui/code/home/dsh-plugin-content-studio/package.json`
  has no `build` script — only `"test": "node --test \"tests/*.test.js\""`), and works.

For a third-party host plugin the simplest correct choice is therefore:

- Author plain `.js` ESM, or author TypeScript and run your **own** `tsc`/`tsdown` to emit `lib/`.
- Point `main`/`exports["."]` at the emitted file.
- Never expect DSH to compile your source.

### 8.2 Client side: you must ship a prebuilt artifact in a specific format

**DSH does not bundle your client source either — it serves a file you must produce.** The node
half reads `exports["./client"]` off disk and serves those bytes:

`packages/client/modules/src/index.ts:449-460`:

```ts
    const clientRel = clientExportOf(pkgName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`client-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`)
    }
    const meta: PkgMeta = {
      clientPath: join(dirname(pkgPath), clientRel),
      ...
```

then it hashes the file for cache-busting (`initialBundleRevision`,
`packages/client/modules/src/index.ts:474-486`) and serves it via the `/plugins` prefix route as
`/plugins/<id>/client.js?rev=<sha1[:12]>`.

**The required artifact format** is a CJS closure factory handed to a global. Verbatim from
`packages/client/tsdown.client.ts`:

```ts
    format: 'cjs',
    platform: 'browser',
    ...
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
```

and the file's own doc header:

```ts
/**
 * Shared tsdown preset for UI plugin client bundles. Emits a closure-factory
 * artifact: the bundle calls window.__ModuleLoader__.load({id, factory})
 * and resolves externals through the injected require (loader module table —
 * cordis DI entities, no globals, no import map). CSS is compiled by
 * lightningcss inside the bundle: `x.module.css` yields its hashed class map
 * and injects a tagged style at factory execution, while `x.css?inline`
 * exports compiled text for a plugin-owned lifecycle effect.
 */
```

The sink contract is confirmed on the runner side
(`packages/extensions/cordis-client-runner/src/client/runtime.ts:98-103`):

```ts
/** The `window.__ModuleLoader__` registration sink (client-modules contract C6). */
interface ModuleLoaderSink {
  __ModuleLoader__?: {
    load(handoff: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void
  }
}
```

**This means a hand-written client bundle is completely viable** — the format is five lines of
wrapper, no bundler required:

```js
// lib/client.js  — hand-written, id must equal the package name
window.__ModuleLoader__.load({ id: "dsh-plugin-my-plugin", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require("react")
const { Button, Input } = require("@deepseek-ai/dsh-client-ui-primitives")

exports.inject = ["slots", "locale", "settingsScope"]
exports.apply = function apply(ctx) {
  // ... same body as the TypeScript version in §6.5 ...
}

return module.exports; } });
```

If you prefer a real bundler, reproduce the preset above with rolldown/esbuild/vite. Two details
that will bite you:

- **`require` is the only module access.** No `import` statements survive; every external must
  become `require("<specifier>")` answered by the module table.
- **CSS Modules hashing and injection are the preset's job** (`dsh-css-modules-inline`,
  `dsh-css-global-inline` in `packages/client/tsdown.client.ts`). If you hand-write the bundle,
  inject your own `<style>` tag and manage its removal in your disposer.

### 8.3 What `pnpm run dev:web` is — and why it won't help out-of-tree

`package.json` (the DSH repo root):

```json
"dev:web": "tsx scripts/dev-web.ts --poll",
```

Its module doc (`scripts/dev-web.ts:1-30`) is explicit about scope and about the silent-failure
mode:

> Watch-build for the web dev loop: rebuilds every artifact the browser reads from a source edit.
> **Reload signaling is not this script's business** — the host webserver stat-polls the bundles
> it serves and broadcasts `rebuilt` frames itself (`dsh web`), so **any process that rewrites
> `lib/client.js` files triggers reloads**; this script is merely the convenient way to keep them
> all rebuilt on source change.
>
> Three stages, because the compile shell links built lib products rather than sources:
> `tsc -b tsconfig.client.json` emits `lib/types` …, tsdown bundles `lib/index.js` and
> `lib/client.js`, and `vite build` rewrites `apps/web/dist`, which `dsh web` serves. **A missing
> stage does not fail — it silently shows the previous artifact, so an edit appears to do
> nothing.**
>
> Usage: `pnpm exec tsx scripts/dev-web.ts [--poll[=ms]]`. **Requires one prior `pnpm run build`** …

Crucially, its discovery step only scans **the DSH repo's own** `packages/*/*`
(`scripts/dev-web.ts:52-68`):

```ts
export function discoverPluginDirs(root = repoRoot): string[] {
  const dirs: string[] = []
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root }).sort()) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as {
      dsh?: { client?: { platform?: unknown } }
    }
    if (manifest.dsh?.client?.platform === 'web') dirs.push(dirname(manifestPath).split(sep).join('/'))
  }
  return dirs
}
```

**So `pnpm run dev:web` is a DSH-repo-internal tool. It will not build your out-of-tree plugin**,
because your package does not live under `packages/*/*` in that checkout. (And per the
cookbook, *"That preset is not published today, so a package outside this repository has to
reproduce the same output format itself."*)

### 8.4 What exactly must a developer run?

**Host-only change:**

```sh
# 1. edit your plugin's .js (or re-run your own tsc/tsdown)
# 2. restart the profile
"$DSH" --profile web
```

Host plugins load at boot. There is no hot reload of host code in a normal profile — the web
layer explicitly disables shared HMR:

```yaml
# TODO: Re-enable shared HMR for Web after its reload lifecycle is tested.
- id: hmr
  disabled: true
```

**Client change — the good news:** the reload chain is **already mounted and always on**. From
`packages/bundle/web-app/cordis.patch.yml`:

```yaml
    # The client-plugin reload chain, always mounted: it is idle until a
    # rebuild watcher (pnpm run dev:web) actually rewrites client bundles. It
    # is a row rather than a child of web-runtime because its node half is a
    # client-side package, which a host-side bundle cannot import.
    - id: client-hmr
      name: '@deepseek-ai/dsh-client-hmr'
```

and the HMR plugin's node half (`packages/client/hmr/src/index.ts:1-8`):

> HMR plugin, node half: the host end of the dev reload chain. One interval stat-polls every graph
> row's client bundle (**polling by design: network mounts deliver no inotify events**), reports
> content changes through `clientModuleHost.rebuilt(id)`, and serves the `/plugins/events` SSE
> channel broadcasting graph/rebuilt frames to the browser half. **The web bundle mounts this row
> unconditionally: without a rebuild watcher rewriting client bundles, the poll observes no
> changes and the chain stays idle.**

Therefore, for an out-of-tree client plugin:

```sh
# 1. rebuild ONLY your artifact (any tool you like — the poll watches the file)
your-build-command     # must rewrite node_modules/dsh-plugin-my-plugin/lib/client.js

# 2. the running GUI stat-polls that file (default every 500ms,
#    client-hmr's pollIntervalMs), notices the new content hash, and
#    pushes a `rebuilt` frame over /plugins/events
#
# 3. the browser fetches /plugins/<id>/client.js?rev=<new hash> and remounts
#    the plugin row -> NO manual page refresh strictly required, but refresh
#    if you changed SlotMap/declaration-merging shape or the boot graph
```

**Gotchas that make a change silently not appear:**

1. **The package name must be resolvable from the profile.** The HMR poll watches the path the
   node half resolved at activation; if resolution failed, or you edited a different copy, the
   watcher is watching something else. Verify the file the server would serve resolves to the
   file you edited.
2. **The row must be enabled and composed.** `resolveMeta` returns `null` unless
   `dsh.client.platform === 'web'` (`packages/client/modules/src/index.ts:453`) and
   `processOne` skips entries that are disabled or have no live fiber
   (`packages/client/modules/src/index.ts:489-495`).
3. **Package metadata is cached forever.** From the module doc
   (`packages/client/modules/src/index.ts:14-20`):
   *"Package metadata (including the negative 'not a client package' verdict) is cached per name
   and never expires — **plugin-set changes take effect on restart**; bundle content changes
   reach the graph only through `ClientModuleRegistry.rebuilt`."*
   So: **content change → reload; adding/removing/renaming a plugin, or fixing a `dsh.client`
   declaration → restart the profile.**
4. **If the bundle is missing entirely** you get a loud startup error, not a silent blank:
   `packages/client/modules/src/index.ts:79` —
   `const CLIENT_BUNDLE_BUILD_INSTRUCTION = 'run \`pnpm run build\` before launch'`, surfaced as
   *"client bundle not found; run `pnpm run build` before launch:"* with the package and path.
   (That instruction assumes the DSH repo; for your plugin it means "build your own artifact".)
5. **Adding a `dsh.client.external` or changing `dsh.client.inject` also needs a restart** — it
   changes the boot graph, and `pkgMeta` is cached.

**Editing the DSH app's own client packages (not your plugin):** that *is* the `dev:web` loop.
You need one prior `pnpm run build`, then `pnpm run dev:web` in the checkout, and it must not run
concurrently with `pnpm run build` (*"both write the same `lib/` and `apps/web/dist/` trees"*).
Changes to `apps/web` (the shell) additionally need `vite build` to rewrite `apps/web/dist`.

### 8.5 Summary table

| Change | Rebuild | Restart profile? | Refresh page? |
|---|---|---|---|
| Host `.js` logic | your own build (or none) | **yes** | — |
| `Config` schema / `cordis.patch.yml` | none | **yes** | — |
| Client bundle content | **your own build** → rewrites `lib/client.js` | no | usually not (HMR push); refresh if in doubt |
| `dsh.client.*` / package added-removed | none | **yes** (metadata cache never expires) | yes |
| `exports["./client"]` target changed | your own build | **yes** (path is cached) | yes |
| DSH's *own* `packages/client/*` | `pnpm run dev:web` (after one `pnpm run build`) | no | no (HMR) |
| `apps/web` shell | `vite build` / `pnpm run dev:web` | no | **yes** |

---

## Appendix: quick reference checklist

**Host plugin**

- [ ] Function form: named `export const name`, `export const inject`, `export const Config`,
      `export function apply` — and **no `export default`**.
- [ ] `installSettingsSection(ctx, settingsNamespace('my-plugin'), Config, config, { setSource, onChange })`
      for settings; do **not** add `settings` to `inject`.
- [ ] `ctx.effect(() => ctx.webServer.register({ kind, path, handler }), 'label')` for routes.
      Path is absolute, no trailing slash, namespaced away from `/api` and `/plugins`.
- [ ] Read bodies with the `for await (const chunk of req)` loop; write SSE by hand with a
      tracked response `Set` and `res.destroy()` on dispose.
- [ ] Never call `registerFallback` — frontend-static owns it.
- [ ] Do not rely on CORS; same-origin needs none, and there is no token auth.

**Packaging**

- [ ] `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` in `package.json`.
- [ ] `cordis.patch.yml` is a top-level array: `- insert: [{ id, name }]`.
- [ ] Install with `"$DSH" plugin --profile web add <abs-path>`; verify the package name landed in
      `dsh.profile.bundles`.

**Client plugin**

- [ ] `"exports": { "./client": ... }` + `"dsh": { "client": { "platform": "web", "inject": [...] } }`.
- [ ] Artifact is a CJS factory: `window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports; } })`.
- [ ] Only `react*`, `@deepseek-ai/cordis`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`, and
      `dsh-client-runtime/client` are free; everything else is `dsh.client.external` + a real row,
      or inlined, or forbidden (purity gate).
- [ ] Register the card into `settings.plugin.item` with `key` = the Host settings namespace, and
      read/write via `ctx.settingsScope.bind({ namespace })`.
- [ ] No `Switch`/`Select`/`Progress` atoms exist — use native elements or build your own.
