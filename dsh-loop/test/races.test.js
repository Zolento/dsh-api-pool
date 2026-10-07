/**
 * Race conditions and lifecycle fences.
 *
 * Every case here is deterministic: the manual clock lets a test fire a timer
 * callback *after* the arm that owned it was invalidated, which is the exact
 * situation `clearTimeout` alone cannot protect against.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LoopService } from '../src/service.js'
import { createAgentDouble, createCtxDouble, createManualClock } from './helpers/doubles.js'

const INTERVAL = 300_000
const PROMPT = 'check the experiment'

/** Loop driver wired to a manual clock and a controllable Agent double. */
function setup(options = {}) {
  const clock = createManualClock()
  const double = createAgentDouble({ id: options.id ?? 'race-session' })
  const { ctx, warnings } = createCtxDouble([double.agent])
  const tools = { attached: 0, disposed: 0 }
  const service = new LoopService({
    ctx,
    minIntervalMs: 30_000,
    defaultPrompt: 'default',
    now: clock.now,
    timer: clock.timer,
    toolsAvailable: () => true,
    attachTools: () => {
      tools.attached += 1
      return () => {
        tools.disposed += 1
      }
    },
  })
  return { clock, double, agent: double.agent, service, tools, warnings }
}

describe('stale timers', () => {
  it('ignores a callback that fires after a pause', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    double.setIdle()
    service.onIdle(agent)

    const stale = clock.captureNext()
    service.pause(agent)
    stale()
    assert.equal(double.followups.length, 1, 'a pause invalidates the armed tick')
    assert.equal(clock.pending(), 0)
  })

  it('ignores a callback that fires after a resume re-armed the loop', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    double.setIdle()
    service.onIdle(agent)

    const stale = clock.captureNext()
    service.pause(agent)
    service.resume(agent)
    const afterResume = double.followups.length
    stale()
    assert.equal(double.followups.length, afterResume, 'the pre-pause callback must not add an iteration')
  })

  it('ignores a callback that fires after the loop stopped', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    double.setIdle()
    service.onIdle(agent)
    const stale = clock.captureNext()
    service.stop(agent, 'user')
    stale()
    assert.equal(double.followups.length, 1)
    assert.equal(service.get(agent), undefined)
  })
})

describe('due tick versus turn end', () => {
  it('starts exactly one iteration when the due tick and the turn end coincide', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    double.setBusy()

    // The tick is due but not yet delivered when the turn ends.
    const stale = clock.captureNext()
    clock.advance(INTERVAL)
    stale()
    assert.equal(double.followups.length, 1, 'a due tick while busy enqueues nothing')

    // Turn end and the due tick resolve in the same instant.
    double.setIdle()
    service.onIdle(agent)
    assert.equal(double.followups.length, 2, 'the coalesced tick starts one iteration')

    // Any callback left over from the previous arm must not start a second one.
    service.onIdle(agent)
    assert.equal(double.followups.length, 2, 'a repeated idle signal never double-enqueues')
  })

  it('drops a due tick when the loop is stopped before the Agent becomes idle', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    double.setBusy()
    clock.advance(INTERVAL)

    service.stop(agent, 'user')
    double.setIdle()
    service.onIdle(agent)
    assert.equal(double.followups.length, 1, 'a stopped loop ignores its outstanding due tick')
  })
})

describe('stop and pause while an iteration is in flight', () => {
  it('lets the running iteration finish without enqueueing anything after it', () => {
    const { clock, double, agent, service, tools } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)

    const view = service.stop(agent, 'user')
    assert.equal(view.running, true, 'the running iteration is reported, not cancelled')
    assert.equal(tools.disposed, 0, 'the tools stay until the turn ends so the model is not cut off mid-turn')

    double.setIdle()
    service.onIdle(agent)
    assert.equal(double.followups.length, 1)
    assert.equal(tools.disposed, 1, 'iteration teardown releases the tools')
    assert.equal(service.get(agent), undefined)
    assert.equal(clock.pending(), 0)
  })

  it('keeps a paused loop resumable after its iteration ends', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    service.pause(agent)

    double.setIdle()
    service.onIdle(agent)
    assert.equal(service.view(service.get(agent)).phase, 'paused')
    assert.equal(clock.pending(), 0)
    service.resume(agent)
    assert.equal(double.followups.length, 2)
  })
})

describe('adaptive scheduling races', () => {
  it('lets a stop in the same iteration win over an earlier schedule', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    service.scheduleNext(agent, { at: clock.now() + 60_000, delayMs: 60_000 })
    service.stop(agent, 'model: done')

    double.setIdle()
    service.onIdle(agent)
    clock.advance(60 * 60_000)
    assert.equal(double.followups.length, 1)
    assert.equal(service.get(agent), undefined)
  })

  it('does not carry a schedule from one iteration into the next', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    service.scheduleNext(agent, { at: clock.now() + 60_000, delayMs: 60_000 })
    double.setIdle()
    service.onIdle(agent)

    clock.advance(60_000)
    assert.equal(double.followups.length, 2)
    assert.equal(service.view(service.get(agent)).scheduledByModel, false, 'the second iteration starts unscheduled')

    // Iteration two schedules nothing: the loop pauses rather than reusing the
    // previous iteration's choice.
    service.onClaimed(agent, double.followups[1].id, 2)
    service.onUserMessage(agent, double.followups[1].id)
    double.setIdle()
    service.onIdle(agent)
    assert.equal(service.view(service.get(agent)).pauseReason, 'awaiting-schedule')
  })

  it('rejects a schedule that arrives after the iteration turn closed', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    double.setIdle()
    service.onIdle(agent)
    assert.throws(
      () => service.scheduleNext(agent, { at: clock.now() + 1_000, delayMs: 1_000 }),
      /only valid inside a loop iteration/u,
    )
  })

  it('never queues a second iteration from repeated idle signals', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    service.scheduleNext(agent, { at: clock.now(), delayMs: 0 })
    service.onIdle(agent)
    service.onIdle(agent)
    service.onIdle(agent)
    assert.equal(double.followups.length, 2)
  })
})

describe('teardown during an in-flight iteration', () => {
  it('dispose leaves no timer and no follow-up', () => {
    const { clock, double, agent, service, tools } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)

    service.dispose()
    assert.equal(clock.pending(), 0)
    assert.equal(tools.disposed, 1)
    double.setIdle()
    service.onIdle(agent)
    clock.advance(60 * 60_000)
    assert.equal(double.followups.length, 1)
  })

  it('discard during an in-flight iteration stops the loop for good', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    service.discard(agent)
    double.setIdle()
    service.onIdle(agent)
    clock.advance(INTERVAL)
    assert.equal(double.followups.length, 1)
  })
})
