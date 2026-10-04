import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, endpointState, onFailure, onSuccess, recordRequest, isUnavailable, timeUntilAvailable } from '../src/pool/state.js'
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
