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
    // Daily accounting. `dayKey` is the LOCAL date the current per-endpoint
    // `dayMaxSpend` values belong to; a date rollover banks that day and resets
    // `cum`. Completed days live in the rollover record file.
    dayKey: undefined,
    /** When today's counting started (first non-zero observation of the day). */
    spendSince: undefined,
    totalTokensIn: 0,
    totalTokensOut: 0,
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
      /** Largest binding spend seen today (0 until read); reset at a date rollover. */
      dayMaxSpend: 0,
      /** Exact token counts (the relay asks for streamed usage). */
      totalTokensIn: 0,
      totalTokensOut: 0,
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
export function quotaExhausted(entry) {
  return entry.spend !== undefined && entry.maxBudget !== undefined && entry.maxBudget > 0
    && entry.spend >= entry.maxBudget * 0.999
}

/** Whether this endpoint must be skipped right now. */
export function isUnavailable(state, spec, now) {
  const entry = applyRecovery(state, spec, now)
  if (spec.enabled === false) return true
  if (entry.disabledUntil === -1) return true
  if (entry.disabledUntil > now) return true
  if (entry.cooldownUntil > now) return true
  return quotaExhausted(entry)
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

/** Local calendar date (`YYYY-MM-DD`) for one instant. */
export function localDateKey(now) {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Fold one observed binding spend into today's maximum.
 *
 * `cum` is the largest spend seen so far **today**, taken from the provider's own
 * budget-window figure (no price of ours is involved). A day is banked and `cum`
 * reset by {@link rollOverDays}, which runs on the local-midnight date change.
 *
 * LIMITATIONS, accepted in exchange for using the provider's real numbers instead
 * of a price we would have to guess:
 * - it assumes the API's budget window is refreshed on the same daily cadence
 *   (the endpoints this plugin was built for reset at local midnight); an API that
 *   never resets reports its lifetime spend, and one that resets more often than
 *   we observe can under-count;
 * - the figure is the **key's or account's** spend, so usage by other clients of
 *   the same credential is included;
 * - two endpoints bound to the same account-level budget each count it.
 * Treat `cum` as a reference figure, not as an invoice.
 */
export function observeDaySpend(state, entry, spent, now, record) {
  // Keep `dayKey` on the actual calendar day: past local midnight the first
  // observation banks the previous day (once — the record file is the authority)
  // before folding the new value in.
  rollOverDays(state, record, now)
  if (!Number.isFinite(spent) || spent < 0) return
  const current = Number.isFinite(entry.dayMaxSpend) ? entry.dayMaxSpend : 0
  entry.dayMaxSpend = Math.max(current, spent)
  if (entry.dayMaxSpend > 0) state.spendSince ??= now
}

/** One endpoint's current-day figure. */
export function daySpendOf(entry) {
  return Number.isFinite(entry?.dayMaxSpend) ? entry.dayMaxSpend : 0
}

/** The whole pool's current-day figure. */
export function totalDaySpendOf(state) {
  let total = 0
  for (const entry of Object.values(state?.endpoints ?? {})) total += daySpendOf(entry)
  return total
}

/**
 * Bank the previous local day and reset today's counting.
 *
 * Runs on demand — the `/api-pool` command calls it — rather than at startup, so a
 * restart never books the same day twice. `record` is the durable list of dates
 * already banked: if the previous day is already in it, the in-memory reset still
 * happens but nothing is counted again, because the record file (not the process)
 * is the authority on what has been banked.
 *
 * @param {object} state pool state.
 * @param {{record: (date: string, usd: number, endpoints: object, now: number) => boolean}|undefined} record rollover log.
 * @param {number} now current epoch milliseconds.
 * @returns {{rolled: string|undefined, amount: number, alreadyRecorded: boolean}}
 */
export function rollOverDays(state, record, now) {
  const today = localDateKey(now)
  if (state.dayKey === undefined) {
    state.dayKey = today
    return { rolled: undefined, amount: 0, alreadyRecorded: false }
  }
  if (state.dayKey === today) return { rolled: undefined, amount: 0, alreadyRecorded: false }

  const date = state.dayKey
  const amount = totalDaySpendOf(state)
  const perEndpoint = Object.fromEntries(
    Object.entries(state.endpoints).map(([name, entry]) => [name, daySpendOf(entry)]),
  )
  let alreadyRecorded = false
  try {
    alreadyRecorded = record?.record(date, amount, perEndpoint, now) === false
  } catch { /* the record file is best-effort; the in-memory reset still happens */ }

  for (const entry of Object.values(state.endpoints)) entry.dayMaxSpend = 0
  state.spendSince = undefined
  state.dayKey = today
  return { rolled: date, amount, alreadyRecorded }
}

/**
 * A successful call clears every transient penalty.
 *
 * No cost is read here: `cum` is entirely our own accounting (see
 * {@link recordUsage}). The provider's `x-litellm-response-cost` exists only on
 * non-streaming responses, and its key-spend header is shared across clients and
 * updated in batches, so neither can be treated as this pool's bill.
 */
export function onSuccess(state, spec, now, latencyMs, headers, record) {
  const entry = endpointState(state, spec.name)
  entry.cooldownUntil = 0
  entry.disabledUntil = 0
  entry.disabledReason = undefined
  entry.consecutiveFailures = 0
  entry.successes += 1
  entry.lastLatencyMs = Math.round(latencyMs)
  if (headers !== undefined) quotaFromHeaders(entry, headers)
  // `entry.spend` is now the binding figure (a key-scope header is only adopted
  // when the binding budget is key-scope), so it is safe to fold into today.
  observeDaySpend(state, entry, entry.spend, now, record)
}

/**
 * Accumulate the exact token usage of one response.
 *
 * Tokens come from the provider's own `usage` object (the relay asks for streamed
 * usage explicitly). They are an exact secondary metric; the dollar figure comes
 * from the provider's daily budget-window spend instead, because pricing every
 * token would only be as accurate as a price we had to guess.
 * Missing or malformed fields count as 0.
 *
 * @param {object} state pool state.
 * @param {string} name endpoint name.
 * @param {{inputTokens?: number, outputTokens?: number}} usage parsed usage.
 * @returns {boolean} whether anything was accumulated.
 */
export function recordUsage(state, name, usage) {
  const entry = endpointState(state, name)
  const input = Number(usage?.inputTokens)
  const output = Number(usage?.outputTokens)
  const tokensIn = Number.isFinite(input) && input > 0 ? input : 0
  const tokensOut = Number.isFinite(output) && output > 0 ? output : 0
  if (tokensIn === 0 && tokensOut === 0) return false

  entry.totalTokensIn = (Number.isFinite(entry.totalTokensIn) ? entry.totalTokensIn : 0) + tokensIn
  entry.totalTokensOut = (Number.isFinite(entry.totalTokensOut) ? entry.totalTokensOut : 0) + tokensOut
  state.totalTokensIn = (Number.isFinite(state.totalTokensIn) ? state.totalTokensIn : 0) + tokensIn
  state.totalTokensOut = (Number.isFinite(state.totalTokensOut) ? state.totalTokensOut : 0) + tokensOut

  return true
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
  if (quotaExhausted(entry)) {
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
