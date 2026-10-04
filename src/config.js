/**
 * Plugin configuration schema and its resolution into a pool configuration.
 *
 * The schema is what DeepSeek Harness renders as the settings form: a field is
 * editable live only when it is declared `volatile`, so every user-managed
 * field is volatile and the whole `endpoints` array is volatile as one unit
 * (that is what allows indexed path edits such as removing an endpoint).
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_COOLDOWNS } from './pool/state.js'

/** One upstream endpoint as stored in settings. */
const endpointSchema = z.object({
  name: z.string().required(),
  baseURL: z.string().required(),
  apiKeyEnv: z.string(),
  apiKey: z.string().role('secret'),
  model: z.string(),
  priority: z.number().step(1).default(100),
  rpmLimit: z.number().step(1),
  enabled: z.boolean().default(true),
})

/** Plugin configuration. */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  exposeProvider: z.boolean().default(true).volatile(),
  providerId: z.string().default('deepseek-pool').volatile(),
  displayName: z.string().default('API Pool').volatile(),
  strategy: z.union(['least_loaded', 'priority', 'round_robin']).default('least_loaded').volatile(),
  models: z.array(z.string()).default(['deepseek-flash']).volatile(),
  api: z.string().default('openai-completions').volatile(),
  reasoning: z.union(['off', 'low', 'high', 'max']).default('high').volatile(),
  thinkingFormat: z.string().default('deepseek').volatile(),
  contextWindow: z.number().step(1).min(1).default(1_000_000).volatile(),
  maxTokens: z.number().step(1).min(1).default(65_536).volatile(),
  basePath: z.string().default('/v1').volatile(),
  endpoints: z.array(endpointSchema).default([]).volatile(),

  // Pool tuning (milliseconds).
  safetyMargin: z.number().min(0).max(1).default(0.9).volatile(),
  rpmWindowMs: z.number().step(1).min(1).default(60_000).volatile(),
  maxCooldownMs: z.number().step(1).min(1).default(3_600_000).volatile(),
  quotaRecheckMs: z.number().step(1).min(1).default(1_800_000).volatile(),
  quotaRefreshMs: z.number().step(1).min(1).default(300_000).volatile(),
  quotaProbeEnabled: z.boolean().default(true).volatile(),
  maxAttemptsPerRequest: z.number().step(1).min(1).default(20).volatile(),
  totalRequestTimeoutMs: z.number().step(1).min(1).default(1_800_000).volatile(),
  maxBlockWaitMs: z.number().step(1).min(1).default(21_600_000).volatile(),
  requestTimeoutMs: z.number().step(1).min(1).default(600_000).volatile(),
  failoverOnBadRequest: z.boolean().default(false).volatile(),
  logSuccesses: z.boolean().default(false).volatile(),
  cooldowns: z.dict(z.number()).default({ ...DEFAULT_COOLDOWNS }).volatile(),
})

/** @returns plain values from an optionally-volatile config object. */
export function plainConfig(config) {
  const out = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    // A schemastery `.volatile()` value is a one-key `{ get() }` reference.
    const isVolatile = typeof value === 'object' && value !== null
      && typeof value.get === 'function' && Object.keys(value).length === 1
    out[key] = isVolatile ? value.get() : value
  }
  return out
}

/** @returns whether a URL is an HTTP(S) root without credentials/query/fragment. */
export function validBaseURL(value) {
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
  } catch {
    return false
  }
}

/** Normalize the stored endpoints into the shape the pool consumes. */
export function normalizeEndpoints(raw) {
  const endpoints = []
  const seen = new Set()
  for (const [index, candidate] of (Array.isArray(raw) ? raw : []).entries()) {
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : ''
    const baseURL = typeof candidate?.baseURL === 'string' ? candidate.baseURL.trim() : ''
    if (name === '' || baseURL === '') continue
    if (!validBaseURL(baseURL)) continue
    if (seen.has(name)) continue
    seen.add(name)
    endpoints.push({
      name,
      baseURL: baseURL.replace(/\/+$/, ''),
      apiKeyEnv: typeof candidate.apiKeyEnv === 'string' && candidate.apiKeyEnv.trim() !== '' ? candidate.apiKeyEnv.trim() : undefined,
      apiKey: typeof candidate.apiKey === 'string' && candidate.apiKey.trim() !== '' ? candidate.apiKey.trim() : undefined,
      model: typeof candidate.model === 'string' && candidate.model.trim() !== '' ? candidate.model.trim() : undefined,
      priority: Number.isFinite(candidate.priority) ? candidate.priority : 100,
      rpmLimit: Number.isFinite(candidate.rpmLimit) && candidate.rpmLimit > 0 ? candidate.rpmLimit : undefined,
      enabled: candidate.enabled !== false,
      index,
    })
  }
  return endpoints
}

/**
 * Resolve the plugin config into the pool configuration the orchestrator reads.
 * @param {object} plain plain config values.
 * @param {object} extras runtime hooks (event sink, fetch, key resolver, clock).
 */
export function resolvePoolConfig(plain, extras = {}) {
  const cooldowns = {}
  for (const [kind, value] of Object.entries({ ...DEFAULT_COOLDOWNS, ...(plain.cooldowns ?? {}) })) {
    if (Number.isFinite(value) && value >= 0) cooldowns[kind] = value
  }
  return {
    enabled: plain.enabled !== false,
    strategy: plain.strategy ?? 'least_loaded',
    safetyMargin: Number.isFinite(plain.safetyMargin) ? plain.safetyMargin : undefined,
    rpmWindowMs: plain.rpmWindowMs ?? 60_000,
    maxCooldownMs: plain.maxCooldownMs ?? 3_600_000,
    quotaRecheckMs: plain.quotaRecheckMs ?? 1_800_000,
    quotaRefreshMs: plain.quotaRefreshMs ?? 300_000,
    quotaEnabled: plain.quotaProbeEnabled !== false,
    quotaProbeTimeoutMs: 15_000,
    maxAttemptsPerRequest: plain.maxAttemptsPerRequest ?? 20,
    totalRequestTimeoutMs: plain.totalRequestTimeoutMs ?? 1_800_000,
    maxBlockWaitMs: plain.maxBlockWaitMs ?? 21_600_000,
    requestTimeoutMs: plain.requestTimeoutMs ?? 600_000,
    failoverOnBadRequest: plain.failoverOnBadRequest === true,
    logSuccesses: plain.logSuccesses === true,
    cooldowns,
    endpoints: normalizeEndpoints(plain.endpoints),
    models: normalizeModels(plain.models),
    ...extras,
  }
}

/** The models advertised for the routed provider, deduplicated and non-empty. */
export function normalizeModels(raw) {
  const models = (Array.isArray(raw) ? raw : [])
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .filter(value => value !== '')
  return [...new Set(models)].length === 0 ? ['deepseek-flash'] : [...new Set(models)]
}
