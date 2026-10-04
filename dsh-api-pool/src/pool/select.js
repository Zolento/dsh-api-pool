/**
 * Endpoint selection strategies.
 *
 * Ported from AI-Scientist-v2 `api_pool.py::_select` /
 * `_load_score`. The Python `safety_margin` field was declared but never read;
 * here it is actually honored as a soft load gate (see below).
 */

import { applyRecovery, isUnavailable, loadScore } from './state.js'

/** Lexicographic compare of two numeric/string key arrays. */
function compare(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] === right[index]) continue
    return left[index] < right[index] ? -1 : 1
  }
  return left.length - right.length
}

/** The sort key for one eligible endpoint under the configured strategy. */
function sortKey(spec, state, load, strategy) {
  if (strategy === 'priority') return [spec.priority, load, spec.name]
  return [load, spec.priority, spec.name]
}

/**
 * Pick the next endpoint to try.
 *
 * @param {object[]} specs normalized endpoint specs (config order).
 * @param {object} state pool state (`emptyState()` shape).
 * @param {number} now epoch milliseconds.
 * @param {object} options
 * @param {Set<string>} options.excluded endpoints already tried for this request.
 * @param {string} options.strategy `least_loaded` | `priority` | `round_robin`.
 * @param {number} options.rpmWindowMs RPM window width.
 * @param {number|undefined} options.safetyMargin soft load gate; endpoints at or above it are
 *   skipped only while another candidate is below it (so a fully-saturated pool still makes progress).
 * @returns {object|undefined} the chosen spec.
 */
export function selectEndpoint(specs, state, now, {
  excluded = new Set(),
  strategy = 'least_loaded',
  rpmWindowMs = 60_000,
  safetyMargin,
} = {}) {
  state.endpointsTotal = specs.length
  let best
  let bestKey
  let fallback
  let fallbackKey
  const eligible = []
  for (const spec of specs) {
    if (spec.enabled === false) continue
    if (excluded.has(spec.name)) continue
    const entry = applyRecovery(state, spec, now)
    if (isUnavailable(state, spec, now)) continue
    const load = loadScore(state, spec, entry, now, rpmWindowMs)
    eligible.push({ spec, load, entry })
    const key = sortKey(spec, state, load, strategy)
    if (fallbackKey === undefined || compare(key, fallbackKey) < 0) {
      fallbackKey = key
      fallback = spec
    }
    const overMargin = safetyMargin !== undefined && entry.rpmLimit !== undefined
      && load >= safetyMargin
    if (overMargin) continue
    if (bestKey === undefined || compare(key, bestKey) < 0) {
      bestKey = key
      best = spec
    }
  }
  if (strategy === 'round_robin' && eligible.length > 0) {
    // A true rotation: order eligible endpoints by (priority, name) and offset
    // into that list by the shared dispatch counter. (The Python reference
    // emitted the same key for every endpoint, so its rotation always picked
    // the alphabetically first one — that latent bug is fixed here.)
    eligible.sort((left, right) => left.spec.priority - right.spec.priority
      || left.spec.name.localeCompare(right.spec.name))
    return eligible[state.roundRobinIndex % eligible.length].spec
  }
  return best ?? fallback
}
