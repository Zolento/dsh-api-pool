/**
 * Per-endpoint health state machine.
 *
 * Ported from AI-Scientist-v2 `api_pool.py` (`_endpoint_state`,
 * `_apply_recovery`, `_on_success`, `_on_failure`, `_load_score`), with the
 * Python-only pieces removed (fcntl, threading) and the cooldown policy made
 * explicit. All times are epoch milliseconds.
 */

import { ErrorKind, headerValue } from './kinds.js'

export const DEFAULT_COOLDOWNS = Object.freeze({
  rate_limit: 60_000,
  connection: 30_000,
  timeout: 60_000,
  server: 60_000,
  bad_request: 30_000,
  unknown: 30_000,
})

/** Root of the persisted pool state. */
export function emptyState() {
  return {
    version: 1,
    updatedAt: 0,
    roundRobinIndex: 0,
    quotaNextRefreshAt: 0,
    endpoints: {},
  }
}

/** Lazily create and return one endpoint's state entry. */
export function endpointState(state, name) {
  let entry = state.endpoints[name]
  if (entry === undefined) {
    entry = {
      cooldownUntil: 0,
      disabledUntil: 0,
      disabledReason: undefined,
      consecutiveFailures: 0,
      recentRequests: [],
      totalRequests: 0,
      totalFailures: 0,
      successes: 0,
      lastError: undefined,
      lastErrorKind: undefined,
      lastErrorAt: undefined,
      lastLatencyMs: undefined,
      spend: undefined,
      maxBudget: undefined,
      budgetDuration: undefined,
      budgetResetAt: undefined,
      rpmLimit: undefined,
      quotaSource: undefined,
      quotaCheckedAt: undefined,
    }
    state.endpoints[name] = entry
  }
  return entry
}

/** Clear a cooldown/disable window whose end time has passed. */
export function applyRecovery(state, spec, now) {
  const entry = endpointState(state, spec.name)
  if (entry.disabledUntil === -1) return entry
  if (entry.disabledUntil !== 0 && entry.disabledUntil <= now) {
    entry.disabledUntil = 0
    entry.disabledReason = undefined
  }
  if (entry.budgetResetAt !== undefined && now >= entry.budgetResetAt) {
    entry.spend = undefined
    entry.budgetResetAt = undefined
    entry.disabledUntil = 0
    entry.disabledReason = undefined
    entry.quotaCheckedAt = undefined
  }
  return entry
}

/** Whether the actively probed spend already exhausts the binding budget. */
/**
 * The cap actually enforced for one endpoint: the tighter of the budget the
 * provider grants and the local limit the user configured. Either may be absent.
 * @returns {number|undefined} USD cap, or undefined when neither is known.
 */
export function effectiveBudgetOf(entry, spec) {
  const provider = Number.isFinite(entry?.maxBudget) && entry.maxBudget > 0 ? entry.maxBudget : undefined
  const local = Number.isFinite(spec?.budgetLimit) && spec.budgetLimit > 0 ? spec.budgetLimit : undefined
  if (provider === undefined) return local
  if (local === undefined) return provider
  return Math.min(provider, local)
}

/**
 * Whether an endpoint has spent its budget. A probe or a response header can find
 * this without any error having been seen, which is what keeps the pool from
 * calling an endpoint it already knows is out of budget.
 */
export function quotaExhausted(entry, spec) {
  const cap = effectiveBudgetOf(entry, spec)
  return cap !== undefined && entry.spend !== undefined && entry.spend >= cap * 0.999
}

/** Whether this endpoint must be skipped right now. */
export function isUnavailable(state, spec, now) {
  const entry = applyRecovery(state, spec, now)
  if (spec.enabled === false) return true
  if (entry.disabledUntil === -1) return true
  if (entry.disabledUntil > now) return true
  if (entry.cooldownUntil > now) return true
  return quotaExhausted(entry, spec)
}

/** Requests inside the current RPM window, pruned to a bounded tail. */
export function recentRequests(entry, now, rpmWindowMs) {
  const kept = (entry.recentRequests ?? []).filter(stamp => now - stamp < rpmWindowMs)
  entry.recentRequests = kept.slice(-500)
  return entry.recentRequests
}

/** Fraction of a known RPM limit consumed in the window, or the raw count. */
export function loadScore(state, spec, entry, now, rpmWindowMs) {
  const recent = recentRequests(entry, now, rpmWindowMs)
  const rpm = entry.rpmLimit ?? spec.rpmLimit ?? 0
  if (!rpm) return recent.length
  return recent.length / rpm
}

/** Account for one dispatch, before it is made. */
export function recordRequest(state, entry, now) {
  entry.totalRequests += 1
  entry.recentRequests.push(now)
  state.roundRobinIndex += 1
}

/**
 * Apply the quota facts a response carried in headers.
 *
 * The `x-litellm-key-*` headers are **key-scope**. They must never be mixed with
 * a binding budget that came from the user-level probe: this proxy reports a
 * key's lifetime spend (e.g. `$1281.80`) while the enforced budget lives on the
 * user record (`$100`), and combining them marked a perfectly healthy endpoint
 * quota-exhausted. RPM is per key regardless of where the budget lives, so it is
 * always adopted.
 */
export function quotaFromHeaders(entry, headers) {
  const budgetIsKeyScope = entry.quotaSource !== 'user'
  const spend = headerValue(headers, 'x-litellm-key-spend')
  const maxBudget = headerValue(headers, 'x-litellm-key-max-budget')
  const rpmLimit = headerValue(headers, 'x-litellm-key-rpm-limit')
    ?? headerValue(headers, 'x-ratelimit-api_key-limit-requests')
  let hit = false
  if (budgetIsKeyScope && spend !== undefined && Number.isFinite(Number(spend))) {
    entry.spend = Number(spend)
    entry.quotaSource ??= 'key'
    hit = true
  }
  if (budgetIsKeyScope && maxBudget !== undefined && Number.isFinite(Number(maxBudget))) {
    entry.maxBudget = Number(maxBudget)
    entry.quotaSource = 'key'
    hit = true
  }
  if (rpmLimit !== undefined && Number.isFinite(Number(rpmLimit))) {
    entry.rpmLimit = Number(rpmLimit)
    hit = true
  }
  if (hit) entry.quotaCheckedAt = Date.now()
}

/** A successful call clears every transient penalty. */
export function onSuccess(state, spec, now, latencyMs, headers) {
  const entry = endpointState(state, spec.name)
  entry.cooldownUntil = 0
  entry.disabledUntil = 0
  entry.disabledReason = undefined
  entry.consecutiveFailures = 0
  entry.successes += 1
  entry.lastLatencyMs = Math.round(latencyMs)
  if (headers !== undefined) quotaFromHeaders(entry, headers)
}

/**
 * Record a failure and compute this endpoint's next penalty.
 * @returns {{ cooldownMs: number, action: 'failover'|'rethrow' }} the decision the caller must honor.
 */
export function onFailure(state, spec, entry, info, now, config) {
  entry.totalFailures += 1
  entry.consecutiveFailures += 1
  entry.lastError = info.message.slice(0, 1000)
  entry.lastErrorKind = info.kind
  entry.lastErrorAt = now
  if (info.kind === ErrorKind.AUTH) {
    entry.disabledUntil = -1
    entry.disabledReason = 'auth'
    return { cooldownMs: 0, action: 'failover' }
  }
  if (info.kind === ErrorKind.BAD_REQUEST) {
    // Rotating keys cannot fix a malformed request.
    entry.consecutiveFailures -= 1
    return { cooldownMs: 0, action: config.failoverOnBadRequest === true ? 'failover' : 'rethrow' }
  }
  if (info.kind === ErrorKind.QUOTA_EXHAUSTED) {
    const resetAt = info.resetAt ?? entry.budgetResetAt
    let until = now + config.quotaRecheckMs
    if (resetAt !== undefined && resetAt > now) until = Math.min(until, resetAt)
    entry.disabledUntil = Math.max(until, now + 1000)
    entry.disabledReason = 'quota_exhausted'
    if (info.resetAt !== undefined && entry.budgetResetAt === undefined) entry.budgetResetAt = info.resetAt
    return { cooldownMs: entry.disabledUntil - now, action: 'failover' }
  }

  const base = config.cooldowns?.[info.kind] ?? DEFAULT_COOLDOWNS[info.kind] ?? 30_000
  const exponential = base * Math.min(2 ** Math.max(entry.consecutiveFailures - 1, 0), 8)
  let cooldown = exponential
  if (info.retryAfterMs !== undefined && info.retryAfterMs > cooldown) cooldown = info.retryAfterMs
  else if (info.resetAt !== undefined && info.resetAt > now && info.resetAt - now > cooldown) cooldown = info.resetAt - now
  cooldown = Math.min(cooldown, config.maxCooldownMs)
  entry.cooldownUntil = Math.max(entry.cooldownUntil, now + cooldown)
  return { cooldownMs: cooldown, action: 'failover' }
}

/**
 * When one endpoint becomes selectable again, and why it is not now.
 *
 * A quota-exhausted endpoint with no known `budgetResetAt` is held for one
 * `quotaRecheckMs` after its last probe, so the pool cannot spin on an
 * endpoint that no probe will ever free.
 *
 * @returns {{available: boolean, reason: 'ready'|'cooldown'|'quota'|'auth'|'disabled', availableAt: number}}
 *   `availableAt` is `Infinity` for a permanently disabled endpoint.
 */
export function availabilityOf(state, spec, now, quotaRecheckMs = 1_800_000) {
  const entry = applyRecovery(state, spec, now)
  if (spec.enabled === false) return { available: false, reason: 'disabled', availableAt: Infinity }
  if (entry.disabledUntil === -1) return { available: false, reason: 'auth', availableAt: Infinity }

  let availableAt = Math.max(entry.cooldownUntil, entry.disabledUntil)
  let reason = entry.disabledUntil > now ? 'quota' : 'cooldown'
  if (availableAt <= now) {
    reason = 'ready'
    availableAt = now
  }
  if (quotaExhausted(entry, spec)) {
    const reset = entry.budgetResetAt ?? ((entry.quotaCheckedAt ?? now) + quotaRecheckMs)
    if (reset > availableAt) availableAt = reset
    reason = 'quota'
  }
  if (availableAt <= now) return { available: true, reason: 'ready', availableAt: now }
  return { available: false, reason, availableAt }
}

/**
 * Milliseconds until the soonest endpoint may be selected again.
 * @returns {number|undefined} undefined when every enabled endpoint is permanently disabled.
 */
export function timeUntilAvailable(state, specs, now, quotaRecheckMs) {
  let soonest
  for (const spec of specs) {
    if (spec.enabled === false) continue
    const { availableAt } = availabilityOf(state, spec, now, quotaRecheckMs)
    if (availableAt === Infinity) continue
    if (soonest === undefined || availableAt < soonest) soonest = availableAt
  }
  if (soonest === undefined) return undefined
  return Math.max(0, soonest - now)
}
