/**
 * Error classification for upstream API failures.
 *
 * Ported from AI-Scientist-v2 `ai_scientist/api_pool.py::classify_error` and
 * adapted to the errors a Node relay actually sees: an HTTP status, response
 * headers, and a response body (usually a JSON error envelope). Pure and
 * dependency-free so it can be unit-tested without a network.
 */

/** Stable failure classes; the pool's per-kind action table is keyed by these. */
export const ErrorKind = Object.freeze({
  RATE_LIMIT: 'rate_limit',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  AUTH: 'auth',
  CONNECTION: 'connection',
  TIMEOUT: 'timeout',
  SERVER: 'server',
  BAD_REQUEST: 'bad_request',
  UNKNOWN: 'unknown',
})

/** Kinds that mean "this key will not work again until a human fixes it". */
export const PERMANENT_KINDS = Object.freeze(new Set([ErrorKind.AUTH]))

const RESET_RE = /Limit resets at[:\s]*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(UTC|Z|[+-]\d{2}:?\d{2})?/i
const LIMIT_TYPE_RE = /Limit type[:\s]*([A-Za-z_]+)/i
const CURRENT_LIMIT_RE = /Current limit[:\s]*(\d+)/i
const REMAINING_RE = /Remaining[:\s]*(\d+)/i
const ERROR_TYPE_RE = /"type"\s*:\s*"([^"]+)"/i

// Deliberately narrow: a bare "budget"/"billing"/"quota" word appears in plenty
// of ordinary 400s ("invalid billing profile"), and matching those would bench a
// healthy endpoint for the whole quota-recheck window. The provider's own error
// type (`budget_exceeded`, …) is matched separately.
const BUDGET_RE = /exceeded[\s_-]*budget|budget[\s_-]?(?:exceeded|exhausted)|insufficient[\s_-]?(?:quota|balance|credits?)|quota[\s_-]?(?:exceeded|exhausted)|out of (?:credits?|budget)|(?:credit|balance)\s+is\s+too\s+low|exceeded your current quota/i
const AUTH_RE = /invalid api key|incorrect api key|authentication|unauthorized|api key not valid|no auth credentials|auth_error|permission denied/i
const TIMEOUT_RE = /timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|aborted/i
const CONNECTION_RE = /ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|connection error|other side closed|fetch failed|other side closed|Terminated|premature close|network error/i

/** Parse a service timestamp (ISO-8601 or ``... UTC``) into epoch milliseconds. */
export function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  let text = String(value).trim()
  text = text.replace(/\s*UTC\s*$/i, 'Z')
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) text = text.replace(' ', 'T')
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Read one numeric header case-insensitively. */
export function headerValue(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const direct = headers.get(name)
    if (direct !== undefined && direct !== null) return String(direct)
  }
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value !== undefined && value !== null) return String(value)
  }
  return undefined
}

/** Parse `retry-after` supporting both delta-seconds and an HTTP date. */
export function retryAfterMs(headers) {
  const raw = headerValue(headers, 'retry-after')
  if (raw === undefined) return undefined
  const text = raw.trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000
    return ms > 0 ? ms : undefined
  }
  const when = Date.parse(text)
  if (!Number.isFinite(when)) return undefined
  const delta = when - Date.now()
  return delta > 0 ? delta : undefined
}

/** Extract the best available text from a response body. */
function bodyText(body) {
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

/**
 * Classify one upstream failure.
 *
 * @param {object} input
 * @param {number|undefined} input.status HTTP status when the failure preceded streaming.
 * @param {object|undefined} input.headers Response headers.
 * @param {unknown} input.body Decoded response body, when any.
 * @param {unknown} input.error The thrown transport error, when the failure never got a response.
 * @returns {object} structured ErrorInfo.
 */
export function classifyError({ status, headers, body } = {}) {
  const text = bodyText(body)
  const typeMatch = ERROR_TYPE_RE.exec(text)
  const errorType = typeMatch === null ? undefined : typeMatch[1]

  const info = {
    kind: ErrorKind.UNKNOWN,
    httpStatus: Number.isInteger(status) ? status : undefined,
    message: text.slice(0, 2000),
    errorType,
    limitType: undefined,
    currentLimit: undefined,
    remaining: undefined,
    resetAt: undefined,
    retryAfterMs: retryAfterMs(headers),
    isBudget: false,
  }

  const limitType = LIMIT_TYPE_RE.exec(text)
  if (limitType !== null) info.limitType = limitType[1].toLowerCase()
  const current = CURRENT_LIMIT_RE.exec(text)
  if (current !== null) info.currentLimit = Number(current[1])
  const remaining = REMAINING_RE.exec(text)
  if (remaining !== null) info.remaining = Number(remaining[1])
  const reset = RESET_RE.exec(text)
  if (reset !== null) {
    const suffix = reset[2] === undefined || /^(utc|z)$/i.test(reset[2]) ? 'Z' : reset[2]
    info.resetAt = parseTimestamp(`${reset[1]}${suffix}`)
  }

  const hasStatus = Number.isInteger(info.httpStatus)
  let isBudget = BUDGET_RE.test(text)
    || ['budget_exceeded', 'insufficient_quota', 'quota_exceeded'].includes((errorType ?? '').toLowerCase())
  // A rate limit that talks about a request/token window is NOT a budget problem,
  // even though LiteLLM puts "limit" in the wording.
  if (['requests', 'tokens', 'max_parallel_requests'].includes(info.limitType)) isBudget = false
  // Only a status that can actually carry a budget verdict may disable an
  // endpoint for the whole quota window; a stray word in an ordinary 400 must not.
  isBudget = isBudget && (!hasStatus || info.httpStatus === 400 || info.httpStatus === 402 || info.httpStatus === 429)
  info.isBudget = isBudget

  // Order matters: an explicit HTTP status is authoritative. Text heuristics run
  // only when the failure carried no status, so a 400 whose body happens to say
  // "connection" is still a bad request (no failover) rather than a transport
  // error that would rotate through every key.
  if (info.httpStatus === 401 || info.httpStatus === 403 || (!hasStatus && AUTH_RE.test(text))) {
    info.kind = ErrorKind.AUTH
  } else if (isBudget || info.httpStatus === 402) {
    info.kind = ErrorKind.QUOTA_EXHAUSTED
  } else if (info.httpStatus === 429 || /ratelimit|throttl/i.test(errorType ?? '')) {
    info.kind = ErrorKind.RATE_LIMIT
  } else if (info.httpStatus === 408 || info.httpStatus === 504) {
    info.kind = ErrorKind.TIMEOUT
  } else if (hasStatus && info.httpStatus >= 500) {
    info.kind = ErrorKind.SERVER
  } else if (hasStatus && info.httpStatus >= 400) {
    info.kind = ErrorKind.BAD_REQUEST
  } else if (!hasStatus && TIMEOUT_RE.test(text)) {
    info.kind = ErrorKind.TIMEOUT
  } else if (!hasStatus && CONNECTION_RE.test(text)) {
    info.kind = ErrorKind.CONNECTION
  } else if (!hasStatus && /ratelimit|throttl/i.test(errorType ?? '')) {
    info.kind = ErrorKind.RATE_LIMIT
  } else {
    info.kind = ErrorKind.UNKNOWN
  }
  return info
}

/** Classify a thrown transport error that produced no HTTP response. */
export function classifyTransportError(error) {
  return classifyError({ headers: undefined, body: String(error?.message ?? error), error })
}

/** One-line human summary, used in logs. */
export function summaryOf(info) {
  const bits = [info.kind]
  if (info.httpStatus !== undefined) bits.push(`HTTP ${info.httpStatus}`)
  if (info.errorType !== undefined) bits.push(`type=${info.errorType}`)
  if (info.limitType !== undefined) bits.push(`limit_type=${info.limitType}`)
  if (info.currentLimit !== undefined) bits.push(`limit=${info.currentLimit}`)
  if (info.remaining !== undefined) bits.push(`remaining=${info.remaining}`)
  return bits.join(' ')
}
