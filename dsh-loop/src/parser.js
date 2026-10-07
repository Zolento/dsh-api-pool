/**
 * The strict `/loop` grammar: durations and the command's own arguments.
 *
 * Every duration in this plugin -- `/loop 5m <prompt>`, `schedule_next_loop({
 * delay: '5m' })`, config -- goes through {@link parseDuration}. It accepts
 * exactly `<digits><s|m|h>` and nothing else: no natural-language parsing, no
 * compound expressions, no bare numbers. That keeps an unrecognized token a
 * prompt rather than a silently reinterpreted interval.
 *
 * @module dsh-loop/parser
 */

/** Units the loop grammar accepts, in milliseconds. */
export const DURATION_UNITS = Object.freeze({ s: 1_000, m: 60_000, h: 3_600_000 })

/**
 * Smallest interval a loop may be armed with. A tight interval is a foot-gun:
 * it burns model turns faster than a human can react, so the floor is enforced
 * here and mirrored by the command, the config and the adaptive tool.
 */
export const MIN_INTERVAL_MS = 30_000

/** `30s`, `5m`, `1h` -- nothing else. */
const DURATION_PATTERN = /^(\d+)([smh])$/iu

/**
 * A token that is trying to be a duration but is malformed: digits followed by
 * letters (`5x`, `5min`, `30sec`). Reported instead of being folded into the
 * prompt, because the human clearly meant an interval.
 */
const MALFORMED_DURATION_PATTERN = /^\d+[a-z]+$/iu

/** Control words are recognised only as the complete argument. */
export const CONTROL_WORDS = Object.freeze(['status', 'stop', 'pause', 'resume'])

/** Human-facing grammar statement, shared by the command result and the README. */
export const USAGE =
  'Usage: /loop [<interval>] [<prompt>] | /loop status | /loop stop | /loop pause | /loop resume'

/**
 * Parse one strict duration token.
 * @param text - candidate token, e.g. `5m`.
 * @returns the duration in milliseconds, or `undefined` when it is not a duration.
 */
export function parseDuration(text) {
  const match = DURATION_PATTERN.exec(String(text).trim())
  if (match === null) return undefined
  const value = Number(match[1])
  const unit = /** @type {'s' | 'm' | 'h'} */ (match[2].toLowerCase())
  const ms = value * DURATION_UNITS[unit]
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined
}

/**
 * Whether a token looks like an attempted duration with a bad unit.
 * @param text - candidate token.
 * @returns true when the token is `<digits><letters>` but not a valid duration.
 */
export function looksLikeMalformedDuration(text) {
  const token = String(text).trim()
  return DURATION_PATTERN.test(token) === false && MALFORMED_DURATION_PATTERN.test(token)
}

/**
 * Render a non-negative millisecond span as a compact duration (`5m`, `1m 30s`).
 * Seconds are rounded first so the parts always carry: 3_599_995ms is `1h`, not
 * `59m 60s`.
 * @param ms - span in milliseconds.
 * @returns the compact label.
 */
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

/**
 * Parse the complete argument text of a `/loop` invocation.
 *
 * Grammar:
 * - empty input starts a loop whose prompt comes from `.dsh/loop.md` or the default;
 * - a complete control word (`status`/`stop`/`pause`/`resume`) is a control command;
 * - a leading strict duration arms a fixed loop;
 * - a leading malformed duration is an error, never a prompt;
 * - anything else is the prompt of an adaptive loop.
 *
 * @param rawInput - text after the command name, verbatim.
 * @param options - `minIntervalMs` overrides the floor; `maxIntervalMs` bounds the top.
 * @returns a discriminated parse result.
 */
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
