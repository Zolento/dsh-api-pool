/**
 * Composition-level tests: the plugin mounted over the real cordis context and
 * the real services it composes with (timer, sessions, tools, system prompt,
 * commands, agent registry). Only the Agent is scripted.
 *
 * These tests answer the questions a unit test cannot: does `/loop` reach the
 * command registry, does an iteration arrive through `Agent.followup`, do the
 * adaptive tools exist only during an iteration, and does the scoped prompt
 * section render for exactly that turn.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { mountHarness, runCommand } from './helpers/harness.js'

/** Harnesses created by this file, torn down after each test. */
const live = []
afterEach(async () => {
  while (live.length > 0) await live.pop().dispose()
})

/** Mount a harness and remember it for teardown. */
async function harness(options = {}) {
  const mounted = await mountHarness({ config: { minIntervalMs: 10 }, ...options })
  live.push(mounted)
  return mounted
}

/** Poll until a predicate holds; fails loudly instead of hanging. */
async function waitFor(predicate, message, timeout = 3_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Assemble the model-visible prompt and tool catalog for an Agent. */
async function assemble(ctx, agent) {
  return ctx.systemPrompt.assemble({ agent, scope: agent })
}

/** A promise plus its resolver, for holding a scripted turn open. */
function gate() {
  let release
  const opened = new Promise(resolve => {
    release = resolve
  })
  return { opened, release }
}

describe('composition', () => {
  it('registers /loop in the real command registry', async () => {
    const { ctx, addAgent } = await harness()
    const { agent } = await addAgent('composition-1')
    const descriptor = ctx.commands.find(agent, 'loop')
    assert.ok(descriptor !== undefined, '/loop must be visible to the agent')
    assert.equal(descriptor.name, 'loop')
    assert.match(descriptor.description, /Repeat a prompt/u)
  })

  it('reports no loop before one is started', async () => {
    const { ctx, addAgent } = await harness()
    const { agent } = await addAgent('composition-2')
    const result = await runCommand(ctx, agent, '/loop status')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /No loop is active/u)
  })
})

describe('fixed loop end to end', () => {
  it('runs one ordinary follow-up turn per interval through the real command', async () => {
    const { ctx, service, addAgent } = await harness()
    const { agent, followups, turns, session } = await addAgent('fixed-e2e')

    const started = await runCommand(ctx, agent, '/loop 1s check whether the experiment has finished')
    assert.equal(started.kind, 'success')
    assert.match(started.text, /one iteration every 1s/u)

    await waitFor(() => followups.length >= 2, 'two iterations to be enqueued')
    assert.equal(followups[0].source.kind, 'loop')
    assert.match(followups[0].content[0].text, /check whether the experiment has finished/u)
    assert.ok(turns.length >= 2, 'the iterations ran as ordinary turns')
    assert.ok(session.snapshotEvents().some(event => event.type === 'turn/end'), 'turns were recorded durably')

    const view = service.view(service.get(agent))
    assert.equal(view.mode, 'fixed')
    assert.ok(view.iteration >= 2)

    const stopped = await runCommand(ctx, agent, '/loop stop')
    assert.equal(stopped.kind, 'success')
    const atStop = followups.length
    await new Promise(resolve => setTimeout(resolve, 1_200))
    assert.equal(followups.length, atStop, 'a stopped loop schedules nothing further')
  })

  it('never overlaps turns and never queues a backlog', async () => {
    const { service, addAgent } = await harness()
    let concurrent = 0
    let maxConcurrent = 0
    const { agent, followups } = await addAgent('overlap', {
      onTurn: async () => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise(resolve => setTimeout(resolve, 60))
        concurrent -= 1
      },
    })

    service.start(agent, { mode: 'fixed', prompt: 'watch the job', intervalMs: 20 })
    await waitFor(() => followups.length >= 3, 'three iterations')
    assert.equal(maxConcurrent, 1, 'the loop must never run two turns at once')

    // 60ms of work against a 20ms interval: the loop waits, then resumes once.
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(maxConcurrent, 1)
    service.stop(agent, 'test')
  })
})

describe('status, pause, resume', () => {
  it('reports cadence, iteration count and the next run', async () => {
    const { ctx, service, addAgent } = await harness()
    const { agent } = await addAgent('status-1')
    await runCommand(ctx, agent, '/loop 1h inspect CI and decide when to check again')
    await waitFor(() => service.view(service.get(agent))?.iteration >= 1, 'the first iteration to start')

    const status = await runCommand(ctx, agent, '/loop status')
    assert.equal(status.kind, 'success')
    assert.match(status.text, /Status: active \(fixed, every 1h\)/u)
    assert.match(status.text, /Iterations started: 1/u)
    assert.match(status.text, /Prompt: inspect CI and decide when to check again/u)
    assert.match(status.text, /Next iteration: in 1h/u)
    await runCommand(ctx, agent, '/loop stop')
  })

  it('refuses a second loop in the same session', async () => {
    const { ctx, addAgent } = await harness()
    const { agent } = await addAgent('single-loop')
    await runCommand(ctx, agent, '/loop 1h keep going')
    const second = await runCommand(ctx, agent, '/loop 30s something else')
    assert.equal(second.kind, 'error')
    assert.match(second.text, /already active/u)
    await runCommand(ctx, agent, '/loop stop')
  })

  it('pauses, resumes once, and refuses meaningless control calls', async () => {
    const { ctx, service, addAgent } = await harness()
    const { agent, followups } = await addAgent('pause-1')
    await runCommand(ctx, agent, '/loop 1h keep going')
    await waitFor(() => followups.length === 1, 'the first iteration')

    const paused = await runCommand(ctx, agent, '/loop pause')
    assert.equal(paused.kind, 'success')
    assert.equal(service.view(service.get(agent)).phase, 'paused')
    const atPause = followups.length

    const resumed = await runCommand(ctx, agent, '/loop resume')
    assert.equal(resumed.kind, 'success')
    await waitFor(() => followups.length === atPause + 1, 'resume runs exactly one iteration')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(followups.length, atPause + 1, 'resume does not double-fire')

    const stopped = await runCommand(ctx, agent, '/loop stop')
    assert.equal(stopped.kind, 'success')
    const nothing = await runCommand(ctx, agent, '/loop resume')
    assert.equal(nothing.kind, 'error')
    assert.match(nothing.text, /nothing to resume/u)
  })
})

describe('prompt resolution', () => {
  it('uses .dsh/loop.md when the invocation carries no prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-loop-md-'))
    mkdirSync(join(cwd, '.dsh'), { recursive: true })
    writeFileSync(join(cwd, '.dsh', 'loop.md'), '\n  Check the nightly build and report regressions.  \n')
    try {
      const { ctx, addAgent } = await harness()
      const { agent, followups } = await addAgent('md-1', { cwd })
      const result = await runCommand(ctx, agent, '/loop')
      assert.equal(result.kind, 'success')
      assert.match(result.text, /prompt from \.dsh\/loop\.md/u)
      await waitFor(() => followups.length === 1, 'the first iteration')
      assert.match(followups[0].content[0].text, /Check the nightly build and report regressions\./u)
      await runCommand(ctx, agent, '/loop stop')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('falls back to the default maintenance prompt', async () => {
    const { ctx, addAgent } = await harness()
    const { agent, followups } = await addAgent('default-prompt')
    const result = await runCommand(ctx, agent, '/loop')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /default maintenance prompt/u)
    await waitFor(() => followups.length === 1, 'the first iteration')
    assert.match(followups[0].content[0].text, /Continue making useful progress on the current task\./u)
    await runCommand(ctx, agent, '/loop stop')
  })

  it('rejects a malformed interval without starting anything', async () => {
    const { ctx, service, addAgent } = await harness()
    const { agent } = await addAgent('bad-interval')
    const result = await runCommand(ctx, agent, '/loop 5x check the job')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /not a valid interval/u)
    assert.equal(service.get(agent), undefined)
  })

  it('treats a control word inside a prompt as a prompt', async () => {
    const { ctx, service, addAgent } = await harness()
    const { agent } = await addAgent('control-prompt')
    const result = await runCommand(ctx, agent, '/loop stop the server if unhealthy')
    assert.equal(result.kind, 'success')
    const view = service.view(service.get(agent))
    assert.equal(view.mode, 'adaptive')
    assert.equal(view.prompt, 'stop the server if unhealthy')
    await runCommand(ctx, agent, '/loop stop')
  })
})

describe('adaptive loop', () => {
  it('exposes schedule_next_loop and stop_loop only during an iteration', async () => {
    const { ctx, service, addAgent } = await harness()
    const held = gate()
    const { agent, followups } = await addAgent('adaptive-scope', { onTurn: () => held.opened })

    const before = await assemble(ctx, agent)
    assert.equal(before.tools.some(tool => tool.name === 'schedule_next_loop'), false)
    assert.equal(before.tools.some(tool => tool.name === 'stop_loop'), false)

    await runCommand(ctx, agent, '/loop keep making useful progress')
    await waitFor(() => service.view(service.get(agent))?.inIteration === true, 'the iteration turn to open')

    // Inside the iteration's turn the catalog carries the control surface, and
    // the scoped system section states the adaptive contract.
    const during = await assemble(ctx, agent)
    assert.equal(during.tools.some(tool => tool.name === 'schedule_next_loop'), true)
    assert.equal(during.tools.some(tool => tool.name === 'stop_loop'), true)
    const text = renderPrompt(during)
    assert.match(text, /one iteration of an adaptive \/loop/u)

    held.release()
    await waitFor(() => followups.length === 1 && service.get(agent)?.phase === 'paused', 'the fallback pause')
    const after = await assemble(ctx, agent)
    assert.equal(after.tools.some(tool => tool.name === 'schedule_next_loop'), false, 'tools leave with the turn')
    assert.doesNotMatch(renderPrompt(after), /one iteration of an adaptive \/loop/u)
    await runCommand(ctx, agent, '/loop stop')
  })

  it('schedules the next iteration through the real tool runtime', async () => {
    const { ctx, service, addAgent } = await harness()
    const held = gate()
    const { agent, followups } = await addAgent('adaptive-tool', { onTurn: () => held.opened })
    const call = (name, args) => ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`call-${name}`),
      name,
      arguments: args,
      agent,
    }))

    service.start(agent, { mode: 'adaptive', prompt: 'watch the training run' })
    await waitFor(() => service.view(service.get(agent))?.inIteration === true, 'the iteration turn to open')

    const scheduled = await call('schedule_next_loop', { delay: '30s', reason: 'training is still running' })
    assert.equal(scheduled.isError ?? false, false)
    assert.deepEqual(JSON.parse(scheduled.content[0].text), {
      scheduled: true,
      delay: '30s',
      next_iteration: 2,
      next_run_in_ms: 30_000,
      reason: 'training is still running',
    })

    held.release()
    await waitFor(() => service.view(service.get(agent))?.nextRunAt !== undefined, 'the recorded schedule to arm')
    const status = await runCommand(ctx, agent, '/loop status')
    assert.match(status.text, /adaptive/u)
    assert.match(status.text, /Next iteration: in 30s/u)
    assert.match(status.text, /training is still running/u)

    // A second call in the same iteration would replace the first; the loop is
    // stopped here instead so the timer cannot fire during teardown.
    await runCommand(ctx, agent, '/loop stop')
  })

  it('ends the loop through stop_loop without cancelling the turn', async () => {
    const { ctx, service, addAgent } = await harness()
    const held = gate()
    const { agent, followups } = await addAgent('adaptive-stop', { onTurn: () => held.opened })
    const call = (name, args) => ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`call-${name}-stop`),
      name,
      arguments: args,
      agent,
    }))

    service.start(agent, { mode: 'adaptive', prompt: 'watch the training run' })
    await waitFor(() => service.view(service.get(agent))?.inIteration === true, 'the iteration turn to open')

    const stopped = await call('stop_loop', { reason: 'training finished' })
    assert.equal(stopped.isError ?? false, false)
    assert.equal(JSON.parse(stopped.content[0].text).stopped, true)

    // The turn itself is untouched, and the loop is gone once it ends.
    assert.equal(agent.status, 'running')
    held.release()
    await waitFor(() => service.get(agent) === undefined, 'the loop to be released')
    const atStop = followups.length
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(followups.length, atStop)
  })

  it('pauses with "awaiting schedule" when an iteration schedules nothing', async () => {
    const { ctx, service, addAgent } = await harness()
    const { agent, followups } = await addAgent('adaptive-nothing')
    service.start(agent, { mode: 'adaptive', prompt: 'watch the training run' })
    await waitFor(() => followups.length === 1, 'the first iteration')

    // Let the scripted turn finish without calling any loop tool.
    await waitFor(() => service.get(agent)?.phase === 'paused', 'the awaiting-schedule fallback')
    const view = service.view(service.get(agent))
    assert.equal(view.pauseReason, 'awaiting-schedule')

    const status = await runCommand(ctx, agent, '/loop status')
    assert.match(status.text, /paused \(awaiting schedule\)/u)
    await runCommand(ctx, agent, '/loop stop')
  })
})

describe('lifecycle', () => {
  it('drops loop state and timers when the Agent is disposed', async () => {
    const { ctx, service, addAgent } = await harness()
    const { agent, followups } = await addAgent('dispose-agent')
    service.start(agent, { mode: 'fixed', prompt: 'keep going', intervalMs: 1_000 })
    await waitFor(() => followups.length === 1, 'the first iteration')
    const { agentEvents } = await import('@deepseek-ai/dsh-agent')
    agentEvents(ctx, agent).emit('agent/disposed', { agent })
    assert.equal(service.get(agent), undefined)
    const atDispose = followups.length
    await new Promise(resolve => setTimeout(resolve, 1_100))
    assert.equal(followups.length, atDispose)
  })

  it('drops loop state when its Session is disposed', async () => {
    const { ctx, service, addAgent } = await harness()
    const { agent, session, followups } = await addAgent('dispose-session')
    service.start(agent, { mode: 'fixed', prompt: 'keep going', intervalMs: 1_000 })
    await waitFor(() => followups.length === 1, 'the first iteration')
    ctx.emit('session/disposed', session)
    assert.equal(service.get(agent), undefined, 'session disposal releases the loop')
    const atDispose = followups.length
    await new Promise(resolve => setTimeout(resolve, 1_100))
    assert.equal(followups.length, atDispose, 'and its timer')
  })

  it('cannot restart a loop from replayed session history', async () => {
    const { ctx, service, addAgent } = await harness()
    const { agent, session } = await addAgent('replay-safe')
    service.start(agent, { mode: 'fixed', prompt: 'keep going', intervalMs: 1_000 })
    await waitFor(() => service.view(service.get(agent))?.iteration >= 1, 'the first iteration')
    const published = []
    ctx.on('session/event', (subject, event) => {
      if (subject.id === 'replay-restored') published.push(event.type)
    })

    // A restored/forked session carries its history as seed events. DSH never
    // publishes seeds on `session/event`, which is exactly why a replayed
    // `turn/end` cannot restart a loop; this pins that contract for this plugin.
    const seed = session.snapshotEvents().filter(event =>
      event.type === 'turn/start' || event.type === 'user/message' || event.type === 'turn/end')
    const restored = ctx.sessions.create(SessionId('replay-restored'), { seed: [...seed] })
    assert.ok(restored.snapshotEvents().length > 0, 'the seed was adopted')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(published, [], 'seed events are not replayed to listeners')
    assert.equal(ctx.agents.get(restored.id), undefined, 'a restored session has no live Agent, so no live loop')
  })

  it('keeps two sessions independent in one composition', async () => {
    const { service, addAgent } = await harness()
    const first = await addAgent('iso-1')
    const second = await addAgent('iso-2')
    service.start(first.agent, { mode: 'fixed', prompt: 'first session task', intervalMs: 5_000 })
    service.start(second.agent, { mode: 'fixed', prompt: 'second session task', intervalMs: 5_000 })
    await waitFor(() => first.followups.length === 1 && second.followups.length === 1, 'both loops start')
    assert.match(first.followups[0].content[0].text, /first session task/u)
    assert.match(second.followups[0].content[0].text, /second session task/u)

    service.stop(first.agent)
    assert.equal(service.get(second.agent)?.phase, 'active')
    service.stop(second.agent)
  })

  it('releases everything when the composition is torn down', async () => {
    const mounted = await harness()
    const { agent, followups } = await mounted.addAgent('teardown')
    mounted.service.start(agent, { mode: 'fixed', prompt: 'keep going', intervalMs: 1_000 })
    await waitFor(() => followups.length === 1, 'the first iteration')
    const atTeardown = followups.length
    await mounted.dispose()
    live.pop()
    await new Promise(resolve => setTimeout(resolve, 1_200))
    assert.equal(followups.length, atTeardown, 'teardown leaves no zombie timer')
    assert.equal(mounted.service.list().length, 0)
  })
})
