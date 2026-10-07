/**
 * `/loop` grammar: strict, small, and impossible to mistake a control word or a
 * malformed interval for a prompt.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MIN_INTERVAL_MS,
  formatDuration,
  looksLikeMalformedDuration,
  parseDuration,
  parseLoopInput,
} from '../src/parser.js'

describe('parseDuration', () => {
  it('accepts exactly <digits><s|m|h>', () => {
    assert.equal(parseDuration('30s'), 30_000)
    assert.equal(parseDuration('5m'), 300_000)
    assert.equal(parseDuration('1h'), 3_600_000)
    assert.equal(parseDuration('2h'), 7_200_000)
  })

  it('is case-insensitive about the unit and trims whitespace', () => {
    assert.equal(parseDuration(' 5M '), 300_000)
  })

  it('rejects everything else', () => {
    for (const input of ['5', 'm', '5x', '5min', '30sec', '1.5h', '5m30s', '', 'five minutes', '0s', '-5m']) {
      assert.equal(parseDuration(input), undefined, `expected ${JSON.stringify(input)} to be rejected`)
    }
  })
})

describe('formatDuration', () => {
  it('renders compact human durations', () => {
    assert.equal(formatDuration(30_000), '30s')
    assert.equal(formatDuration(300_000), '5m')
    assert.equal(formatDuration(3_600_000), '1h')
    assert.equal(formatDuration(90_000), '1m 30s')
    assert.equal(formatDuration(3_661_000), '1h 1m 1s')
    assert.equal(formatDuration(0), '0s')
  })
})

describe('parseLoopInput', () => {
  it('parses a fixed loop', () => {
    assert.deepEqual(parseLoopInput(' 5m check whether the experiment has finished '), {
      kind: 'start',
      intervalMs: 300_000,
      prompt: 'check whether the experiment has finished',
    })
    assert.deepEqual(parseLoopInput('30s hello'), { kind: 'start', intervalMs: 30_000, prompt: 'hello' })
    assert.deepEqual(parseLoopInput('1h hello'), { kind: 'start', intervalMs: 3_600_000, prompt: 'hello' })
  })

  it('parses an adaptive loop when there is no interval', () => {
    assert.deepEqual(parseLoopInput('inspect the experiment and continue making useful progress'), {
      kind: 'start',
      intervalMs: null,
      prompt: 'inspect the experiment and continue making useful progress',
    })
  })

  it('parses a bare /loop as "use the workspace or default prompt"', () => {
    assert.deepEqual(parseLoopInput(''), { kind: 'start', intervalMs: null, prompt: null })
    assert.deepEqual(parseLoopInput('   '), { kind: 'start', intervalMs: null, prompt: null })
  })

  it('parses an interval with no prompt', () => {
    assert.deepEqual(parseLoopInput('5m'), { kind: 'start', intervalMs: 300_000, prompt: null })
  })

  it('recognises control words only as the complete argument', () => {
    for (const word of ['status', 'stop', 'pause', 'resume']) {
      assert.deepEqual(parseLoopInput(word), { kind: 'control', action: word })
      assert.deepEqual(parseLoopInput(`  ${word.toUpperCase()}  `), { kind: 'control', action: word })
    }
  })

  it('does not mistake a prompt beginning with a control word for a control command', () => {
    assert.deepEqual(parseLoopInput('stop the server if unhealthy'), {
      kind: 'start',
      intervalMs: null,
      prompt: 'stop the server if unhealthy',
    })
    assert.deepEqual(parseLoopInput('status report for the nightly job'), {
      kind: 'start',
      intervalMs: null,
      prompt: 'status report for the nightly job',
    })
    // A trailing word is enough to make it a prompt.
    assert.equal(parseLoopInput('stop now').kind, 'start')
  })

  it('rejects a malformed interval instead of treating it as a prompt', () => {
    for (const token of ['5x', '5min', '30sec', '1hour', '10minutes']) {
      const parsed = parseLoopInput(`${token} do the thing`)
      assert.equal(parsed.kind, 'error', `expected ${token} to be rejected`)
      assert.match(parsed.message, /not a valid interval/u)
    }
  })

  it('enforces the interval floor', () => {
    const parsed = parseLoopInput('10s hello')
    assert.equal(parsed.kind, 'error')
    assert.match(parsed.message, /below the 30s minimum/u)
    assert.deepEqual(parseLoopInput('30s hello'), { kind: 'start', intervalMs: 30_000, prompt: 'hello' })
  })

  it('honours a configured floor and ceiling', () => {
    assert.equal(parseLoopInput('5s x', { minIntervalMs: 5_000 }).kind, 'start')
    assert.equal(parseLoopInput('2h x', { maxIntervalMs: 3_600_000 }).kind, 'error')
  })

  it('keeps the whole remaining line as the prompt, including newlines', () => {
    const parsed = parseLoopInput('5m check the job\nand report back')
    assert.deepEqual(parsed, {
      kind: 'start',
      intervalMs: 300_000,
      prompt: 'check the job\nand report back',
    })
  })

  it('uses the documented default floor', () => {
    assert.equal(MIN_INTERVAL_MS, 30_000)
  })
})

describe('looksLikeMalformedDuration', () => {
  it('flags digit+letter tokens that are not valid durations', () => {
    assert.equal(looksLikeMalformedDuration('5x'), true)
    assert.equal(looksLikeMalformedDuration('5m'), false)
    assert.equal(looksLikeMalformedDuration('2024'), false)
    assert.equal(looksLikeMalformedDuration('check'), false)
  })
})
