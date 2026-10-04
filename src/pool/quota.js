/**
 * Proactive quota discovery.
 *
 * Ported from AI-Scientist-v2 `api_pool.py::probe_quota` / `refresh_quotas`.
 * Quota is *discovered* from the LiteLLM-compatible `/key/info` and
 * `/user/info` endpoints. Two deliberate deviations from the Python original,
 * forced by the observed proxy behaviour:
 *
 * 1. the binding budget is the **key** record's whenever it declares one, with
 *    the user record only as a fallback (the original picked the highest spend
 *    ratio, which mixes a user-scope `max_budget` with a key-scope `spend`);
 * 2. the RPM limit is the strictest value below "effectively unlimited".
 */

import { parseTimestamp } from './kinds.js'
import { endpointState } from './state.js'

/** Strip `/v1` and any trailing slash to reach the service root. */
export function rootURL(baseURL) {
  let root = String(baseURL).replace(/\/+$/, '')
  if (root.endsWith('/v1')) root = root.slice(0, -3)
  return root
}

async function getJson(url, apiKey, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body === 'object' && body !== null ? body : undefined
  } catch {
    return undefined
  }
}

/**
 * Interrogate one endpoint for its quota facts.
 * @returns {Promise<object|undefined>} quota fields, or undefined when nothing was discovered.
 */
export async function probeQuota(spec, apiKey, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const root = rootURL(spec.baseURL)
  const [keyInfo, userInfo] = await Promise.all([
    getJson(`${root}/key/info`, apiKey, fetchImpl, timeoutMs),
    getJson(`${root}/user/info`, apiKey, fetchImpl, timeoutMs),
  ])
  const keyRecord = keyInfo?.info
  const userRecord = userInfo?.user_info
  const merged = {}
  const candidateOf = (source, record) => {
    if (typeof record !== 'object' || record === null) return undefined
    const maxBudget = Number(record.max_budget)
    if (!Number.isFinite(maxBudget) || maxBudget <= 0) return undefined
    return {
      quotaSource: source,
      maxBudget,
      spend: Number(record.spend ?? 0),
      budgetDuration: record.budget_duration,
      budgetResetAt: parseTimestamp(record.budget_reset_at),
    }
  }
  // The key record wins whenever it declares a budget: that is the per-key
  // throttle this pool balances. The user record is the fallback for a key that
  // declares none (on this proxy the budget may live only on one of the two,
  // and their `spend` values are different scopes). Taking the "most used"
  // record instead — as the Python original does — combines a user budget with a
  // key spend and falsely exhausts healthy endpoints.
  const binding = candidateOf('key', keyRecord) ?? candidateOf('user', userRecord)
  if (binding !== undefined) Object.assign(merged, binding)
  const rpms = []
  for (const record of [keyRecord, userRecord]) {
    if (typeof record !== 'object' || record === null) continue
    const rpm = Number(record.rpm_limit)
    if (Number.isFinite(rpm) && rpm > 0 && rpm < 1e9) rpms.push(rpm)
  }
  if (rpms.length > 0) merged.rpmLimit = Math.min(...rpms)
  if (Object.keys(merged).length === 0) return undefined
  merged.quotaCheckedAt = Date.now()
  return merged
}

/**
 * Refresh quota for every enabled endpoint, throttled by a shared deadline.
 * Undefined fields never overwrite a known value.
 * @param {boolean} [force] probe now even inside the throttle window (startup).
 */
export async function refreshQuotas(specs, state, resolveKey, config, now = Date.now(), force = false) {
  if (!config.quotaEnabled) return
  if (!force && now < state.quotaNextRefreshAt) return
  state.quotaNextRefreshAt = now + config.quotaRefreshMs
  // Probe endpoints in parallel: sequentially, four endpoints cost eight round
  // trips and delay the moment quota is known (the startup probe is awaited by
  // nothing, but the data is stale for that whole window).
  const enabled = specs.filter(spec => spec.enabled !== false)
  const results = await Promise.all(enabled.map(async (spec) => {
    let apiKey
    try {
      apiKey = await resolveKey(spec)
    } catch {
      return { spec, reason: 'no-credential' }
    }
    const discovered = await probeQuota(spec, apiKey, { fetchImpl: config.fetchImpl ?? fetch, timeoutMs: config.quotaProbeTimeoutMs })
    return discovered === undefined ? { spec, reason: 'probe-failed' } : { spec, discovered }
  }))

  let discoveredCount = 0
  const failed = []
  for (const result of results) {
    if (result.discovered === undefined) {
      failed.push(`${result.spec.name}:${result.reason}`)
      continue
    }
    discoveredCount += 1
    const entry = endpointState(state, result.spec.name)
    for (const [key, value] of Object.entries(result.discovered)) {
      if (value !== undefined && value !== null) entry[key] = value
    }
    config.onEvent?.('quota_refresh', {
      endpoint: result.spec.name,
      spend: entry.spend,
      max_budget: entry.maxBudget,
      rpm_limit: entry.rpmLimit,
    })
  }
  // A round that read nothing (no credential yet, probe throttled, provider
  // unreachable) must neither stay silent nor wait the whole interval: report it
  // and retry soon, because until it succeeds every endpoint shows no budget.
  if (enabled.length > 0 && discoveredCount === 0) {
    state.quotaNextRefreshAt = now + Math.min(config.quotaRefreshMs, 30_000)
    config.onEvent?.('quota_refresh_failed', { endpoints: failed.join(' ') })
  }
  return { discovered: discoveredCount, failed }
}
