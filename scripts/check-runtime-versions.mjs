/**
 * Fail fast when the local dependency layer does not match the shipped app.
 *
 * A DSH plugin is loaded by the Electron app against the `@deepseek-ai/*`
 * packages vendored inside `app.asar`. Authoring against a source checkout or
 * `~/.dsh/profiles/node_modules` can silently pick up a different release, and
 * a missing export only shows up at boot as `failed to import` — with the
 * offending symbol nowhere in the message. This guard turns that into an
 * actionable failure before the tests run.
 *
 * Usage:
 *   node scripts/check-runtime-versions.mjs [--asar <path>] [--quiet]
 *
 * @module dsh-antigravity-connect/scripts/check-runtime-versions
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

const { values } = parseArgs({
  options: {
    asar: { type: 'string', default: DEFAULT_ASAR },
    quiet: { type: 'boolean', default: false },
  },
})

/** Packages this plugin imports at runtime, and the symbols it needs from each. */
const REQUIREMENTS = {
  '@deepseek-ai/dsh-llm': [
    'LlmAdapter', 'LlmError', 'ToolCallId', 'ReasoningEffortId', 'attributionHeaders',
    'QUOTA_EXCEEDED_CODE', 'EMPTY_RESPONSE_CODE', 'CONTEXT_WINDOW_EXCEEDED_CODE',
  ],
  '@deepseek-ai/dsh-timeout': ['MAX_TIMER_DELAY_MS'],
  '@deepseek-ai/dsh-home-paths': ['dshHomePath'],
  '@deepseek-ai/dsh-host-webserver': ['WebServer'],
  '@deepseek-ai/schemastery': ['default'],
}

const require = createRequire(import.meta.url)

/**
 * Read the app's copy of one package's manifest out of the archive.
 * @param {string} packageName - package to look up.
 * @returns {string | undefined} the version the app ships.
 */
function appVersionOf(packageName) {
  const asarPath = resolve(values.asar)
  if (!existsSync(asarPath)) return undefined
  const archive = readFileSync(asarPath)
  const jsonSize = archive.readUInt32LE(12)
  let jsonStart = 16
  while (archive[jsonStart] !== 0x7b) jsonStart++
  const index = JSON.parse(archive.subarray(jsonStart, jsonStart + jsonSize).toString('utf8'))
  const dataStart = 8 + archive.readUInt32LE(4)
  const prefix = `/dsh/node_modules/${packageName}/`
  const flatten = (node, path, out = []) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const full = path + '/' + name
      if (entry.files) flatten(entry, full, out)
      else out.push({ path: full, offset: Number(entry.offset), size: entry.size })
    }
    return out
  }
  const manifest = flatten(index, '').find(file => file.path === `${prefix}package.json`)
  if (manifest === undefined || manifest.size === 0) return undefined
  try {
    const raw = archive.subarray(dataStart + manifest.offset, dataStart + manifest.offset + manifest.size)
    return JSON.parse(raw.toString('utf8')).version
  } catch {
    return undefined
  }
}

const problems = []
const report = []

for (const [packageName, symbols] of Object.entries(REQUIREMENTS)) {
  let entry
  try {
    entry = require.resolve(packageName)
  } catch {
    // An unresolvable peer is the loader's problem to report, not this guard's.
    continue
  }

  // Import rather than require: several of these peers are ESM-only, and
  // `require()` of an ESM-only package hands back a namespace whose `default`
  // is not the export the plugin's `import` would see.
  let module
  try {
    module = await import(packageName)
  } catch (error) {
    problems.push(`${packageName}: could not be loaded (${error.message})`)
    continue
  }

  const missing = symbols.filter(symbol => module[symbol] === undefined)
  if (missing.length > 0) {
    problems.push(`${packageName} is missing ${missing.join(', ')}`)
  }

  const localVersion = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version
  const shipped = appVersionOf(packageName)
  // A symlinked package points at a checkout rather than the app's own copy,
  // which is the usual way a mismatched version gets picked up by accident.
  let symlinked = false
  try {
    symlinked = realpathSync(entry) !== entry
  } catch {
    // A resolution failure here is not worth failing the guard over.
  }
  report.push({ packageName, localVersion, shipped, symlinked })
}

if (problems.length > 0) {
  console.error('runtime-version check FAILED — the local layer is not the app\'s dependency graph:')
  for (const line of report) {
    const drift = line.shipped !== undefined && line.shipped !== line.localVersion
      ? `  (app ships ${line.shipped})`
      : ''
    console.error(`  ${line.packageName}@${line.localVersion}${drift}${line.symlinked ? '  [symlinked]' : ''}`)
  }
  console.error('')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nRun `npm run modules:sync` to mirror the shipped app, then re-run.')
  process.exit(1)
}

if (values.quiet !== true) {
  const llm = report.find(line => line.packageName === '@deepseek-ai/dsh-llm')
  const note = llm?.shipped === undefined ? '' : ` (app ships ${llm.shipped})`
  console.log(`runtime-version check OK — dsh-llm@${llm?.localVersion ?? '?'}${note}`)
}
