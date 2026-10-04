import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiPool, AllEndpointsUnavailable } from '../src/pool/pool.js'
import { ErrorKind } from '../src/pool/kinds.js'
import { onFailure, endpointState } from '../src/pool/state.js'

function poolConfig(endpoints, extra = {}) {
  return {
    enabled: true,
    strategy: 'least_loaded',
    safetyMargin: undefined,
    rpmWindowMs: 60_000,
    maxCooldownMs: 3_600_000,
    quotaRecheckMs: 600_000,
    quotaRefreshMs: 300_000,
    quotaEnabled: false,
    maxAttemptsPerRequest: 5,
    totalRequestTimeoutMs: 0,
    maxBlockWaitMs: 21_600_000,
    requestTimeoutMs: 1000,
    failoverOnBadRequest: false,
    cooldowns: { rate_limit: 1000, server: 1000, timeout: 1000, connection: 1000, unknown: 1000, bad_request: 1000 },
    endpoints: endpoints.map((name, index) => ({
      name, baseURL: `https://${name}.example/v1`, priority: 100, enabled: true, index,
    })),
    ...extra,
  }
}

function failure(kind, message = kind) {
  const error = new Error(message)
  error.poolInfo = { kind, message, resetAt: undefined, retryAfterMs: undefined, httpStatus: undefined, limitType: undefined, errorType: undefined, remaining: undefined, isBudget: false }
  return error
}

test('fails over to the next endpoint on a rate limit', async () => {
  const calls = []
  const pool = new ApiPool({
    config: poolConfig(['a', 'b']),
    resolveKey: async () => 'key',
    now: () => 1000,
    sleep: async () => {},
  })
  const result = await pool.execute(async (spec) => {
    calls.push(spec.name)
    if (spec.name === 'a') throw failure(ErrorKind.RATE_LIMIT)
    return { ok: true, endpoint: spec.name }
  })
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(result.endpoint, 'b')
  assert.equal(pool.status().find(row => row.name === 'a').state, 'cooldown(1s)')
  assert.equal(pool.status().find(row => row.name === 'a').lastErrorKind, ErrorKind.RATE_LIMIT)
})

test('a bad request is rethrown and never tried on another endpoint', async () => {
  const calls = []
  const pool = new ApiPool({ config: poolConfig(['a', 'b']), resolveKey: async () => 'key', now: () => 1000, sleep: async () => {} })
  await assert.rejects(
    () => pool.execute(async (spec) => {
      calls.push(spec.name)
      throw failure(ErrorKind.BAD_REQUEST)
    }),
    /bad_request/,
  )
  assert.deepEqual(calls, ['a'])
})

test('a single successful attempt is returned unchanged', async () => {
  const pool = new ApiPool({ config: poolConfig(['a']), resolveKey: async () => 'key', now: () => 1000, sleep: async () => {} })
  const result = await pool.execute(async () => ({ ok: true }))
  assert.equal(result.ok, true)
  assert.equal(pool.status()[0].successes, 1)
  assert.equal(pool.status()[0].totalRequests, 1)
})

test('every endpoint quota-exhausted raises rather than looping forever', async () => {
  const pool = new ApiPool({
    config: poolConfig(['a', 'b'], { quotaRecheckMs: 100_000, maxBlockWaitMs: 10 }),
    resolveKey: async () => 'key',
    now: () => 1000,
    sleep: async () => {},
  })
  await assert.rejects(
    () => pool.execute(async () => { throw failure(ErrorKind.QUOTA_EXHAUSTED) }),
    AllEndpointsUnavailable,
  )
})

test('an empty pool fails with an actionable message', async () => {
  const pool = new ApiPool({ config: poolConfig([]), resolveKey: async () => 'key' })
  await assert.rejects(() => pool.execute(async () => ({ ok: true })), /no endpoints configured/)
})

test('a credential failure also fails over', async () => {
  const calls = []
  const pool = new ApiPool({
    config: poolConfig(['a', 'b']),
    resolveKey: async (spec) => {
      if (spec.name === 'a') throw new Error('missing USTC_API_KEY')
      return 'key'
    },
    now: () => 1000,
    sleep: async () => {},
  })
  const result = await pool.execute(async (spec) => {
    calls.push(spec.name)
    return { endpoint: spec.name }
  })
  assert.deepEqual(calls, ['b'])
  assert.equal(result.endpoint, 'b')
})

test('availability reports the endpoint a blocked request is waiting on', async () => {
  const pool = new ApiPool({
    config: poolConfig(['a', 'b']),
    resolveKey: async () => 'key',
    now: () => 1000,
    sleep: async () => {},
  })
  await pool.execute(async (spec) => {
    if (spec.name === 'a') throw failure(ErrorKind.RATE_LIMIT)
    return { ok: true }
  })

  const capacity = pool.availability()
  assert.equal(capacity.blocked, false)
  assert.equal(capacity.ready, 1)
  assert.equal(capacity.enabled, 2)
  assert.equal(capacity.next.name, 'a')
  assert.equal(capacity.next.reason, 'cooldown')
  assert.equal(capacity.next.inMs, 1000)
  assert.equal(capacity.next.lastErrorKind, ErrorKind.RATE_LIMIT)

  const row = pool.status().find(candidate => candidate.name === 'a')
  assert.equal(row.available, false)
  assert.equal(row.reason, 'cooldown')
  assert.equal(row.availableInMs, 1000)
  assert.equal(row.state, 'cooldown(1s)')
})

test('availability marks the pool blocked when nothing is ready', async () => {
  const pool = new ApiPool({
    config: poolConfig(['a'], { maxAttemptsPerRequest: 1 }),
    resolveKey: async () => 'key',
    now: () => 1000,
    sleep: async () => {},
  })
  await assert.rejects(() => pool.execute(async () => { throw failure(ErrorKind.RATE_LIMIT) }))

  const capacity = pool.availability()
  assert.equal(capacity.blocked, true)
  assert.equal(capacity.ready, 0)
  assert.equal(capacity.next.name, 'a')
  assert.deepEqual(capacity.permanentlyDisabled, [])
})

test('availability lists permanently disabled endpoints', () => {
  const pool = new ApiPool({ config: poolConfig(['a', 'b']), resolveKey: async () => 'key', now: () => 1000 })
  onFailure(pool.state, pool.specs[0], endpointState(pool.state, 'a'), { kind: ErrorKind.AUTH, message: 'invalid key' }, 1000, pool.config)
  const capacity = pool.availability()
  assert.deepEqual(capacity.permanentlyDisabled, ['a'])
  assert.equal(capacity.ready, 1)
  assert.equal(capacity.blocked, false)
  // Nothing is cooling down, so there is no "next recovery" to wait for.
  assert.equal(capacity.next, undefined)

  const row = pool.status().find(candidate => candidate.name === 'a')
  assert.equal(row.available, false)
  assert.equal(row.reason, 'auth')
  assert.equal(row.availableInMs, Infinity)
})
