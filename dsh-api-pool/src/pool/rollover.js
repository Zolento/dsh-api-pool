/**
 * The durable record of day rollovers.
 *
 * Each local midnight the previous day's maximum spend is "banked": the plugin
 * writes one entry here and resets the live counter. The file is the authority on
 * what has already been banked, which is what makes the operation safely
 * repeatable — a restart, a second harness process, or a re-run of the check
 * cannot book the same day twice.
 *
 * Written with the same best-effort atomic-replace approach as the pool state:
 * a corrupt or missing file degrades to "nothing banked yet" instead of failing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Host of one banked day. */
export function emptyRolloverLog() {
  return { version: 1, updatedAt: 0, days: {} }
}

export class RolloverLog {
  /** @param {string} file path of the JSON record. */
  constructor(file) {
    this.file = file
    this.data = this.#load()
  }

  #load() {
    if (!existsSync(this.file)) return emptyRolloverLog()
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.days !== 'object' || parsed.days === null) {
        return emptyRolloverLog()
      }
      return { ...emptyRolloverLog(), ...parsed }
    } catch {
      return emptyRolloverLog()
    }
  }

  /** Whether one date is already banked. */
  has(date) {
    return this.data.days[date] !== undefined
  }

  /**
   * Bank one day. Idempotent: a date already present is left untouched.
   * @param {string} date local `YYYY-MM-DD`.
   * @param {number} usd that day's total.
   * @param {object} endpoints per-endpoint figures, for diagnostics.
   * @param {number} now epoch milliseconds.
   * @returns {boolean} true when this call created the entry.
   */
  record(date, usd, endpoints, now) {
    if (typeof date !== 'string' || date === '' || this.has(date)) return false
    const amount = Number.isFinite(usd) && usd > 0 ? usd : 0
    this.data.days[date] = {
      usd: Math.round(amount * 1e6) / 1e6,
      endpoints: { ...endpoints },
      rolledAt: new Date(now).toISOString(),
    }
    this.save(now)
    return true
  }

  /** Totals over every banked day. */
  totals() {
    let spendUsd = 0
    let days = 0
    for (const entry of Object.values(this.data.days)) {
      spendUsd += Number.isFinite(entry?.usd) ? entry.usd : 0
      days += 1
    }
    return { spendUsd, days }
  }

  /** Banked dates, oldest first. */
  dates() {
    return Object.keys(this.data.days).sort()
  }

  /** Persist the record; failures are non-fatal. */
  save(now = Date.now()) {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      this.data.updatedAt = now
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.data, undefined, 2)}\n`)
      renameSync(tmp, this.file)
    } catch { /* the record is best-effort */ }
  }
}
