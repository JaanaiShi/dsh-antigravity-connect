#!/usr/bin/env node
/**
 * Command-line Google sign-in for dsh-antigravity-connect.
 *
 * The DSH Web settings page can start the same flow, but a headless host, a
 * remote session, or a browser that will not open on the machine running the
 * harness all need a way to complete the OAuth round-trip by hand. This script
 * is that way: it prints the authorization URL, waits on the loopback callback,
 * and writes the credential the plugin reads.
 *
 * Usage:
 *   node bin/antigravity-connect-login.mjs [--port 51121] [--no-open] [--logout]
 *
 * @module dsh-antigravity-connect/bin/login
 */

import { parseArgs } from 'node:util'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CREDENTIAL_FILE, DEFAULT_CALLBACK_PORT } from '../lib/constants.js'
import { CredentialStore } from '../lib/credentials.js'
import { openBrowser, startCallbackServer } from '../lib/oauth.js'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: String(DEFAULT_CALLBACK_PORT) },
    'no-open': { type: 'boolean', default: false },
    logout: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stdout.write(
    'Usage: antigravity-connect-login [--port <n>] [--no-open] [--logout]\n\n'
    + '  --port <n>   loopback port for the OAuth redirect (default 51121)\n'
    + '  --no-open    print the URL instead of opening a browser\n'
    + '  --logout     remove the stored credential and exit\n',
  )
  process.exit(0)
}

const port = Number.parseInt(values.port, 10)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  process.stderr.write(`antigravity-connect-login: --port must be an integer from 1024 through 65535, got "${values.port}"\n`)
  process.exit(2)
}

const store = new CredentialStore(dshHomePath('storages', CREDENTIAL_FILE))

if (values.logout) {
  await store.delete()
  process.stdout.write(`Signed out. Removed ${store.path}\n`)
  process.exit(0)
}

const existing = await store.read()
if (existing !== undefined) {
  process.stdout.write(
    `Already signed in${existing.email === undefined ? '' : ` as ${existing.email}`}.`
    + ' Run again with --logout first to switch accounts.\n',
  )
  process.exit(0)
}

process.stdout.write(`Credential file: ${store.path}\n`)

let server
try {
  server = await startCallbackServer({ port })
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`)
  process.exit(1)
}

process.stdout.write('\nOpen this URL in a browser on this machine to authorize:\n\n')
process.stdout.write(`  ${server.authUrl}\n\n`)

if (!values['no-open'] && openBrowser(server.authUrl)) {
  process.stdout.write('A browser window was opened for you.\n')
} else {
  process.stdout.write('Could not launch a browser; open the URL above manually.\n')
}

/** Abort the wait when the operator interrupts, so the port is always released. */
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    controller.abort()
    process.stderr.write('\nCancelled.\n')
  })
}

try {
  const code = await server.waitForCode(controller.signal)
  const credential = await server.complete(code, store)
  process.stdout.write(
    `\nSigned in${credential.email === undefined ? '' : ` as ${credential.email}`}.`
    + ' Restart DSH (or reopen the settings page) to use the Antigravity provider.\n',
  )
  process.exitCode = 0
} catch (error) {
  process.stderr.write(`\nSign-in failed: ${error?.message ?? error}\n`)
  process.exitCode = 1
} finally {
  await server.close().catch(() => {})
}
