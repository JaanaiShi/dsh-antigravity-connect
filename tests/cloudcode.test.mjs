/**
 * Transport tests against a fake Cloud Code Assist backend on loopback.
 *
 * These cover the parts that a unit test of the adapter cannot: SSE framing
 * across real TCP chunk boundaries, host failover, quota parsing, catalog
 * filtering, and the idle-timeout bound.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CloudCodeClient, CloudCodeError } from '../lib/cloudcode.js'
import { modelsFromDirectory } from '../lib/catalog.js'
import { DEFAULT_ENDPOINT, ENDPOINT_FALLBACKS } from '../lib/constants.js'
import { CredentialStore } from '../lib/credentials.js'

/**
 * Start a scripted backend.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void} handler - per-request handler.
 * @returns {Promise<{ url: string, requests: object[], close: () => Promise<void> }>} the base URL, captured requests, and the disposer.
 */
async function backend(handler) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({ url: req.url, method: req.method, headers: req.headers, body })
    handler(req, res, body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => {
      // A test deliberately leaves one SSE response open forever; without
      // force-closing, `close()` would wait on that socket until the runner
      // gives up.
      server.closeAllConnections()
      server.close(() => resolve(undefined))
    }),
  }
}

/**
 * Build a client with a live, non-expiring access token so no refresh is attempted.
 *
 * Failover is off by default: the fake backend is the only host a test controls,
 * and letting a scripted `429` walk on to the real sandbox host would make the
 * assertion depend on Google's servers. Tests that cover failover pass
 * `fallbacks` explicitly.
 *
 * @param {string} endpoint - the fake backend base URL.
 * @param {object} [options] - credential overrides, the idle bound, and failover hosts.
 * @returns {Promise<CloudCodeClient>} the client.
 */
async function client(endpoint, { credential, streamIdleTimeoutMs = 30_000, fallbacks = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsac-cc-'))
  const store = new CredentialStore(join(dir, 'oauth.json'))
  await store.write({
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3_600_000,
    ...credential,
  })
  return new CloudCodeClient({
    store,
    endpoint,
    streamIdleTimeoutMs,
    fallbacks,
    logger: { info() {}, warn() {}, error() {} },
  })
}

/**
 * Write one SSE event. Every frame before the last is split mid-JSON across two
 * TCP writes, which is what a real network does and what the line buffering has
 * to survive.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {object} payload - the event body.
 * @param {boolean} split - whether to split this frame into two writes.
 */
function sse(res, payload, split = false) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  if (!split) {
    res.write(frame)
    return
  }
  const cut = Math.floor(frame.length / 2)
  res.write(frame.slice(0, cut))
  res.write(frame.slice(cut))
}

test('cloudcode: sends the required headers on every call', async () => {
  const server = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ projectId: 'proj-1' }))
  })
  try {
    const cc = await client(server.url)
    assert.equal(await cc.project(), 'proj-1')

    const sent = server.requests[0].headers
    // One user-agent value carrying both the Antigravity product token and the
    // harness attribution token; two spellings would be comma-joined.
    assert.match(sent['user-agent'], /^antigravity\/\d+\.\d+\.\d+ \S+ deepseek-harness\//)
    assert.equal(sent.authorization, 'Bearer access-token')
    assert.equal(sent['x-goog-api-client'], 'google-cloud-sdk vscode_cloudshelleditor/0.1')
    assert.deepEqual(JSON.parse(sent['client-metadata']), {
      ideType: 'ANTIGRAVITY',
      platform: 'MACOS',
      pluginType: 'GEMINI',
    })
    assert.equal(sent['anthropic-beta'], undefined, 'the Claude beta header is Claude-only')

    assert.equal(server.requests[0].url, '/v1internal:loadCodeAssist')
    assert.deepEqual(JSON.parse(server.requests[0].body), {
      metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    })
  } finally {
    await server.close()
  }
})

test('cloudcode: a stored project id skips discovery, and discovery caches it', async () => {
  const server = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ antigravityProjectId: 'proj-discovered' }))
  })
  try {
    const fresh = await client(server.url)
    assert.equal(await fresh.project(), 'proj-discovered')
    // The discovered project is persisted for the next process start.
    assert.equal((await fresh.store.read()).projectId, 'proj-discovered')

    // A stored id means no round-trip at all.
    const warm = await client(server.url, { credential: { projectId: 'proj-cached' } })
    assert.equal(await warm.project(), 'proj-cached')
    assert.equal(server.requests.length, 1)
  } finally {
    await server.close()
  }
})

test('cloudcode: project discovery falls back to the project list', async () => {
  const server = await backend((req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/v1internal:loadCodeAssist') {
      res.end(JSON.stringify({}))
      return
    }
    assert.equal(req.url, '/v1internal:listCloudAICompanionProjects')
    assert.equal(body, '{}')
    res.end(JSON.stringify({ projects: [{ projectId: 'proj-from-list' }] }))
  })
  try {
    const cc = await client(server.url)
    assert.equal(await cc.project(), 'proj-from-list')
    assert.equal(server.requests.length, 2)
  } finally {
    await server.close()
  }
})

test('cloudcode: an undiscoverable project fails with a clear code', async () => {
  const server = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url === '/v1internal:loadCodeAssist' ? {} : { projects: [] }))
  })
  try {
    const cc = await client(server.url)
    await assert.rejects(cc.project(), (error) => {
      assert.ok(error instanceof CloudCodeError)
      assert.equal(error.code, 'PROJECT_DISCOVERY')
      return true
    })
  } finally {
    await server.close()
  }
})

test('cloudcode: the model directory passes through whatever the backend reports', async () => {
  const server = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      models: {
        'gemini-3.8-flash-tiered': { maxTokens: 1048576, maxOutputTokens: 65536 },
        'gemini-3.7-flash-tiered': { maxTokens: 1048576, maxOutputTokens: 65536 },
        'claude-opus-5-5-high': { maxTokens: 1000000, maxOutputTokens: 128000 },
        'chat_hidden': {},
        'tab_completion': {},
        'totally-internal': { isInternal: true },
      },
    }))
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    const directory = await cc.modelDirectory()
    assert.ok(directory !== undefined)
    assert.deepEqual(Object.keys(directory.models).sort(), [
      'chat_hidden',
      'claude-opus-5-5-high',
      'gemini-3.7-flash-tiered',
      'gemini-3.8-flash-tiered',
      'tab_completion',
      'totally-internal',
    ])
    // Filtering is the catalog's job, so the transport keeps everything it was
    // told rather than deciding here what a caller wants.
    const selectable = modelsFromDirectory(directory)
    assert.deepEqual(selectable.map(model => model.id), [
      'gemini-3.8-flash-tiered',
      'gemini-3.7-flash-tiered',
      'claude-opus-5-5-high',
    ])
  } finally {
    await server.close()
  }
})

test('cloudcode: an unreachable directory resolves to undefined instead of throwing', async () => {
  const server = await backend((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'boom' } }))
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    // A failure must not surface as an exception on a listing path: the caller
    // falls back to the built-in list instead.
    assert.equal(await cc.modelDirectory(), undefined)
  } finally {
    await server.close()
  }
})

test('cloudcode: quota parses groups, buckets, and the plan label', async () => {
  const server = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/v1internal:loadCodeAssist') {
      res.end(JSON.stringify({ currentTier: { id: 'pro', name: 'Google AI Pro' } }))
      return
    }
    res.end(JSON.stringify({
      description: 'shared pools',
      groups: [{
        displayName: 'Gemini Models',
        description: 'Gemini pool',
        buckets: [
          { bucketId: '5h', displayName: '5-hour limit', remainingFraction: 0.42, resetTime: '2030-01-01T00:00:00Z' },
          { bucketId: 'weekly', displayName: 'Weekly limit', remainingFraction: 2 },
          { bucketId: 'empty' },
        ],
      }],
    }))
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    const quota = await cc.quota()
    assert.equal(quota.projectId, 'p')
    assert.equal(quota.planLabel, 'Google AI Pro (pro)')
    assert.equal(quota.description, 'shared pools')
    assert.equal(quota.groups.length, 1)
    assert.equal(quota.groups[0].displayName, 'Gemini Models')
    // A fraction above 1 is clamped; a bucket that reports no fraction keeps its
    // identity and reports no balance, rather than claiming zero remaining.
    assert.deepEqual(
      quota.groups[0].buckets.map(bucket => bucket.remainingFraction ?? null),
      [0.42, 1, null],
    )
    assert.equal(quota.groups[0].buckets[2].bucketId, 'empty')
    assert.equal(quota.groups[0].buckets[0].resetTime, '2030-01-01T00:00:00Z')
  } finally {
    await server.close()
  }
})

test('cloudcode: SSE frames split across TCP writes are reassembled', async () => {
  const server = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // Split frames, plus a comment line and [DONE], both of which the reader
    // must ignore without losing the next event.
    sse(res, { candidates: [{ content: { parts: [{ text: 'first' }] } }] }, true)
    sse(res, { candidates: [{ content: { parts: [{ text: 'second' }] } }] }, true)
    res.write(': keep-alive\n\n')
    res.write('data: [DONE]\n\n')
    sse(res, { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } })
    res.end()
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    const payloads = []
    for await (const payload of cc.streamGenerate({ model: 'gemini-3.7-flash', request: {} })) {
      payloads.push(payload)
    }
    assert.equal(payloads.length, 3)
    assert.equal(payloads[0].candidates[0].content.parts[0].text, 'first')
    assert.equal(payloads[1].candidates[0].content.parts[0].text, 'second')
    assert.deepEqual(payloads[2].usageMetadata, { promptTokenCount: 3, candidatesTokenCount: 1 })

    const sent = server.requests[0]
    assert.match(sent.url, /^\/v1internal:streamGenerateContent\?alt=sse$/)
    assert.equal(sent.headers.accept, 'text/event-stream')
    assert.equal(sent.headers['anthropic-beta'], undefined)
  } finally {
    await server.close()
  }
})

test('cloudcode: the Claude beta header is sent for Claude models only', async () => {
  const server = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    sse(res, { candidates: [{ content: { parts: [{ text: 'hi' }] } }] })
    res.end()
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    for await (const _ of cc.streamGenerate({ model: 'claude-opus-4-6-thinking', request: {} })) void _
    assert.equal(server.requests[0].headers['anthropic-beta'], 'interleaved-thinking-2025-05-14')
  } finally {
    await server.close()
  }
})

test('cloudcode: a non-retryable failure is classified and raised immediately', async () => {
  const server = await backend((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid credentials for Bearer ya29.secretvalue' } }))
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    await assert.rejects(cc.quota(), (error) => {
      assert.ok(error instanceof CloudCodeError)
      assert.equal(error.code, 'AUTH')
      assert.equal(error.status, 401)
      // The backend message is kept, but any credential in it is not.
      assert.ok(!error.message.includes('ya29.secretvalue'))
      return true
    })
  } finally {
    await server.close()
  }
})

test('cloudcode: a spent allowance is classified as QUOTA', async () => {
  const server = await backend((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'You have exhausted your quota. Resets in 3h.' } }))
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    await assert.rejects(cc.quota(), (error) => {
      assert.equal(error.code, 'QUOTA')
      return true
    })
  } finally {
    await server.close()
  }
})

test('cloudcode: a throttle is RATE_LIMIT even though its body says "quota"', async () => {
  // Google's generic throttle body. It contains the word "quota" while meaning
  // "you are going too fast", and classifying it as an exhausted allowance
  // sends the user hunting for a quota problem that does not exist — while
  // hiding the fact that the harness would have retried a RATE_LIMIT for them.
  const bodies = [
    'Resource has been exhausted (e.g. check quota).',
    'Resource exhausted, please check quota and retry.',
  ]
  for (const message of bodies) {
    const server = await backend((req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message } }))
    })
    try {
      const cc = await client(server.url, { credential: { projectId: 'p' } })
      await assert.rejects(cc.quota(), (error) => {
        assert.equal(error.code, 'RATE_LIMIT', `should not read "${message}" as exhaustion`)
        return true
      })
    } finally {
      await server.close()
    }
  }
})

test('cloudcode: only real exhaustion phrasing counts as QUOTA', async () => {
  const spent = [
    'You have exhausted your quota.',
    'Quota exceeded for this project.',
    'You are out of quota for this model.',
    'Insufficient quota to satisfy the request.',
    'Your quota has been depleted.',
  ]
  const throttled = [
    'Resource has been exhausted (e.g. check quota).',
    'Rate limit reached. Please retry.',
    'Too many requests.',
    'The model is currently overloaded.',
  ]

  /** Run one 429 body through the real transport and report the code. */
  const codeFor = async (message) => {
    const server = await backend((req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message } }))
    })
    try {
      const cc = await client(server.url, { credential: { projectId: 'p' } })
      return await cc.quota().then(() => 'NO_ERROR', (error) => error.code)
    } finally {
      await server.close()
    }
  }

  for (const message of spent) {
    assert.equal(await codeFor(message), 'QUOTA', `expected QUOTA for "${message}"`)
  }
  for (const message of throttled) {
    assert.equal(await codeFor(message), 'RATE_LIMIT', `expected RATE_LIMIT for "${message}"`)
  }
})

test('cloudcode: a silent backend trips the idle bound', async () => {
  const server = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // Send one event, then hold the connection open forever.
    sse(res, { candidates: [{ content: { parts: [{ text: 'start' }] } }] })
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' }, streamIdleTimeoutMs: 150 })
    const seen = []
    await assert.rejects(async () => {
      for await (const payload of cc.streamGenerate({ model: 'gemini-3.7-flash', request: {} })) {
        seen.push(payload)
      }
    }, (error) => {
      assert.ok(error instanceof CloudCodeError)
      assert.equal(error.code, 'LLM_STREAM_IDLE_TIMEOUT')
      return true
    })
    // The frame received before the silence is still delivered.
    assert.equal(seen.length, 1)
  } finally {
    await server.close()
  }
})

test('cloudcode: a throttled request reports the server\'s own retry delay', async () => {
  const server = await backend((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '12' })
    res.end(JSON.stringify({ error: { message: 'Resource has been exhausted (e.g. check quota).' } }))
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    await assert.rejects(cc.quota(), (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      // Without this the retry policy guesses a backoff and can come back
      // before the window reopens, wasting an attempt.
      assert.equal(error.retryAfterMs, 12_000)
      return true
    })
  } finally {
    await server.close()
  }
})

test('cloudcode: an HTTP-date Retry-After is converted, and a silly value is clamped', async () => {
  const future = new Date(Date.now() + 30_000).toUTCString()
  const server = await backend((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': future })
    res.end(JSON.stringify({ error: { message: 'slow down' } }))
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    await assert.rejects(cc.quota(), (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      // Roughly 30s, allowing for the round-trip.
      assert.ok(error.retryAfterMs > 25_000 && error.retryAfterMs <= 30_000, `got ${error.retryAfterMs}`)
      return true
    })
  } finally {
    await server.close()
  }
})

test('cloudcode: no Retry-After leaves the delay unset so the policy decides', async () => {
  const server = await backend((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'slow down' } }))
  })
  try {
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    await assert.rejects(cc.quota(), (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.retryAfterMs, undefined)
      return true
    })
  } finally {
    await server.close()
  }
})

test('cloudcode: the sandbox host is listed as a failover for a throttled pool', () => {
  // The sandbox host was once removed because it answered 401 to a real account.
  // It is a real serving endpoint against a separate allowance pool, so leaving
  // it out converts a request that host would have served into a bare 429.
  assert.deepEqual(ENDPOINT_FALLBACKS, ['https://daily-cloudcode-pa.sandbox.googleapis.com'])
  assert.equal(DEFAULT_ENDPOINT, 'https://cloudcode-pa.googleapis.com')
})

test('cloudcode: a throttle fails over to the next host, and the last host wins', async () => {
  const throttled = await backend((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Resource has been exhausted (e.g. check quota).' } }))
  })
  const serving = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ groups: [] }))
  })
  try {
    const cc = await client(throttled.url, {
      credential: { projectId: 'p' },
      fallbacks: [serving.url],
    })
    // `quota()` issues two concurrent reads; both must reach the second host
    // rather than failing on the first host's throttle.
    const summary = await cc.quota()
    assert.deepEqual(summary.groups, [])
    assert.ok(serving.requests.length >= 1, 'the second host was never tried')
  } finally {
    await throttled.close()
    await serving.close()
  }
})

test('cloudcode: a spent allowance does not fail over, because no host can lift it', async () => {
  const spent = await backend((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: { message: 'Individual quota reached. Please upgrade your subscription. Resets in 52h.' },
    }))
  })
  const unrelated = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ groups: [] }))
  })
  try {
    const cc = await client(spent.url, {
      credential: { projectId: 'p' },
      fallbacks: [unrelated.url],
    })
    await assert.rejects(cc.quota(), (error) => {
      assert.equal(error.code, 'QUOTA')
      return true
    })
    // Failing over here would only swap an actionable message that names the
    // reset time for whatever the second host happens to say.
    assert.equal(unrelated.requests.length, 0, 'a spent allowance must not fail over')
  } finally {
    await spent.close()
    await unrelated.close()
  }
})

test('cloudcode: a server fault still walks the host list', async () => {
  const broken = await backend((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'unavailable' } }))
  })
  const serving = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ groups: [] }))
  })
  try {
    const cc = await client(broken.url, {
      credential: { projectId: 'p' },
      fallbacks: [serving.url],
    })
    assert.deepEqual((await cc.quota()).groups, [])
    assert.equal(broken.requests.length, 2, 'both concurrent reads start on the configured host')
  } finally {
    await broken.close()
    await serving.close()
  }
})

test('cloudcode: a failure names the host that actually produced it', async () => {
  const server = await backend((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'unavailable' } }))
  })
  try {
    // No fallback, so the configured host is the one that fails and is named.
    const cc = await client(server.url, { credential: { projectId: 'p' } })
    await assert.rejects(cc.quota(), (error) => {
      assert.equal(error.status, 503)
      // Named, so a diagnostic says which host actually failed.
      assert.equal(error.host, server.url)
      return true
    })
    // Every request went to this host: the URL each one arrived at is the
    // configured endpoint, never a second one.
    assert.ok(server.requests.length <= 2, `unexpected extra requests: ${server.requests.length}`)
    for (const request of server.requests) {
      assert.ok(request.url.startsWith('/v1internal:'), `unexpected path ${request.url}`)
    }
  } finally {
    await server.close()
  }
})
