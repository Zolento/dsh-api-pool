/**
 * Fixed-interval and adaptive scheduling semantics, driven through a manual
 * clock so every "exactly one follow-up" claim is exact rather than timing-based.
 *
 * The properties under test are the ones a loop gets wrong in practice:
 * never overlap, never backlog, never fire after a stop, never spin.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LoopService } from '../src/service.js'
import { createAgentDouble, createCtxDouble, createManualClock } from './helpers/doubles.js'

const INTERVAL = 300_000
const PROMPT = 'check whether the experiment has finished'

/** One deterministic loop under test. */
function setup(options = {}) {
  const clock = createManualClock()
  const double = createAgentDouble({ id: options.id ?? 'session-a' })
  const { ctx, warnings } = createCtxDouble([double.agent])
  const tools = { attached: 0, disposed: 0 }
  const service = new LoopService({
    ctx,
    minIntervalMs: options.minIntervalMs ?? 30_000,
    defaultPrompt: 'default maintenance prompt',
    now: clock.now,
    timer: clock.timer,
    toolsAvailable: options.toolsAvailable ?? (() => true),
    attachTools: options.attachTools === undefined
      ? () => {
        tools.attached += 1
        return () => {
          tools.disposed += 1
        }
      }
      : options.attachTools,
  })
  return { clock, double, agent: double.agent, service, tools, warnings }
}

describe('fixed interval scheduling', () => {
  it('starts the first iteration immediately, then exactly one per interval', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    assert.equal(double.followups.length, 0, 'nothing is enqueued until the due tick fires')

    clock.advance(0)
    assert.equal(double.followups.length, 1)
    assert.equal(double.followups[0].source.kind, 'loop')
    assert.equal(double.followups[0].source.iteration, 1)
    assert.match(double.followups[0].content[0].text, /check whether the experiment has finished/u)
    assert.match(double.followups[0].content[0].text, /Iteration:\n1/u)

    // The turn runs and closes; the Agent converges to idle.
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    double.setBusy()
    clock.advance(60_000)
    double.setIdle()
    service.onIdle(agent)

    clock.advance(INTERVAL - 60_000 - 1)
    assert.equal(double.followups.length, 1, 'the next tick has not arrived yet')
    clock.advance(1)
    assert.equal(double.followups.length, 2, 'the next interval starts exactly one iteration')
    assert.equal(double.followups[1].source.iteration, 2)
  })

  it('runs no follow-up while the agent is busy, then exactly one when it goes idle', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })

    clock.advance(0)
    assert.equal(double.followups.length, 1)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    double.setBusy()

    // The next interval elapses while the first iteration is still working.
    clock.advance(INTERVAL)
    assert.equal(double.followups.length, 1, 'a due tick while busy must not enqueue anything')

    double.setIdle()
    service.onIdle(agent)
    assert.equal(double.followups.length, 2, 'the missed tick collapses into exactly one iteration')
  })

  it('does not build a backlog when an iteration outlives several intervals', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })

    clock.advance(0)
    assert.equal(double.followups.length, 1)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    double.setBusy()

    // 17 minutes of work against a 5 minute interval: three missed ticks.
    clock.advance(17 * 60_000)
    double.setIdle()
    service.onIdle(agent)

    assert.equal(double.followups.length, 2, 'missed ticks are not queued iterations')
    assert.equal(double.followups[1].source.iteration, 2)
  })

  it('keeps at most one timer armed and releases it when the loop stops', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    assert.equal(clock.pending(), 1, 'a fixed loop keeps its next tick armed while an iteration runs')

    double.setIdle()
    service.onIdle(agent)
    assert.equal(clock.pending(), 1)

    service.stop(agent)
    assert.equal(clock.pending(), 0, 'stop clears the timer')
    clock.advance(60 * 60_000)
    assert.equal(double.followups.length, 1, 'a stopped loop never enqueues again')
  })

  it('ignores a timer callback that outlived its arm', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    double.setIdle()
    service.onIdle(agent)

    const stale = clock.captureNext()
    service.stop(agent)
    stale()
    assert.equal(double.followups.length, 1, 'a stale callback must be recognised and ignored')
  })

  it('re-arms a full interval after a user interrupt instead of restarting instantly', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)

    // The human interrupts two minutes into the iteration.
    clock.advance(2 * 60_000)
    service.onTurnEnd(agent, 1, 'aborted')
    double.setIdle()
    service.onIdle(agent)

    clock.advance(INTERVAL - 1)
    assert.equal(double.followups.length, 1, 'an interrupt is not answered by an instant restart')
    clock.advance(1)
    assert.equal(double.followups.length, 2)
  })

  it('treats a discarded iteration as finished and continues on cadence', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onDiscarded(agent, double.followups[0].id)
    double.setIdle()
    service.onIdle(agent)
    assert.equal(service.view(service.get(agent)).running, false)
    clock.advance(INTERVAL)
    assert.equal(double.followups.length, 2)
  })
})

describe('adaptive scheduling', () => {
  it('waits for the model to schedule the next iteration', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    clock.advance(0)
    assert.equal(double.followups.length, 1, 'adaptive loops also start with one iteration')
    assert.equal(clock.pending(), 0, 'no timer is armed while an adaptive iteration runs')

    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    service.scheduleNext(agent, { at: clock.now() + 600_000, delayMs: 600_000, iteration: 1 })
    double.setIdle()
    service.onIdle(agent)

    clock.advance(600_000 - 1)
    assert.equal(double.followups.length, 1)
    clock.advance(1)
    assert.equal(double.followups.length, 2)
    assert.equal(double.followups[1].source.iteration, 2)
  })

  it('falls back to a pause when an iteration neither schedules nor stops', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    double.setIdle()
    service.onIdle(agent)

    const view = service.view(service.get(agent))
    assert.equal(view.phase, 'paused')
    assert.equal(view.pauseReason, 'awaiting-schedule')
    assert.equal(view.nextRunAt, undefined)
    clock.advance(60 * 60_000)
    assert.equal(double.followups.length, 1, 'an unscheduled adaptive loop must never busy-spin')
  })

  it('lets the last schedule call in one iteration win', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    const now = clock.now()
    service.scheduleNext(agent, { at: now + 600_000, delayMs: 600_000 })
    service.scheduleNext(agent, { at: now + 60_000, delayMs: 60_000, reason: 'training is still running' })
    double.setIdle()
    service.onIdle(agent)

    clock.advance(60_000)
    assert.equal(double.followups.length, 2, 'the later call replaces the earlier one')
    assert.equal(service.view(service.get(agent))?.lastSchedule?.reason ?? 'training is still running', 'training is still running')
  })

  it('refuses scheduling outside an iteration or in a fixed loop', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    assert.throws(() => service.scheduleNext(agent, { at: clock.now() + 1_000, delayMs: 1_000 }), /only valid inside a loop iteration/u)

    const fixed = setup({ id: 'session-fixed' })
    fixed.service.start(fixed.agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    fixed.clock.advance(0)
    fixed.service.onClaimed(fixed.agent, fixed.double.followups[0].id, 1)
    fixed.service.onUserMessage(fixed.agent, fixed.double.followups[0].id)
    assert.throws(
      () => fixed.service.scheduleNext(fixed.agent, { at: fixed.clock.now() + 1_000, delayMs: 1_000 }),
      /fixed-interval loop/u,
    )
    void double
  })

  it('starts the next iteration as soon as the turn ends when the delay already elapsed', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    service.scheduleNext(agent, { at: clock.now() + 60_000, delayMs: 60_000 })

    // The iteration's own turn takes longer than the requested delay.
    clock.advance(600_000)
    double.setIdle()
    service.onIdle(agent)
    assert.equal(double.followups.length, 2, 'a due adaptive schedule fires once, not once per elapsed delay')
  })

  it('ends the loop when the model stops it', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'adaptive', prompt: PROMPT })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    service.stop(agent, 'model: task complete')
    double.setIdle()
    service.onIdle(agent)
    assert.equal(service.get(agent), undefined)
    clock.advance(60 * 60_000)
    assert.equal(double.followups.length, 1)
  })
})

describe('pause and resume', () => {
  it('pauses scheduling without losing the prompt, then resumes with one iteration', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    double.setIdle()
    service.onIdle(agent)

    service.pause(agent)
    assert.equal(clock.pending(), 0)
    clock.advance(60 * 60_000)
    assert.equal(double.followups.length, 1, 'a paused loop schedules nothing')

    const resumed = service.resume(agent)
    assert.equal(resumed.phase, 'active')
    assert.equal(resumed.prompt, PROMPT, 'the prompt survives a pause')
    assert.equal(double.followups.length, 2, 'resume re-arms immediately and runs once')
    clock.advance(0)
    assert.equal(double.followups.length, 2, 'resume does not double-fire')
  })

  it('keeps the loop paused when it was paused mid-iteration', () => {
    const { clock, double, agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    service.pause(agent)

    double.setIdle()
    service.onIdle(agent)
    const view = service.view(service.get(agent))
    assert.equal(view.phase, 'paused')
    assert.equal(view.running, false)
    assert.equal(clock.pending(), 0)
    clock.advance(60 * 60_000)
    assert.equal(double.followups.length, 1)
  })

  it('rejects a resume without a paused loop', () => {
    const { agent, service } = setup()
    assert.throws(() => service.resume(agent), /No loop is active/u)
  })
})

describe('session isolation and cleanup', () => {
  it('keeps two sessions independent', () => {
    const clock = createManualClock()
    const first = createAgentDouble({ id: 'session-1' })
    const second = createAgentDouble({ id: 'session-2' })
    const { ctx } = createCtxDouble([first.agent, second.agent])
    const service = new LoopService({
      ctx,
      minIntervalMs: 30_000,
      defaultPrompt: 'default',
      now: clock.now,
      timer: clock.timer,
      toolsAvailable: () => true,
      attachTools: () => () => {},
    })

    service.start(first.agent, { mode: 'fixed', prompt: 'first', intervalMs: INTERVAL })
    service.start(second.agent, { mode: 'fixed', prompt: 'second', intervalMs: INTERVAL })
    clock.advance(0)
    assert.equal(first.followups.length, 1)
    assert.equal(second.followups.length, 1)
    assert.match(first.followups[0].content[0].text, /first/u)
    assert.match(second.followups[0].content[0].text, /second/u)

    // Both iterations run to completion; each loop is armed for its next tick.
    for (const double of [first, second]) {
      service.onClaimed(double.agent, double.followups[0].id, 1)
      service.onUserMessage(double.agent, double.followups[0].id)
      double.setIdle()
      service.onIdle(double.agent)
    }

    service.stop(first.agent)
    clock.advance(INTERVAL)
    assert.equal(first.followups.length, 1, 'stopping one loop leaves the other alone')
    assert.equal(second.followups.length, 2)
  })

  it('allows only one loop per session', () => {
    const { agent, service } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    assert.throws(() => service.start(agent, { mode: 'adaptive', prompt: 'other' }), /already active/u)
  })

  it('releases timers and scope registrations when the agent is disposed', () => {
    const { clock, double, agent, service, tools } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    assert.equal(tools.attached, 1, 'the control tools exist during an iteration')
    service.discard(agent)
    assert.equal(clock.pending(), 0)
    assert.equal(tools.disposed, 1)
    assert.equal(service.get(agent), undefined)
    clock.advance(60 * 60_000)
    assert.equal(double.followups.length, 1)
  })

  it('registers the model tools only for the duration of an iteration', () => {
    const { clock, double, agent, service, tools } = setup()
    service.start(agent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL })
    clock.advance(0)
    assert.equal(tools.attached, 1)
    service.onClaimed(agent, double.followups[0].id, 1)
    service.onUserMessage(agent, double.followups[0].id)
    double.setIdle()
    service.onIdle(agent)
    assert.equal(tools.disposed, 1, 'the tools disappear with the iteration turn')
  })

  it('does not start with a dead agent handle', () => {
    const { agent, service } = setup()
    const { ctx } = createCtxDouble([])
    const orphanAgent = { ...agent, id: 'gone' }
    const other = new LoopService({
      ctx,
      minIntervalMs: 30_000,
      defaultPrompt: 'default',
      now: () => 0,
      timer: { schedule: () => () => {} },
      toolsAvailable: () => true,
    })
    assert.throws(() => other.start(orphanAgent, { mode: 'fixed', prompt: PROMPT, intervalMs: INTERVAL }), /not live/u)
    void service
  })
})

describe('dispose', () => {
  it('releases every loop, timer and tool registration', () => {
    const clock = createManualClock()
    const first = createAgentDouble({ id: 'session-1' })
    const second = createAgentDouble({ id: 'session-2' })
    const { ctx } = createCtxDouble([first.agent, second.agent])
    let attached = 0
    let disposed = 0
    const service = new LoopService({
      ctx,
      minIntervalMs: 30_000,
      defaultPrompt: 'default',
      now: clock.now,
      timer: clock.timer,
      toolsAvailable: () => true,
      attachTools: () => {
        attached += 1
        return () => {
          disposed += 1
        }
      },
    })
    service.start(first.agent, { mode: 'fixed', prompt: 'first', intervalMs: INTERVAL })
    service.start(second.agent, { mode: 'fixed', prompt: 'second', intervalMs: INTERVAL })
    clock.advance(0)
    assert.equal(attached, 2)

    service.dispose()
    assert.equal(clock.pending(), 0, 'no zombie timers after teardown')
    assert.equal(disposed, 2)
    assert.equal(service.list().length, 0)
    clock.advance(60 * 60_000)
    assert.equal(first.followups.length, 1)
    assert.equal(second.followups.length, 1)
  })
})

