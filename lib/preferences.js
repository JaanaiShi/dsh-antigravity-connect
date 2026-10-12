/**
 * Small JSON preference store for user-level choices that are not operator
 * configuration: currently only which models appear in the picker.
 *
 * Deliberately separate from the harness settings section. Operator tunables
 * belong in a schema-validated settings namespace; a toggle a user flips in the
 * settings page is neither schema-shaped nor validated by the harness, and
 * routing it through that seam would mean two writers for one field.
 *
 * The store is deliberately blind to the model catalog. Which models exist is a
 * live fact from the backend, so validating ids against a local list here would
 * bake in a snapshot and silently drop a selection the moment the backend
 * renamed a route. Ids are stored as given; the adapter intersects them with
 * whatever the directory currently reports.
 *
 * @module dsh-antigravity-connect/preferences
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * One stored preference document.
 *
 * @typedef {object} Preferences
 * @property {string[]} enabledModelIds  model ids shown in the picker
 */

/**
 * Serialized, atomically written preference store.
 *
 * An absent or unreadable document means "everything the catalog offers", which
 * is the friendlier default: a user who just signed in sees models immediately
 * instead of an empty picker.
 */
export class PreferenceStore {
  /** @type {string} */
  #path

  /**
   * @param {string} path - absolute path of the JSON document.
   */
  constructor(path) {
    this.#path = path
  }

  /** Absolute path this store reads and writes. */
  get path() {
    return this.#path
  }

  /**
   * Read the stored preferences.
   *
   * An absent or unreadable document means "no explicit selection", which the
   * caller reads as "offer everything the directory reports" — the friendlier
   * default, since a user who just signed in should see models rather than an
   * empty picker.
   *
   * @returns {Promise<Preferences & { explicit: boolean }>} the preferences, and whether one was actually stored.
   */
  async read() {
    let parsed
    try {
      parsed = JSON.parse(await readFile(this.#path, 'utf8'))
    } catch {
      return { enabledModelIds: [], explicit: false }
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.enabledModelIds)) {
      return { enabledModelIds: [], explicit: false }
    }
    const seen = new Set()
    const enabled = []
    for (const id of parsed.enabledModelIds) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      enabled.push(id)
    }
    return { enabledModelIds: enabled, explicit: true }
  }

  /**
   * Replace the enabled-model set.
   *
   * An empty list is stored as an empty list, never as "all": the user turned
   * every model off on purpose, and silently re-enabling them would be worse
   * than an empty picker they can fix.
   *
   * @param {readonly string[]} enabledModelIds - ids to keep.
   * @returns {Promise<Preferences>} the stored document.
   */
  async write(enabledModelIds) {
    const seen = new Set()
    const enabled = []
    for (const id of enabledModelIds) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      enabled.push(id)
    }
    const document = { enabledModelIds: enabled }
    await mkdir(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`)
    await rename(temporary, this.#path)
    return document
  }
}
