import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, endpointState, onFailure, onSuccess, recordRequest, isUnavailable, timeUntilAvailable, availabilityOf, quotaFromHeaders, quotaExhausted, responseCost, totalSpendOf } from '../src/pool/state.js'
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

test('responseCost reads the provider cost and counts anything missing as 0', () => {
  assert.equal(responseCost({ 'x-litellm-response-cost': '1.1999999999999999e-05' }), 1.1999999999999999e-05)
  assert.equal(responseCost({ 'x-litellm-response-cost-original': '0.5' }), 0.5)
  assert.equal(responseCost({}), 0, 'a deployment that reports no cost must not break anything')
  assert.equal(responseCost(undefined), 0)
  assert.equal(responseCost({ 'x-litellm-response-cost': 'not-a-number' }), 0)
  assert.equal(responseCost({ 'x-litellm-response-cost': '-3' }), 0)
  assert.equal(responseCost(new Headers({ 'x-litellm-response-cost': '0.25' })), 0.25, 'a Headers instance works too')
})

test('successful calls accumulate per-endpoint and pool-wide spend', () => {
  const state = emptyState()
  const a = spec('a')
  const b = spec('b')
  assert.equal(state.totalSpend, 0)
  assert.equal(endpointState(state, 'a').totalSpend, 0)

  onSuccess(state, a, 1000, 10, { 'x-litellm-response-cost': '0.25' })
  onSuccess(state, b, 1000, 10, { 'x-litellm-response-cost': '0.5' })
  onSuccess(state, a, 2000, 10, {})                            // no cost header → adds 0
  onSuccess(state, a, 3000, 10, { 'x-litellm-response-cost': 'garbage' })

  assert.equal(endpointState(state, 'a').totalSpend, 0.25)
  assert.equal(endpointState(state, 'b').totalSpend, 0.5)
  assert.equal(totalSpendOf(state), 0.75)
  assert.equal(state.spendSince, 1000)

  // The pool total is authoritative even before any endpoint entry exists.
  assert.equal(totalSpendOf(emptyState()), 0)
  assert.equal(totalSpendOf(undefined), 0)
  assert.equal(totalSpendOf({ totalSpend: 'nope' }), 0)
})
