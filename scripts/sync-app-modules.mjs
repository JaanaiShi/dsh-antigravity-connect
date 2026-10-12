/**
 * Sync the local `node_modules` layer from the *shipped app bundle*.
 *
 * Why this exists: a DSH plugin is loaded by the Electron app, which resolves
 * `@deepseek-ai/*` from the packages vendored inside `app.asar` — not from a
 * source checkout and not from `~/.dsh/profiles/node_modules`. Those can be a
 * different (often older) release, so building against them produces a plugin
 * that imports symbols the app does not have. That failure is silent at author
 * time and only surfaces as `failed to import` at boot, with no stack trace.
 *
 * Running this before `npm test` makes the tests exercise the same package
 * versions the app will actually load.
 *
 * Usage:
 *   node scripts/sync-app-modules.mjs [--asar <path>] [--out <dir>]
 *
 * @module dsh-antigravity-connect/scripts/sync-app-modules
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync, lstatSync, symlinkSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
/** Where the app keeps its vendored dependency tree inside the archive. */
const ARCHIVE_MODULES = '/dsh/node_modules/'

const { values } = parseArgs({
  options: {
    asar: { type: 'string', default: DEFAULT_ASAR },
    out: { type: 'string', default: 'node_modules' },
    profile: { type: 'string', default: join(process.env.HOME ?? '', '.dsh/profiles/node_modules') },
  },
})

const outDir = resolve(values.out)
const asarPath = resolve(values.asar)

if (!existsSync(asarPath)) {
  console.error(`sync-app-modules: no app bundle at ${asarPath}`)
  console.error('Pass --asar <path> if DeepSeek Harness is installed elsewhere.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Read the archive. The format is a small pickle preamble followed by a JSON
// index; every file's bytes live at a fixed offset after the index.
// ---------------------------------------------------------------------------

const archive = readFileSync(asarPath)
const jsonSize = archive.readUInt32LE(12)
let jsonStart = 16
// The JSON payload is aligned with padding, so scan to its opening brace.
while (archive[jsonStart] !== 0x7b) jsonStart++
const index = JSON.parse(archive.subarray(jsonStart, jsonStart + jsonSize).toString('utf8'))
const dataStart = 8 + archive.readUInt32LE(4)

/**
 * Flatten the archive's file index.
 * @param {object} node - one directory node.
 * @param {string} prefix - path accumulated so far.
 * @param {object[]} out - accumulator.
 * @returns {object[]} every file entry with its path, offset, and size.
 */
function flatten(node, prefix, out = []) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix + '/' + name
    if (entry.files) flatten(entry, path, out)
    else out.push({ path, offset: Number(entry.offset), size: entry.size })
  }
  return out
}

const files = flatten(index, '')
const byPath = new Map(files.map(entry => [entry.path, entry]))

/**
 * Read one archived file.
 * @param {{ offset: number, size: number }} entry - the index entry.
 * @returns {Buffer} the file's bytes.
 */
function readEntry(entry) {
  return archive.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size)
}

// ---------------------------------------------------------------------------
// Write the layer.
// ---------------------------------------------------------------------------

// Start clean: a stale entry here is exactly the trap this script exists to
// prevent, so never merge with what was there before.
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

/** Replace one package directory with the archive's copy. */
function extractPackage(name) {
  const prefix = `${ARCHIVE_MODULES}${name}/`
  const owned = files.filter(file => file.path.startsWith(prefix))
  if (owned.length === 0) return undefined
  rmSync(join(outDir, name), { recursive: true, force: true })
  for (const file of owned) {
    const destination = join(outDir, file.path.slice(ARCHIVE_MODULES.length))
    try {
      // A symlink left by an earlier layer must not be written through.
      if (lstatSync(destination).isSymbolicLink()) rmSync(destination, { force: true })
    } catch {
      // Not existing is the ordinary case.
    }
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, readEntry(file))
  }
  const manifest = byPath.get(`${prefix}package.json`)
  if (manifest === undefined || manifest.size === 0) return undefined
  try {
    return JSON.parse(readEntry(manifest).toString('utf8'))
  } catch {
    // An entry the archive records but does not carry (an unpacked stub) is
    // not usable manifests; the profile fallback below covers it.
    return undefined
  }
}

// 1) The vendored workspace scope, wholesale. These are the packages a plugin
//    actually imports; taking every one guarantees the transitive closure.
const scopes = ['@deepseek-ai']
const vendorRoots = new Set()
for (const file of files) {
  if (!file.path.startsWith(ARCHIVE_MODULES)) continue
  const rest = file.path.slice(ARCHIVE_MODULES.length)
  const [first, second] = rest.split('/')
  if (first === undefined) continue
  if (first.startsWith('@')) {
    if (!scopes.includes(first)) scopes.push(first)
  } else if (second !== undefined) {
    vendorRoots.add(first)
  }
}

let packages = 0
for (const scope of scopes) {
  const prefix = `${ARCHIVE_MODULES}${scope}/`
  const names = new Set()
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue
    const name = file.path.slice(prefix.length).split('/')[0]
    if (name !== undefined && name.length > 0) names.add(name)
  }
  mkdirSync(join(outDir, scope), { recursive: true })
  for (const name of names) {
    if (extractPackage(`${scope}/${name}`) !== undefined) packages++
  }
}
console.log(`sync-app-modules: extracted ${packages} scoped packages`)

// 2) The plain third-party packages those scoped packages depend on, walked as
//    a closure so a nested dependency is never missed.
const pending = [...vendorRoots]
const done = new Set()
while (pending.length > 0) {
  const name = pending.shift()
  if (done.has(name)) continue
  done.add(name)
  const manifest = extractPackage(name)
  if (manifest === undefined) continue
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (!done.has(dep)) pending.push(dep)
  }
}

// 3) Anything the profile layer has that the archive does not, linked rather
//    than copied. The app resolves these the same way, so the tests see the
//    same graph the runtime would.
const profileLayer = resolve(values.profile)
let linked = 0
if (existsSync(profileLayer)) {
  /** Link one directory entry when the layer does not already have it. */
  const linkIfAbsent = (from, to) => {
    if (existsSync(to)) return false
    symlinkSync(from, to)
    return true
  }
  for (const entry of readdirSync(profileLayer, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(profileLayer, entry.name)
      if (!existsSync(scopeDir)) continue
      mkdirSync(join(outDir, entry.name), { recursive: true })
      for (const inner of readdirSync(scopeDir)) {
        if (linkIfAbsent(join(scopeDir, inner), join(outDir, entry.name, inner))) linked++
      }
      continue
    }
    if (linkIfAbsent(join(profileLayer, entry.name), join(outDir, entry.name))) linked++
  }
}
console.log(`sync-app-modules: linked ${linked} fallback packages from the profile layer`)
console.log(`sync-app-modules: ${outDir} now mirrors the shipped app's dependency graph`)
