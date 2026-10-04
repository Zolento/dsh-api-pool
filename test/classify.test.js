import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyError, classifyTransportError, ErrorKind, parseTimestamp, retryAfterMs } from '../src/pool/kinds.js'

const REAL_429 = JSON.stringify({
  error: {
    message: 'Rate limit exceeded for api_key: f54c6463. Limit type: requests. Current limit: 20, Remaining: 0. Limit resets at: 2026-10-03 18:10:19 UTC',
    type: 'throttling_error',
    param: null,
    code: '429',
  },
})

test('classifies the real LiteLLM 429 body', () => {
  const info = classifyError({ status: 429, headers: {}, body: REAL_429 })
  assert.equal(info.kind, ErrorKind.RATE_LIMIT)
  assert.equal(info.httpStatus, 429)
  assert.equal(info.errorType, 'throttling_error')
  assert.equal(info.limitType, 'requests')
  assert.equal(info.currentLimit, 20)
  assert.equal(info.remaining, 0)
  assert.equal(info.resetAt, Date.parse('2026-10-03T18:10:19Z'))
})

test('an exhausted budget wins over rate-limit wording', () => {
  const body = JSON.stringify({ error: { message: 'ExceededBudget: Key over 3h budget. Spend=$30.12, Limit=$30.00', type: 'budget_exceeded', code: '429' } })
  const info = classifyError({ status: 429, headers: {}, body })
  assert.equal(info.kind, ErrorKind.QUOTA_EXHAUSTED)
  assert.equal(info.isBudget, true)
})

test('a request-window rate limit is not a budget problem', () => {
  const info = classifyError({ status: 429, headers: {}, body: REAL_429 })
  assert.equal(info.isBudget, false)
})

test('auth is recognized from status and from message text', () => {
  assert.equal(classifyError({ status: 401, body: 'x' }).kind, ErrorKind.AUTH)
  assert.equal(classifyError({ status: 403, body: 'x' }).kind, ErrorKind.AUTH)
  assert.equal(classifyError({ body: 'Invalid API key provided' }).kind, ErrorKind.AUTH)
})

test('server, timeout and connection failures', () => {
  assert.equal(classifyError({ status: 503, body: 'unavailable' }).kind, ErrorKind.SERVER)
  assert.equal(classifyError({ status: 504, body: 'gateway timeout' }).kind, ErrorKind.TIMEOUT)
  assert.equal(classifyTransportError(new Error('fetch failed: ECONNREFUSED')).kind, ErrorKind.CONNECTION)
  assert.equal(classifyTransportError(new Error('socket hang up')).kind, ErrorKind.CONNECTION)
})

test('other 4xx is a bad request', () => {
  const info = classifyError({ status: 400, body: JSON.stringify({ error: { message: 'bad payload' } }) })
  assert.equal(info.kind, ErrorKind.BAD_REQUEST)
})

test('retry-after accepts seconds and HTTP dates', () => {
  assert.equal(retryAfterMs({ 'retry-after': '2' }), 2000)
  const when = new Date(Date.now() + 5000).toUTCString()
  const parsed = retryAfterMs({ 'retry-after': when })
  assert.ok(parsed > 3000 && parsed <= 6000, String(parsed))
})

test('parseTimestamp normalizes UTC suffix and space separator', () => {
  assert.equal(parseTimestamp('2026-10-03 18:10:19 UTC'), Date.parse('2026-10-03T18:10:19Z'))
  assert.equal(parseTimestamp('2026-10-03T18:10:19Z'), Date.parse('2026-10-03T18:10:19Z'))
})
