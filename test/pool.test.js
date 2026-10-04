import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiPool, AllEndpointsUnavailable, StateStore } from '../src/pool/pool.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErrorKind } from '../src/pool/kinds.js'
import { onFailure, endpointState, observeWindowSpend } from '../src/pool/state.js'
import { onSuccess } from '../src/pool/state.js'

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
      if (spec.name === 'a') throw new Error('missing PRIMARY_API_KEY')
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

test('status and totals report the window-based cumulative figures', () => {
  const pool = new ApiPool({ config: poolConfig(['a', 'b']), resolveKey: async () => 'key', now: () => 1000 })
  assert.deepEqual(pool.totals(), { spendUsd: 0, tokensIn: 0, tokensOut: 0, since: undefined }, 'unknown figures report 0, never undefined')
  assert.deepEqual(pool.status().map(row => [row.totalSpend, row.totalTokensIn, row.totalTokensOut]), [[0, 0, 0], [0, 0, 0]])

  const entryA = endpointState(pool.state, 'a')
  const windowOne = 1_700_000_000_000
  observeWindowSpend(pool.state, entryA, 40, windowOne, 1000)
  observeWindowSpend(pool.state, entryA, 62, windowOne, 2000)
  observeWindowSpend(pool.state, entryA, 10, windowOne + 86_400_000, 3000)   // window reset → bank 62
  pool.recordUsage('b', { inputTokens: 1_000, outputTokens: 500 })

  const rows = pool.status()
  assert.equal(rows[0].totalSpend, 72)
  assert.equal(rows[1].totalSpend, 0)
  assert.equal(rows[1].totalTokensIn, 1_000)
  assert.deepEqual(
    { spendUsd: pool.totals().spendUsd, tokensIn: pool.totals().tokensIn, tokensOut: pool.totals().tokensOut },
    { spendUsd: 72, tokensIn: 1_000, tokensOut: 500 },
  )
})

test('loading state drops stale quota hints but keeps counters and cooldowns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-pool-state-'))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    totalSpend: 1.5,
    spendSince: 123,
    endpoints: {
      a: {
        spend: 1282.93, maxBudget: 100, quotaSource: 'user', budgetResetAt: 1730000000000, quotaCheckedAt: 1730000000000,
        cooldownUntil: 9999999999999, totalSpend: 0.5, successes: 3,
      },
    },
  }))

  const state = new StateStore(file).load()
  assert.equal(state.totalSpend, 1.5, 'cumulative spend is ours and must survive')
  assert.equal(state.spendSince, 123)
  assert.equal(state.endpoints.a.spend, undefined, 'a fetched quota hint must not be trusted across runs')
  assert.equal(state.endpoints.a.maxBudget, undefined)
  assert.equal(state.endpoints.a.quotaSource, undefined)
  assert.equal(state.endpoints.a.quotaCheckedAt, undefined)
  assert.equal(state.endpoints.a.cooldownUntil, 9999999999999, 'a cooldown carries its own expiry, so keep it')
  assert.equal(state.endpoints.a.totalSpend, 0.5)
  assert.equal(state.endpoints.a.successes, 3)
})

test('a stale persisted quota pair can no longer disable an endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-pool-state-'))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    endpoints: { a: { spend: 1282.93, maxBudget: 100, quotaSource: 'user', cooldownUntil: 0, disabledUntil: 0 } },
  }))
  const state = new StateStore(file).load()
  const pool = new ApiPool({ config: poolConfig(['a']), state, resolveKey: async () => 'key', now: () => 1000 })
  assert.equal(pool.availability().ready, 1)
  assert.equal(pool.availability().blocked, false)
  assert.equal(pool.status()[0].reason, 'ready')
})

test('a forced refresh still runs while another round is in flight', async () => {
  let probes = 0
  const fetchImpl = async (url) => {
    probes += 1
    await new Promise(resolve => setTimeout(resolve, 20))
    return { ok: true, json: async () => (url.endsWith('/key/info') ? { info: { spend: 1, max_budget: 100, rpm_limit: 20 } } : {}) }
  }
  const config = {
    ...poolConfig(['a']),
    quotaEnabled: true, quotaRefreshMs: 300_000, quotaProbeTimeoutMs: 1000, fetchImpl,
  }
  const pool = new ApiPool({ config, resolveKey: async () => 'k', now: () => 1000 })

  const first = pool.refreshQuotas(true)
  const second = pool.refreshQuotas(true)   // arrives mid-flight
  await Promise.all([first, second])

  assert.equal(probes, 4, 'each forced round probes both records, so the second is not swallowed')
})

test('hasQuotaHints reflects whether any budget figure was read', async () => {
  let serve = true
  const fetchImpl = async (url) => (serve
    ? { ok: true, json: async () => (url.endsWith('/key/info') ? { info: { spend: 5, max_budget: 100, rpm_limit: 20 } } : {}) }
    : { ok: false })
  const config = { ...poolConfig(['a']), quotaEnabled: true, quotaRefreshMs: 300_000, quotaProbeTimeoutMs: 1000, fetchImpl }
  const pool = new ApiPool({ config, resolveKey: async () => 'k', now: () => 1000 })

  assert.equal(pool.hasQuotaHints(), false)
  await pool.refreshQuotas(true)
  assert.equal(pool.hasQuotaHints(), true)
})

test('a failed probe round leaves hasQuotaHints false so startup can retry', async () => {
  const config = { ...poolConfig(['a']), quotaEnabled: true, quotaRefreshMs: 300_000, quotaProbeTimeoutMs: 1000, fetchImpl: async () => ({ ok: false }) }
  const pool = new ApiPool({ config, resolveKey: async () => 'k', now: () => 1000 })
  await pool.refreshQuotas(true)
  assert.equal(pool.hasQuotaHints(), false)
  assert.equal(pool.availability().ready, 1, 'an absent hint must not disable the endpoint')
})
