/**
 * Failover/event logging: a machine-readable JSONL stream plus a human line,
 * mirroring `api_pool.py::_log_event`. File writes are best-effort; a logging
 * failure must never fail a request.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** One line of human-readable text in the same shape as the Python logger. */
function humanLine(record) {
  const stamp = record.ts
  const fields = []
  const order = [
    'endpoint', 'kind', 'http_status', 'limit_type', 'remaining', 'cooldown_seconds',
    'disabled_reason', 'wait_seconds', 'attempt', 'spend', 'max_budget',
  ]
  for (const key of order) {
    if (record[key] === undefined || record[key] === null) continue
    fields.push(`${key.replaceAll('_', '-')}=${record[key]}`)
  }
  const message = record.message === undefined ? '' : ` msg='${String(record.message).replaceAll('\n', ' ')}'`
  return `${stamp} [${String(record.event).toUpperCase()}] ${fields.join(' ')}${message}`
}

/** Owns the two log sinks for one pool instance. */
export class EventLog {
  /**
   * @param {object} options
   * @param {string|undefined} options.logFile human-readable log path.
   * @param {string|undefined} options.eventsFile JSONL events path.
   * @param {object|undefined} options.logger host logger (`{info,warn,error}`).
   * @param {boolean} options.logSuccesses whether to record successful calls.
   */
  constructor({ logFile, eventsFile, logger, logSuccesses = false } = {}) {
    this.logFile = logFile
    this.eventsFile = eventsFile
    this.logger = logger
    this.logSuccesses = logSuccesses
  }

  /** Record one event across every configured sink. */
  emit(event, fields = {}) {
    if (event === 'success' && !this.logSuccesses) return
    const record = {
      ts: new Date().toISOString(),
      epoch: Math.round(Date.now() / 1000),
      pid: process.pid,
      event,
      ...fields,
    }
    try {
      if (this.eventsFile !== undefined) {
        mkdirSync(dirname(this.eventsFile), { recursive: true })
        appendFileSync(this.eventsFile, `${JSON.stringify(record)}\n`)
      }
    } catch { /* logging cannot fail the request */ }
    try {
      if (this.logFile !== undefined) {
        mkdirSync(dirname(this.logFile), { recursive: true })
        appendFileSync(this.logFile, `${humanLine(record)}\n`)
      }
    } catch { /* logging cannot fail the request */ }
    const line = humanLine(record)
    if (this.logger !== undefined) {
      const level = ['failover', 'all_endpoints_busy', 'quota_refresh'].includes(event) ? 'warn' : 'info'
      try {
        this.logger[level]?.(`api-pool: ${line}`)
      } catch { /* logging cannot fail the request */ }
    }
  }
}

/** A no-op sink for tests and disabled logging. */
export const nullEventLog = { emit() {} }
