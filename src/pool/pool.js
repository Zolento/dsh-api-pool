/**
 * The pool orchestrator: selection loop, failover, blocking wait, and the
 * per-request state transactions.
 *
 * This is the direct analogue of `api_pool.py::APIPool.request` with
 * `client.chat.completions.create(...)` replaced by a caller-supplied
 * `attempt(spec, apiKey)` callback, which keeps the loop transport-agnostic
 * and unit-testable.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { classifyTransportError, summaryOf } from './kinds.js'
import { emptyState, endpointState, onFailure, onSuccess, recordRequest, applyRecovery, recentRequests, timeUntilAvailable, availabilityOf, totalSpendOf } from './state.js'
import { selectEndpoint } from './select.js'
import { refreshQuotas } from './quota.js'

/** Base class for pool-level failures. */
export class PoolError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'PoolError'
    this.code = code
  }
}

/** Raised when no endpoint can serve the request within the configured bounds. */
export class AllEndpointsUnavailable extends PoolError {
  constructor(message) {
    super(message, 'ALL_ENDPOINTS_UNAVAILABLE')
    this.name = 'AllEndpointsUnavailable'
  }
}

/** Delay that honors cancellation. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Endpoint fields that are a *fetched hint* rather than device state. They are
 * dropped when state is loaded; see {@link StateStore.load}.
 */
const QUOTA_HINT_FIELDS = Object.freeze([
  'spend', 'maxBudget', 'budgetDuration', 'budgetResetAt', 'quotaSource', 'quotaCheckedAt',
])

/** Persist pool state next to the plugin; writes are atomic and lock-free. */
export class StateStore {
  constructor(file) {
    this.file = file
  }

  /** Read the persisted state, or an empty one when absent/corrupt. */
  load() {
    if (!existsSync(this.file)) return emptyState()
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return emptyState()
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.endpoints !== 'object') return emptyState()
    const state = { ...emptyState(), ...parsed }
    // Quota facts are a hint fetched from the provider, and a stale
    // (spend, maxBudget) pair — written by an older build, or measured in a
    // window that has since reset — would keep marking a healthy endpoint
    // "quota exhausted" for as long as it sits in the file. Drop them on load
    // and let the startup probe repopulate; cooldowns keep their own expiry.
    for (const entry of Object.values(state.endpoints)) {
      if (typeof entry !== 'object' || entry === null) continue
      for (const field of QUOTA_HINT_FIELDS) delete entry[field]
    }
    return state
  }

  /**
   * Atomically replace the persisted state; failures are non-fatal.
   *
   * Deliberately lock-free: the pool never does read-modify-write here (state is
   * loaded once at startup) and every write is a complete temp file published by
   * `rename`, so a concurrent writer can only be overwritten, never observed
   * half-written. The previous advisory lock spun synchronously for up to two
   * seconds on the request path and bought nothing for that access pattern.
   */
  save(state) {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      state.updatedAt = Date.now()
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, undefined, 2)}\n`)
      renameSync(tmp, this.file)
    } catch { /* state persistence is best-effort */ }
  }
}

/** Milliseconds before the request-wide deadline expires. */
function remaining(totalDeadline, now) {
  return totalDeadline === undefined ? Infinity : totalDeadline - now
}

/**
 * One pool over an ordered list of endpoints.
 */
export class ApiPool {
  /**
   * @param {object} options
   * @param {object} options.config resolved pool configuration (see `config.js`).
   * @param {object} [options.state] preloaded state; defaults to an empty state.
   * @param {object} [options.store] persistence handle.
   * @param {object} [options.events] event sink.
   * @param {(spec: object) => Promise<string|undefined>} options.resolveKey credential resolver.
   * @param {() => number} [options.now] injectable clock (tests).
   * @param {(ms: number) => Promise<void>} [options.sleep] injectable sleep (tests).
   */
  constructor({ config, state, store, events, resolveKey, now = () => Date.now(), sleep = delay }) {
    this.config = config
    this.state = state ?? emptyState()
    this.store = store
    this.events = events
    this.resolveKey = resolveKey
    this.now = now
    this.sleep = sleep
    this.saveTimer = undefined
    this.refreshing = undefined
  }

  /** Normalized endpoint specs in configuration order. */
  get specs() {
    return this.config.endpoints
  }

  /**
   * Schedule a best-effort state save.
   *
   * This is called on every request outcome, and `StateStore.save` is
   * synchronous (atomic rename under an advisory lock, which spins while
   * another process holds it). Writing per request would stall the event loop,
   * so saves are coalesced to at most one per second; {@link flush} writes the
   * final state on shutdown.
   */
  persist() {
    if (this.store === undefined || this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.store.save(this.state)
    }, 1000)
    this.saveTimer.unref?.()
  }

  /** Write the current state now, cancelling a pending coalesced save. */
  flush() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    this.store?.save(this.state)
  }

  /**
   * Refresh quota facts, throttled by the shared deadline.
   *
   * Concurrent callers share one probe round: a request must never queue behind
   * another request's network probes.
   * @param {boolean} [force] probe now even inside the throttle window.
   */
  async refreshQuotas(force = false) {
    if (this.refreshing !== undefined) {
      // Join the in-flight round instead of piling on; a forced caller (startup)
      // still gets its own round afterwards, otherwise a request-triggered round
      // could satisfy the guard and swallow the forced probe entirely.
      await this.refreshing.catch(() => {})
      if (!force) return
    }
    const round = refreshQuotas(this.specs, this.state, this.resolveKey, this.config, this.now(), force)
      .finally(() => { if (this.refreshing === round) this.refreshing = undefined })
    this.refreshing = round
    await round
  }

  /** Snapshot of endpoint health, for status surfaces. */
  status() {
    const now = this.now()
    return this.specs.map((spec) => {
      const entry = applyRecovery(this.state, spec, now)
      const recent = recentRequests(entry, now, this.config.rpmWindowMs).length
      const availability = availabilityOf(this.state, spec, now, this.config.quotaRecheckMs)
      let state = 'ready'
      if (spec.enabled === false) state = 'disabled'
      else if (entry.disabledUntil === -1) state = 'DISABLED'
      else if (entry.disabledUntil > now) state = `quota(${Math.ceil((entry.disabledUntil - now) / 1000)}s)`
      else if (entry.cooldownUntil > now) state = `cooldown(${Math.ceil((entry.cooldownUntil - now) / 1000)}s)`
      // A probe can find the budget spent without any error having been seen;
      // the state string must say so instead of claiming "ready" while the
      // selector skips the endpoint.
      else if (!availability.available && availability.reason === 'quota') {
        const percent = Number.isFinite(entry.spend) && Number.isFinite(entry.maxBudget) && entry.maxBudget > 0
          ? ` ${Math.min(999, Math.round((entry.spend / entry.maxBudget) * 100))}%`
          : ''
        state = `quota(${percent.trim()})`
      }
      return {
        name: spec.name,
        baseURL: spec.baseURL,
        state,
        available: availability.available,
        reason: availability.reason,
        availableInMs: availability.availableAt === Infinity ? Infinity : Math.max(0, availability.availableAt - now),
        recent,
        rpmLimit: entry.rpmLimit ?? spec.rpmLimit,
        spend: entry.spend,
        maxBudget: entry.maxBudget,
        /** Cumulative provider-reported spend for this endpoint (0 when unknown). */
        totalSpend: Number.isFinite(entry.totalSpend) ? entry.totalSpend : 0,
        lastError: entry.lastError,
        lastErrorKind: entry.lastErrorKind,
        totalRequests: entry.totalRequests,
        totalFailures: entry.totalFailures,
        successes: entry.successes,
      }
    })
  }

  /**
   * Whole-pool cumulative spend since this pool first counted it. Never resets
   * with a budget window and survives an endpoint being removed from the config.
   * @returns {{ spendUsd: number, since: number|undefined }}
   */
  totals() {
    return { spendUsd: totalSpendOf(this.state), since: this.state.spendSince }
  }

  /**
   * Whole-pool capacity snapshot: how many endpoints are usable now, and when
   * the next one recovers (`next`) — i.e. which endpoint a blocked request is
   * waiting on and for how long.
   */
  availability() {
    const now = this.now()
    const rows = this.specs
      .filter(spec => spec.enabled !== false)
      .map((spec) => {
        const entry = applyRecovery(this.state, spec, now)
        return { spec, lastErrorKind: entry.lastErrorKind, ...availabilityOf(this.state, spec, now, this.config.quotaRecheckMs) }
      })
    const ready = rows.filter(row => row.available)
    const pending = rows.filter(row => !row.available && row.availableAt !== Infinity)
      .sort((left, right) => left.availableAt - right.availableAt)
    const next = pending[0]
    return {
      enabled: rows.length,
      ready: ready.length,
      blocked: ready.length === 0,
      next: next === undefined
        ? undefined
        : { name: next.spec.name, reason: next.reason, inMs: Math.max(0, next.availableAt - now), lastErrorKind: next.lastErrorKind },
      permanentlyDisabled: rows.filter(row => !row.available && row.availableAt === Infinity).map(row => row.spec.name),
    }
  }

  /**
   * Run one logical request through the pool.
   *
   * @param {(spec: object, apiKey: string|undefined, context: object) => Promise<unknown>} attempt
   *   Performs one upstream attempt. Throw an error carrying `poolInfo` (an
   *   ErrorInfo) to report a classified upstream failure.
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] caller cancellation.
   * @returns {Promise<unknown>} the successful attempt's return value.
   */
  async execute(attempt, { signal } = {}) {
    const config = this.config
    if (config.enabled === false) throw new AllEndpointsUnavailable('API pool is disabled')
    if (this.specs.length === 0) {
      throw new AllEndpointsUnavailable('API pool has no endpoints configured; open Settings → API Pool to add one')
    }

    const now0 = this.now()
    const started = now0
    const totalDeadline = config.totalRequestTimeoutMs > 0 ? started + config.totalRequestTimeoutMs : undefined
    let waited = 0
    let attempts = 0
    let lastError
    const excluded = new Set()

    // Refresh in the background: a request must not wait on another endpoint's
    // probe latency, and a stale-by-one-window quota figure is not a reason to
    // delay a user request. The throttle inside keeps this rare.
    void this.refreshQuotas().catch(() => {})

    while (true) {
      const now = this.now()
      if (remaining(totalDeadline, now) <= 0) {
        throw new AllEndpointsUnavailable(`API pool exceeded total request timeout (${config.totalRequestTimeoutMs}ms) after ${attempts} attempt(s)${lastError === undefined ? '' : `; last error: ${lastError}`}`)
      }

      let spec = selectEndpoint(this.specs, this.state, now, {
        excluded,
        strategy: config.strategy,
        rpmWindowMs: config.rpmWindowMs,
        safetyMargin: config.safetyMargin,
      })
      if (spec === undefined && excluded.size > 0) {
        // Everything eligible has been tried once: allow already-cooled endpoints again.
        excluded.clear()
        spec = selectEndpoint(this.specs, this.state, now, {
          excluded,
          strategy: config.strategy,
          rpmWindowMs: config.rpmWindowMs,
          safetyMargin: config.safetyMargin,
        })
      }

      if (spec === undefined) {
        const wait = timeUntilAvailable(this.state, this.specs, now, this.config.quotaRecheckMs)
        if (wait === undefined) {
          throw new AllEndpointsUnavailable('every pool endpoint is permanently disabled (auth/invalid key); fix the endpoint credentials and retry')
        }
        if (config.maxBlockWaitMs > 0 && waited + wait > config.maxBlockWaitMs) {
          throw new AllEndpointsUnavailable(`API pool would wait ${Math.ceil(wait / 1000)}s but the block budget is ${Math.ceil(config.maxBlockWaitMs / 1000)}s${lastError === undefined ? '' : `; last error: ${lastError}`}`)
        }
        this.events?.emit('all_endpoints_busy', {
          wait_seconds: Math.round(wait / 100) / 10,
          attempts,
          last_error: lastError === undefined ? undefined : String(lastError).slice(0, 300),
        })
        const nap = Math.min(Math.max(wait, 50), 5000)
        const budget = remaining(totalDeadline, this.now())
        if (Number.isFinite(budget) && nap > budget) {
          throw new AllEndpointsUnavailable(`API pool exhausted its total request timeout after ${attempts} attempt(s)`)
        }
        await this.sleep(nap, signal)
        waited += nap
        continue
      }

      const entry = endpointState(this.state, spec.name)
      recordRequest(this.state, entry, now)

      let apiKey
      try {
        apiKey = await this.resolveKey(spec)
      } catch (error) {
        const decision = onFailure(this.state, spec, entry, classifyTransportError(error), this.now(), config)
        this.events?.emit('failover', {
          endpoint: spec.name, kind: 'credential', attempt: attempts + 1,
          cooldown_seconds: Math.round(decision.cooldownMs / 100) / 10,
          message: String(error?.message ?? error).slice(0, 500),
        })
        this.persist()
        excluded.add(spec.name)
        attempts += 1
        lastError = error
        if (attempts >= config.maxAttemptsPerRequest) {
          throw new AllEndpointsUnavailable(`API pool exceeded ${config.maxAttemptsPerRequest} attempts; last error: ${lastError}`)
        }
        continue
      }

      const callStarted = this.now()
      try {
        const result = await attempt(spec, apiKey, { signal, attempt: attempts + 1 })
        onSuccess(this.state, spec, this.now(), this.now() - callStarted, result?.headers)
        this.events?.emit('success', { endpoint: spec.name, latency_ms: entry.lastLatencyMs })
        this.persist()
        return result
      } catch (error) {
        if (signal?.aborted) throw error
        const info = error?.poolInfo ?? classifyTransportError(error)
        const decision = onFailure(this.state, spec, entry, info, this.now(), config)
        attempts += 1
        this.events?.emit('failover', {
          endpoint: spec.name,
          kind: info.kind,
          http_status: info.httpStatus,
          error_type: info.errorType,
          limit_type: info.limitType,
          remaining: info.remaining,
          attempt: attempts,
          cooldown_seconds: Math.round(decision.cooldownMs / 100) / 10,
          disabled_reason: entry.disabledReason,
          message: info.message.slice(0, 500),
        })
        this.persist()
        if (decision.action === 'rethrow') throw error
        excluded.add(spec.name)
        lastError = `${summaryOf(info)} ${info.message.slice(0, 300)}`
        if (attempts >= config.maxAttemptsPerRequest) {
          throw new AllEndpointsUnavailable(`API pool exceeded ${config.maxAttemptsPerRequest} attempts; last error: ${lastError}`)
        }
      }
    }
  }
}
