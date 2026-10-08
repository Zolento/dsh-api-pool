/** Parse /loop arguments and durations in the form <digits><s|m|h>. */

/** Units the loop grammar accepts, in milliseconds. */
export const DURATION_UNITS = Object.freeze({ s: 1_000, m: 60_000, h: 3_600_000 })

/** Default minimum interval for fixed loops and adaptive scheduling. */
export const MIN_INTERVAL_MS = 30_000

/** `30s`, `5m`, `1h` -- nothing else. */
const DURATION_PATTERN = /^(\d+)([smh])$/iu

/** Reject digit-plus-letter tokens with unsupported units, such as 5min. */
const MALFORMED_DURATION_PATTERN = /^\d+[a-z]+$/iu

/** Control words are recognised only as the complete argument. */
export const CONTROL_WORDS = Object.freeze(['status', 'stop', 'pause', 'resume'])

/** Human-facing grammar statement, shared by the command result and the README. */
export const USAGE =
  'Usage: /loop [<interval>] [<prompt>] | /loop status | /loop stop | /loop pause | /loop resume'

/** Parse a positive safe duration in milliseconds, or return undefined. */
export function parseDuration(text) {
  const match = DURATION_PATTERN.exec(String(text).trim())
  if (match === null) return undefined
  const value = Number(match[1])
  const unit = /** @type {'s' | 'm' | 'h'} */ (match[2].toLowerCase())
  const ms = value * DURATION_UNITS[unit]
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined
}

/** Detect digit-plus-letter tokens with an invalid duration value or unit. */
export function looksLikeMalformedDuration(text) {
  const token = String(text).trim()
  return MALFORMED_DURATION_PATTERN.test(token) && parseDuration(token) === undefined
}

/** Format a non-negative span, rounding seconds before splitting into units. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const totalSeconds = Math.round(ms / 1_000)
  if (totalSeconds <= 0) return '0s'
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0) parts.push(`${seconds}s`)
  return parts.join(' ')
}

/** Parse controls, fixed intervals or adaptive prompts. Options override interval bounds. */
export function parseLoopInput(rawInput, options = {}) {
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS
  const maxIntervalMs = options.maxIntervalMs ?? Number.MAX_SAFE_INTEGER
  const input = String(rawInput ?? '').trim()
  if (input.length === 0) return { kind: 'start', intervalMs: null, prompt: null }

  const control = input.toLowerCase()
  if (CONTROL_WORDS.includes(control)) return { kind: 'control', action: control }

  const separator = input.search(/\s/u)
  const token = separator === -1 ? input : input.slice(0, separator)
  const rest = separator === -1 ? '' : input.slice(separator).trim()

  const intervalMs = parseDuration(token)
  if (intervalMs !== undefined) {
    if (intervalMs < minIntervalMs) {
      return {
        kind: 'error',
        message: `The interval ${token} is below the ${formatDuration(minIntervalMs)} minimum; a tighter loop would spend turns faster than it can do useful work.`,
      }
    }
    if (intervalMs > maxIntervalMs) {
      return {
        kind: 'error',
        message: `The interval ${token} exceeds the ${formatDuration(maxIntervalMs)} maximum.`,
      }
    }
    return { kind: 'start', intervalMs, prompt: rest.length === 0 ? null : rest }
  }

  if (looksLikeMalformedDuration(token)) {
    return {
      kind: 'error',
      message: `"${token}" is not a valid interval. Use <n>s, <n>m or <n>h (for example 30s, 5m, 1h).`,
    }
  }

  return { kind: 'start', intervalMs: null, prompt: input }
}
