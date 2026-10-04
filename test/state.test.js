import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, endpointState, onFailure, onSuccess, recordRequest, isUnavailable, timeUntilAvailable, availabilityOf, quotaFromHeaders, quotaExhausted, totalDaySpendOf, daySpendOf, observeDaySpend, recordUsage } from '../src/pool/state.js'
import { selectEndpoint } from '../src/pool/select.js'
import { ErrorKind } from '../src/pool/kinds.js'

const BASE = {
  cooldowns: { rate_limit: 60_000, connection: 30_000, timeout: 60_000, server: 60_000, bad_request: 30_000, unknown: 30_000 },
  maxCooldownMs: 3_600_000,
  quotaRecheckMs: 600_000,
  rpmWindowMs: 60_000,
  failoverOnBadRequest: false,
}

function spec(name, extra = {}) {
  return { name, baseURL: `https://${name}.example/v1`, priority: 100, enabled: true, ...extra }
}

test('least_loaded spreads requests across equal endpoints', () => {
  const specs = [spec('a'), spec('b'), spec('c')]
  const state = emptyState()
  const picked = []
  for (let index = 0; index < 6; index++) {
    const chosen = selectEndpoint(specs, state, 1000 + index, { strategy: 'least_loaded', rpmWindowMs: 60_000 })
    picked.push(chosen.name)
    recordRequest(state, endpointState(state, chosen.name), 1000 + index)
  }
  for (const name of ['a', 'b', 'c']) assert.ok(picked.includes(name), `${name} was never selected`)
})

test('a rate-limited endpoint is cooled down and skipped', () => {
  const specs = [spec('a'), spec('b')]
  const state = emptyState()
  const entry = endpointState(state, 'a')
  const info = { kind: ErrorKind.RATE_LIMIT, message: 'rate limited', resetAt: undefined, retryAfterMs: undefined }
  const decision = onFailure(state, specs[0], entry, info, 1000, BASE)
  assert.equal(decision.action, 'failover')
  assert.ok(decision.cooldownMs >= 60_000)
  assert.equal(isUnavailable(state, specs[0], 2000), true)
  assert.equal(selectEndpoint(specs, state, 2000, { strategy: 'least_loaded' }).name, 'b')
  // After the cooldown the endpoint is eligible again.
  assert.equal(isUnavailable(state, specs[0], 1000 + decision.cooldownMs + 1), false)
})

test('cooldown honours a provider reset time beyond the base', () => {
  const specs = [spec('a')]
  const state = emptyState()
  const info = { kind: ErrorKind.RATE_LIMIT, message: 'rl', resetAt: 1000 + 90_000, retryAfterMs: undefined }
  const decision = onFailure(state, specs[0], endpointState(state, 'a'), info, 1000, BASE)
  assert.ok(decision.cooldownMs > 80_000 && decision.cooldownMs <= 90_000, String(decision.cooldownMs))
})

test('quota exhaustion disables the endpoint and it recovers after the recheck window', () => {
  const specs = [spec('a')]
  const state = emptyState()
  const entry = endpointState(state, 'a')
  const info = { kind: ErrorKind.QUOTA_EXHAUSTED, message: 'budget exceeded', resetAt: undefined, retryAfterMs: undefined }
  onFailure(state, specs[0], entry, info, 1000, BASE)
  assert.equal(entry.disabledReason, 'quota_exhausted')
  assert.equal(isUnavailable(state, specs[0], 2000), true)
  assert.equal(isUnavailable(state, specs[0], 1000 + BASE.quotaRecheckMs + 1), false)
  assert.equal(entry.disabledUntil, 0)
})

test('auth disables an endpoint permanently', () => {
  const specs = [spec('a')]
  const state = emptyState()
  const entry = endpointState(state, 'a')
  onFailure(state, specs[0], entry, { kind: ErrorKind.AUTH, message: 'invalid key' }, 1000, BASE)
  assert.equal(entry.disabledUntil, -1)
  assert.equal(entry.disabledReason, 'auth')
  assert.equal(timeUntilAvailable(state, specs, 5000), undefined)
})

test('bad request is rethrown without cooling the endpoint', () => {
  const specs = [spec('a'), spec('b')]
  const state = emptyState()
  const decision = onFailure(state, specs[0], endpointState(state, 'a'), { kind: ErrorKind.BAD_REQUEST, message: 'bad body' }, 1000, BASE)
  assert.equal(decision.action, 'rethrow')
  assert.equal(isUnavailable(state, specs[0], 1000), false)
})

test('priority strategy prefers the lower priority number', () => {
  const specs = [spec('a', { priority: 5 }), spec('b', { priority: 1 })]
  const state = emptyState()
  assert.equal(selectEndpoint(specs, state, 1000, { strategy: 'priority' }).name, 'b')
})

test('round_robin cycles deterministically', () => {
  const specs = [spec('a'), spec('b')]
  const state = emptyState()
  const first = selectEndpoint(specs, state, 1000, { strategy: 'round_robin' }).name
  recordRequest(state, endpointState(state, first), 1000)
  const second = selectEndpoint(specs, state, 1001, { strategy: 'round_robin' }).name
  assert.notEqual(first, second)
})

test('a successful call clears cooldowns', () => {
  const specs = [spec('a')]
  const state = emptyState()
  const entry = endpointState(state, 'a')
  onFailure(state, specs[0], entry, { kind: ErrorKind.SERVER, message: 'boom' }, 1000, BASE)
  assert.ok(entry.cooldownUntil > 1000)
  onSuccess(state, specs[0], 2000, 12, undefined)
  assert.equal(entry.cooldownUntil, 0)
  assert.equal(entry.consecutiveFailures, 0)
  assert.equal(entry.successes, 1)
})

test('availabilityOf explains why and when an endpoint returns', () => {
  const ready = spec('ready')
  assert.deepEqual(availabilityOf(emptyState(), ready, 1000, 60_000), { available: true, reason: 'ready', availableAt: 1000 })

  const state = emptyState()
  const cooling = spec('cooling')
  onFailure(state, cooling, endpointState(state, 'cooling'), { kind: ErrorKind.RATE_LIMIT, message: 'rl' }, 1000, BASE)
  const during = availabilityOf(state, cooling, 1000, 60_000)
  assert.equal(during.available, false)
  assert.equal(during.reason, 'cooldown')
  assert.ok(during.availableAt > 1000)
  assert.equal(availabilityOf(state, cooling, during.availableAt + 1, 60_000).available, true)

  const dead = spec('dead')
  onFailure(state, dead, endpointState(state, 'dead'), { kind: ErrorKind.AUTH, message: 'bad key' }, 1000, BASE)
  assert.deepEqual(availabilityOf(state, dead, 1000, 60_000), { available: false, reason: 'auth', availableAt: Infinity })

  assert.equal(availabilityOf(emptyState(), spec('off', { enabled: false }), 1000, 60_000).reason, 'disabled')
})

test('a quota-exhausted endpoint with no known reset is held for one recheck window', () => {
  const target = spec('quota')
  const state = emptyState()
  const entry = endpointState(state, 'quota')
  entry.spend = 100
  entry.maxBudget = 100
  entry.quotaCheckedAt = 1000

  const during = availabilityOf(state, target, 1000, 60_000)
  assert.equal(during.available, false)
  assert.equal(during.reason, 'quota')
  assert.equal(during.availableAt, 61_000)
  assert.equal(availabilityOf(state, target, 61_001, 60_000).available, true)
})

test('key-scope quota headers never mix with a user-scope budget', () => {
  const entry = endpointState(emptyState(), 'secondary')
  // The binding budget came from the user record...
  entry.quotaSource = 'user'
  entry.maxBudget = 100
  entry.spend = 89.26
  // ...while the response header reports the key's lifetime spend.
  quotaFromHeaders(entry, { 'x-litellm-key-spend': '1281.79', 'x-litellm-key-rpm-limit': '20' })

  assert.equal(entry.spend, 89.26, 'a key-scope spend must not be paired with a user-scope budget')
  assert.equal(entry.maxBudget, 100)
  assert.equal(entry.rpmLimit, 20, 'RPM is per key, so it is always adopted')
  assert.equal(quotaExhausted(entry), false, 'the healthy endpoint must stay selectable')
})

test('key-scope headers bind both spend and budget when the budget is key-scope', () => {
  const entry = endpointState(emptyState(), 'primary')
  quotaFromHeaders(entry, { 'x-litellm-key-spend': '95', 'x-litellm-key-max-budget': '100' })
  assert.equal(entry.quotaSource, 'key')
  assert.equal(entry.spend, 95)
  assert.equal(entry.maxBudget, 100)
  assert.equal(quotaExhausted(entry), false)

  quotaFromHeaders(entry, { 'x-litellm-key-spend': '100' })
  assert.equal(quotaExhausted(entry), true)
})

test('a probe-found 100% budget makes the endpoint unavailable without any error', () => {
  const target = spec('quota')
  const state = emptyState()
  const entry = endpointState(state, 'quota')
  entry.maxBudget = 100
  entry.spend = 100
  entry.quotaSource = 'key'

  assert.equal(quotaExhausted(entry), true)
  assert.equal(isUnavailable(state, target, 1000), true)
  assert.equal(availabilityOf(state, target, 1000, 60_000).reason, 'quota')
})

test('successful calls accumulate per-endpoint and pool-wide counters', () => {
  const state = emptyState()
  assert.equal(daySpendOf(endpointState(state, 'a')), 0)
  assert.equal(endpointState(state, 'a').totalTokensIn, 0)

  onSuccess(state, spec('a'), 1000, 10, {})                        // health only
  onSuccess(state, spec('b'), 1000, 10, {})
  recordUsage(state, 'a', { inputTokens: 10, outputTokens: 5 })
  assert.equal(recordUsage(state, 'a', { inputTokens: undefined, outputTokens: 'x' }), false)

  assert.equal(endpointState(state, 'a').totalTokensIn, 10)
  assert.equal(endpointState(state, 'a').totalTokensOut, 5)
  assert.equal(state.totalTokensIn, 10)
  assert.equal(state.totalTokensOut, 5)
  assert.equal(state.successes, undefined, 'no accidental top-level counter')

  // The pool total helpers tolerate junk rather than throwing.
  assert.equal(totalDaySpendOf(emptyState()), 0)
  assert.equal(totalDaySpendOf(undefined), 0)
  assert.equal(totalDaySpendOf({ endpoints: { a: { dayMaxSpend: 'x' } } }), 0)
})

test('cum is today\'s maximum, banked and reset at the local date change', () => {
  const state = emptyState()
  const entry = endpointState(state, 'a')
  const day4 = new Date(2026, 9, 4, 22, 55).getTime()      // local 2026-10-04 22:55
  const day5 = new Date(2026, 9, 5, 0, 5).getTime()        // local 2026-10-05 00:05
  const banked = []
  const record = { record: (date, usd, endpoints) => { banked.push({ date, usd, endpoints }); return true } }

  observeDaySpend(state, entry, 40, day4, record)
  assert.equal(state.dayKey, '2026-10-04')
  assert.equal(daySpendOf(entry), 40)
  observeDaySpend(state, entry, 55, day4, record)          // grows during the day
  assert.equal(daySpendOf(entry), 55)
  assert.equal(totalDaySpendOf(state), 55)
  assert.equal(banked.length, 0, 'nothing is banked before midnight')

  observeDaySpend(state, entry, 3, day5, record)           // first observation after midnight
  assert.deepEqual(banked, [{ date: '2026-10-04', usd: 55, endpoints: { a: 55 } }])
  assert.equal(state.dayKey, '2026-10-05')
  assert.equal(daySpendOf(entry), 3, 'cum restarts for the new day')
  assert.equal(state.spendSince, day5, 'the day counters restart too')
})

test('a rollover that the record already holds resets without counting twice', () => {
  const state = emptyState()
  const entry = endpointState(state, 'a')
  const day4 = new Date(2026, 9, 4, 23, 0).getTime()
  const day5 = new Date(2026, 9, 5, 0, 1).getTime()
  const record = { record: () => false }                   // file already has 2026-10-04

  observeDaySpend(state, entry, 42, day4, record)
  observeDaySpend(state, entry, 1, day5, record)
  assert.equal(state.dayKey, '2026-10-05')
  assert.equal(daySpendOf(entry), 1, 'the counter still resets for the new day')
})

test('the provider per-response cost is never treated as our bill', () => {
  const state = emptyState()
  onSuccess(state, spec('a'), new Date(2026, 9, 4, 12, 0).getTime(), 5, { 'x-litellm-response-cost': '0.25' })
  assert.equal(totalDaySpendOf(state), 0)
  assert.equal(state.spendSince, undefined)
})

test('an observed key-scope spend feeds today\'s maximum', () => {
  const state = emptyState()
  const now = new Date(2026, 9, 4, 12, 0).getTime()
  // No user-scope binding yet, so the key header is the binding figure.
  onSuccess(state, spec('a'), now, 5, { 'x-litellm-key-spend': '9.5' })
  assert.equal(totalDaySpendOf(state), 9.5)
  onSuccess(state, spec('a'), now + 1000, 5, { 'x-litellm-key-spend': '9.8' })
  assert.equal(totalDaySpendOf(state), 9.8, 'today\'s maximum, not the sum')
})

test('incomplete observations are ignored rather than corrupting the day', () => {
  const state = emptyState()
  const entry = endpointState(state, 'a')
  const now = new Date(2026, 9, 4, 12, 0).getTime()
  observeDaySpend(state, entry, Number.NaN, now)
  observeDaySpend(state, entry, -5, now)
  assert.equal(totalDaySpendOf(state), 0)
  assert.equal(state.spendSince, undefined)
})

test('token counting never invents dollars', () => {
  const state = emptyState()
  recordUsage(state, 'a', { inputTokens: 1_000_000, outputTokens: 500_000 })
  assert.equal(state.totalTokensIn, 1_000_000)
  assert.equal(state.totalTokensOut, 500_000)
  assert.equal(totalDaySpendOf(state), 0, 'dollars come from the provider spend only')
  assert.equal(state.spendSince, undefined)
})

test('usage with malformed fields counts as 0', () => {
  const state = emptyState()
  assert.equal(recordUsage(state, 'a', { inputTokens: 10, outputTokens: 5 }), true)
  assert.equal(state.totalTokensIn, 10)
  assert.equal(recordUsage(state, 'a', { inputTokens: 'x', outputTokens: Number.NaN }), false)
  assert.equal(state.totalTokensIn, 10)
})

test('token usage accumulates per endpoint and pool-wide, ignoring malformed input', () => {
  const state = emptyState()
  assert.equal(recordUsage(state, 'a', { inputTokens: 100, outputTokens: 20 }), true)
  assert.equal(recordUsage(state, 'a', { inputTokens: 50, outputTokens: 5 }), true)
  assert.equal(recordUsage(state, 'b', { inputTokens: undefined, outputTokens: Number.NaN }), false)
  assert.equal(recordUsage(state, 'b', {}), false)
  assert.equal(recordUsage(state, 'b', undefined), false)

  const entry = endpointState(state, 'a')
  assert.equal(entry.totalTokensIn, 150)
  assert.equal(entry.totalTokensOut, 25)
  assert.equal(state.totalTokensIn, 150)
  assert.equal(state.totalTokensOut, 25)
  assert.equal(endpointState(state, 'b').totalTokensIn, 0)
})
