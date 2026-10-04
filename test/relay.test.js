import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ApiPool } from '../src/pool/pool.js'
import { Relay } from '../src/relay.js'

/** Start a fake OpenAI-compatible upstream. */
async function upstream(handler) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => handler(req, res, body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise(resolve => server.close(resolve)) }
}

async function makeRelay(endpoints, token = 'secret-token') {
  const config = {
    enabled: true, strategy: 'least_loaded', rpmWindowMs: 60_000, maxCooldownMs: 3_600_000,
    quotaRecheckMs: 600_000, quotaEnabled: false, maxAttemptsPerRequest: 3, totalRequestTimeoutMs: 0,
    maxBlockWaitMs: 1_000, requestTimeoutMs: 5000, failoverOnBadRequest: false,
    cooldowns: { rate_limit: 60_000, server: 60_000, timeout: 60_000, connection: 60_000, unknown: 60_000, bad_request: 60_000 },
    endpoints: endpoints.map((endpoint, index) => ({ ...endpoint, priority: 100, enabled: true, index })),
  }
  const pool = new ApiPool({ config, resolveKey: async spec => spec.apiKey })
  const relay = new Relay({ pool, token, models: ['deepseek-flash'] })
  await relay.listen(0)
  return { relay, pool, close: () => relay.close() }
}

async function post(relay, body, token = 'secret-token') {
  const response = await fetch(`${relay.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text(), headers: response.headers }
}

test('passes a streaming success through from the selected endpoint', async () => {
  const seenAuth = []
  const good = await upstream((req, res, body) => {
    seenAuth.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n')
    res.end('data: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n')
  })
  const { relay, close } = await makeRelay([{ name: 'a', baseURL: good.url, apiKey: 'real-key' }])
  try {
    const result = await post(relay, { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })
    assert.equal(result.status, 200)
    assert.match(result.text, /"he"/)
    assert.match(result.text, /\[DONE\]/)
    assert.deepEqual(seenAuth, ['Bearer real-key'])
  } finally {
    await close()
    await good.close()
  }
})

test('fails over when the first endpoint returns a 429', async () => {
  const calls = []
  const limited = await upstream((req, res) => {
    calls.push('limited')
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Rate limit exceeded. Limit type: requests. Current limit: 20, Remaining: 0.', type: 'throttling_error', code: '429' } }))
  })
  const good = await upstream((req, res) => {
    calls.push('good')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"pool ok"}}]}\n\ndata: [DONE]\n\n')
  })
  const { relay, pool, close } = await makeRelay([
    { name: 'a', baseURL: limited.url, apiKey: 'k0' },
    { name: 'b', baseURL: good.url, apiKey: 'k1' },
  ])
  try {
    const result = await post(relay, { model: 'deepseek-flash', messages: [], stream: true })
    assert.equal(result.status, 200)
    assert.match(result.text, /pool ok/)
    assert.deepEqual(calls.sort(), ['good', 'limited'])
    assert.equal(pool.status().find(row => row.name === 'a').lastErrorKind, 'rate_limit')
  } finally {
    await close()
    await limited.close()
    await good.close()
  }
})

test('rejects a request without the relay token', async () => {
  const good = await upstream((req, res) => { res.writeHead(200); res.end('{}') })
  const { relay, close } = await makeRelay([{ name: 'a', baseURL: good.url, apiKey: 'k' }])
  try {
    const result = await post(relay, { model: 'deepseek-flash' }, 'wrong-token')
    assert.equal(result.status, 401)
  } finally {
    await close()
    await good.close()
  }
})

test('returns 503 when every endpoint is quota-exhausted', async () => {
  const exhausted = await upstream((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'ExceededBudget: Key over budget', type: 'budget_exceeded', code: '429' } }))
  })
  const { relay, close } = await makeRelay([{ name: 'a', baseURL: exhausted.url, apiKey: 'k' }])
  try {
    const result = await post(relay, { model: 'deepseek-flash' })
    assert.equal(result.status, 503)
    assert.match(result.text, /all_endpoints_unavailable|permanently disabled|block budget/i)
  } finally {
    await close()
    await exhausted.close()
  }
})

test('advertises configured models on GET /v1/models', async () => {
  const { relay, close } = await makeRelay([])
  try {
    const response = await fetch(`${relay.url}/v1/models`, { headers: { authorization: 'Bearer secret-token' } })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body.data.map(model => model.id), ['deepseek-flash'])
  } finally {
    await close()
  }
})
