/**
 * Proactive quota discovery.
 *
 * Ported from AI-Scientist-v2 `api_pool.py::probe_quota` / `refresh_quotas`.
 * Quota is *discovered* from the LiteLLM-compatible `/key/info` and
 * `/user/info` endpoints; the binding budget is the candidate with the highest
 * spend ratio, and the RPM limit is the strictest one below "effectively
 * unlimited".
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
  const candidates = []
  for (const [source, record] of [['key', keyRecord], ['user', userRecord]]) {
    if (typeof record !== 'object' || record === null) continue
    const maxBudget = Number(record.max_budget)
    if (!Number.isFinite(maxBudget) || maxBudget <= 0) continue
    candidates.push({
      quotaSource: source,
      maxBudget,
      spend: Number(record.spend ?? 0),
      budgetDuration: record.budget_duration,
      budgetResetAt: parseTimestamp(record.budget_reset_at),
    })
  }
  const rpms = []
  for (const record of [keyRecord, userRecord]) {
    if (typeof record !== 'object' || record === null) continue
    const rpm = Number(record.rpm_limit)
    if (Number.isFinite(rpm) && rpm > 0 && rpm < 1e9) rpms.push(rpm)
  }
  if (candidates.length > 0) {
    candidates.sort((left, right) => (right.spend / right.maxBudget) - (left.spend / left.maxBudget))
    Object.assign(merged, candidates[0])
  }
  if (rpms.length > 0) merged.rpmLimit = Math.min(...rpms)
  if (Object.keys(merged).length === 0) return undefined
  merged.quotaCheckedAt = Date.now()
  return merged
}

/**
 * Refresh quota for every enabled endpoint, throttled by a shared deadline.
 * Undefined fields never overwrite a known value.
 */
export async function refreshQuotas(specs, state, resolveKey, config, now = Date.now()) {
  if (!config.quotaEnabled) return
  if (now < state.quotaNextRefreshAt) return
  state.quotaNextRefreshAt = now + config.quotaRefreshMs
  for (const spec of specs) {
    if (spec.enabled === false) continue
    let apiKey
    try {
      apiKey = await resolveKey(spec)
    } catch {
      continue
    }
    const discovered = await probeQuota(spec, apiKey, { fetchImpl: config.fetchImpl ?? fetch, timeoutMs: config.quotaProbeTimeoutMs })
    if (discovered === undefined) continue
    const entry = endpointState(state, spec.name)
    for (const [key, value] of Object.entries(discovered)) {
      if (value !== undefined && value !== null) entry[key] = value
    }
    config.onEvent?.('quota_refresh', {
      endpoint: spec.name,
      spend: entry.spend,
      max_budget: entry.maxBudget,
      rpm_limit: entry.rpmLimit,
    })
  }
}
