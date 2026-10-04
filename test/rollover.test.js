import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RolloverLog, emptyRolloverLog } from '../src/pool/rollover.js'

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-api-pool-rollover-')), 'rollovers.json')
}

test('a day is banked once, then the record refuses to bank it again', () => {
  const file = tempFile()
  const log = new RolloverLog(file)

  assert.equal(log.has('2026-10-04'), false)
  assert.deepEqual(log.totals(), { spendUsd: 0, days: 0 })

  assert.equal(log.record('2026-10-04', 12.3456789, { a: 12.34 }, 1000), true)
  assert.equal(log.record('2026-10-04', 99, {}, 2000), false, 'the same date must not be banked twice')

  assert.equal(log.has('2026-10-04'), true)
  assert.deepEqual(log.dates(), ['2026-10-04'])
  assert.deepEqual(log.totals(), { spendUsd: 12.345679, days: 1 })
})

test('the record survives a process restart', () => {
  const file = tempFile()
  new RolloverLog(file).record('2026-10-04', 7.5, { a: 7.5 }, 1000)

  const reopened = new RolloverLog(file)
  assert.equal(reopened.has('2026-10-04'), true)
  assert.deepEqual(reopened.totals(), { spendUsd: 7.5, days: 1 })
  assert.equal(reopened.record('2026-10-04', 1, {}, 2000), false, 'a second process cannot double-book')
  assert.deepEqual(reopened.totals(), { spendUsd: 7.5, days: 1 })

  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.days['2026-10-04'].usd, 7.5)
  assert.equal(onDisk.days['2026-10-04'].rolledAt, new Date(1000).toISOString())
})

test('days accumulate across the record', () => {
  const file = tempFile()
  const log = new RolloverLog(file)
  log.record('2026-10-04', 10, {}, 1)
  log.record('2026-10-05', 2.5, {}, 2)
  assert.deepEqual(log.dates(), ['2026-10-04', '2026-10-05'])
  assert.deepEqual(log.totals(), { spendUsd: 12.5, days: 2 })
})

test('a corrupt, empty, or malformed file degrades to nothing banked', () => {
  const file = tempFile()
  writeFileSync(file, 'not json at all')
  assert.deepEqual(new RolloverLog(file).totals(), { spendUsd: 0, days: 0 })

  writeFileSync(file, JSON.stringify({ version: 1, days: 'wrong shape' }))
  assert.deepEqual(new RolloverLog(file).totals(), { spendUsd: 0, days: 0 })

  assert.deepEqual(emptyRolloverLog().days, {})
})

test('a missing or non-positive amount is banked as 0 rather than corrupting the total', () => {
  const file = tempFile()
  const log = new RolloverLog(file)
  assert.equal(log.record('2026-10-04', Number.NaN, {}, 1), true)
  assert.equal(log.record('2026-10-05', -5, {}, 2), true)
  assert.equal(log.record('2026-10-06', 3, {}, 3), true)
  assert.deepEqual(log.totals(), { spendUsd: 3, days: 3 })
  assert.equal(log.record('', 1, {}, 4), false, 'an empty date is refused')
})
