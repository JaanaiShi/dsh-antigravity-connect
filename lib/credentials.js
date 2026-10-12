/**
 * File-backed OAuth credential store for the Antigravity provider.
 *
 * One JSON document under the harness home, written atomically and readable
 * only by its owner. The store also serializes read-modify-write cycles: an
 * access token expires while several requests are in flight, and without the
 * serialization each of them would start its own refresh, so N concurrent
 * callers would spend N refresh tokens and the last write would win.
 *
 * @module dsh-antigravity-connect/credentials
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Owner-only file mode for a document holding refresh and access tokens. */
const SECRET_MODE = 0o600

/**
 * One stored credential set. `projectId` and `email` are cached *derived*
 * facts, not secrets: `projectId` saves a discovery round-trip on the first
 * request after a restart, and `email` is display-only.
 *
 * @typedef {object} StoredCredential
 * @property {string} refresh   long-lived refresh token; the only field that must survive
 * @property {string} [access]  current access token, when one has been minted
 * @property {number} [expires] epoch milliseconds at which `access` stops being used
 * @property {string} [projectId] last discovered Cloud Code Assist project
 * @property {string} [email]   account label for the settings page
 */

/** Serialized, atomically written JSON credential store. */
export class CredentialStore {
  /** @type {string} */
  #path
  /** @type {Promise<unknown>} tail of the read-modify-write chain */
  #chain = Promise.resolve()

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
   * Read the stored credential.
   * @returns {Promise<StoredCredential | undefined>} the credential, or `undefined` when absent or unreadable.
   */
  async read() {
    let text
    try {
      text = await readFile(this.#path, 'utf8')
    } catch (error) {
      // Absent is the ordinary "not signed in" state; anything else is a real
      // filesystem problem the caller should see.
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      // A truncated or hand-edited document is indistinguishable from "no
      // credential" for our purposes, and failing hard here would strand the
      // user with an unusable settings page.
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (typeof parsed.refresh !== 'string' || parsed.refresh.length === 0) return undefined
    return parsed
  }

  /**
   * Replace the stored credential.
   * @param {StoredCredential} value - the complete next document.
   * @returns {Promise<void>} resolves once the rename has landed.
   */
  async write(value) {
    await mkdir(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.${process.pid}.tmp`
    // `mode` on writeFile only applies at creation, so an existing looser file
    // would keep its mode through the rename; chmod the temporary explicitly.
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: SECRET_MODE })
    try {
      await rename(temporary, this.#path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  /**
   * Run one read-modify-write cycle with exclusive access.
   *
   * The callback may return a replacement document to store, or `undefined` to
   * signal that nothing changed. Chaining every call through one promise is
   * what makes "refresh only when expired" correct under concurrency: the
   * second caller re-reads the document the first one just wrote, sees a live
   * token, and returns it instead of refreshing again.
   *
   * @template T
   * @param {(current: StoredCredential | undefined) => Promise<{ next?: StoredCredential, result: T }>} body - the critical section.
   * @returns {Promise<T>} whatever the callback put in `result`.
   */
  modify(body) {
    const run = this.#chain.then(async () => {
      const current = await this.read()
      const { next, result } = await body(current)
      if (next !== undefined) await this.write(next)
      return result
    })
    // Keep the chain alive after a rejection so one failed cycle cannot wedge
    // every later caller, but do not swallow the rejection for this caller.
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Remove the stored credential. Idempotent.
   * @returns {Promise<void>} resolves once the file is gone.
   */
  async delete() {
    try {
      await unlink(this.#path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

/**
 * Strip anything that looks like a token out of text bound for a log or an
 * HTTP error body. The backend occasionally echoes request fragments in
 * diagnostics, and a credential must never ride that path to disk.
 * @param {unknown} value - any value; non-strings are stringified first.
 * @returns {string} the same text with token-looking substrings replaced.
 */
export function redactSecrets(value) {
  let text
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  return String(text)
    .replace(/("?(?:access_token|refresh_token|id_token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi, '$1<redacted>$2')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1<redacted>')
    .replace(/(ya29\.[A-Za-z0-9._-]+)/g, '<redacted>')
    .replace(/(1\/\/[A-Za-z0-9._-]{20,})/g, '<redacted>')
}
