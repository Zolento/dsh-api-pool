/** Production AgentLoop integration with a scripted model. */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import { apply as applyLoop } from '../src/index.js'
import { runCommand } from './helpers/harness.js'

/** Contexts created by this file, disposed after each test. */
const contexts = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** One complete assistant text response. */
function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One complete assistant tool call. */
function toolCallResponse(id, name, args) {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Model adapter whose behaviour is a pure function of the request count. */
class ScriptedAdapter extends LlmAdapter {
  constructor(script) {
    super()
    this.script = script
    this.requests = []
    this.concurrent = 0
    this.maxConcurrent = 0
  }

  async *stream(options) {
    this.requests.push(options)
    this.concurrent += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent)
    try {
      const entry = await this.script(this.requests.length - 1, options) ?? textResponse('done')
      if (entry instanceof Error) throw entry
      for (const chunk of entry) yield chunk
    } finally {
      this.concurrent -= 1
    }
  }
}

/** Mount the production agent loop, the real registries, and the loop plugin. */
async function mountAgentLoopHarness(script) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TimerService)
  const service = applyLoop(ctx, { minIntervalMs: 10 })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`e2e-${Math.random().toString(36).slice(2)}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, service, adapter, agent }
}

/** Poll until a predicate holds. */
async function waitFor(predicate, message, timeout = 5_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Loop-sourced user messages in the durable log, in order. */
function loopMessages(session) {
  return session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'loop')
}

/** Pair the durable turns of one session. */
function turns(session) {
  const events = session.snapshotEvents()
  const open = new Map()
  const closed = []
  for (const event of events) {
    if (event.type === 'turn/start') open.set(event.data.turn, [])
    if (event.type === 'user/message' && open.has(open.size === 0 ? -1 : [...open.keys()].at(-1))) {
      const turn = [...open.keys()].at(-1)
      if (turn !== undefined) open.get(turn).push(event.data)
    }
    if (event.type === 'turn/end') {
      closed.push({ turn: event.data.turn, reason: event.data.reason.kind, messages: open.get(event.data.turn) ?? [] })
      open.delete(event.data.turn)
    }
  }
  return closed
}

describe('real agent loop', () => {
  it('runs one real agent turn per fixed interval, in the same session', async () => {
    const { ctx, service, adapter, agent } = await mountAgentLoopHarness(() => textResponse('checked'))
    const session = agent.session

    const started = await runCommand(ctx, agent, '/loop 1s check whether the experiment has finished')
    assert.equal(started.kind, 'success')

    await waitFor(() => loopMessages(session).length >= 3, 'three real loop turns')
    assert.equal(adapter.maxConcurrent, 1, 'physical model requests never overlap')

    const recorded = turns(session)
    const loopTurns = recorded.filter(turn => turn.messages.some(message => message.source?.kind === 'loop'))
    assert.ok(loopTurns.length >= 3, 'each iteration is a durable turn of its own')
    for (const turn of loopTurns) assert.equal(turn.reason, 'completed')
    for (const turn of loopTurns) {
      assert.equal(turn.messages.filter(message => message.source?.kind === 'loop').length, 1,
        'one iteration per turn: the loop never stacks messages into a turn')
    }
    // The prompt the model actually received is the stable loop prompt.
    assert.match(JSON.stringify(adapter.requests[0]), /check whether the experiment has finished/u)
    assert.match(JSON.stringify(adapter.requests[1]), /Iteration:\\n2|Iteration:\s*2/u)

    const stopped = await runCommand(ctx, agent, '/loop stop')
    assert.equal(stopped.kind, 'success')
    const atStop = loopMessages(session).length
    await new Promise(resolve => setTimeout(resolve, 1_300))
    assert.equal(loopMessages(session).length, atStop, 'a stopped loop starts no further turns')
    assert.equal(service.get(agent), undefined)
  })

  it('lets an adaptive iteration schedule the next turn through a real tool call', async () => {
    const { ctx, service, adapter, agent } = await mountAgentLoopHarness((index) => {
      if (index === 0) return toolCallResponse('call-1', 'schedule_next_loop', { delay: '30s', reason: 'training is still running' })
      return textResponse('checked again')
    })
    const session = agent.session

    const started = await runCommand(ctx, agent, '/loop watch the training run')
    assert.equal(started.kind, 'success')
    assert.match(started.text, /adaptive scheduling/u)

    // Iteration one runs a real turn: the model calls the scoped tool, the loop
    // records the delay, and the turn keeps going until the text response.
    await waitFor(() => loopMessages(session).length === 1, 'the first adaptive turn')
    await waitFor(() => service.view(service.get(agent))?.nextRunAt !== undefined, 'the model schedule to be recorded')
    const view = service.view(service.get(agent))
    assert.equal(view.phase, 'active')
    assert.equal(view.lastSchedule.reason, 'training is still running')
    assert.ok(view.nextRunAt - Date.now() > 25_000, 'the next run honours the requested delay')

    // The tool was visible only inside that turn.
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    assert.equal(assembly.tools.some(tool => tool.name === 'schedule_next_loop'), false)

    await runCommand(ctx, agent, '/loop stop')
    assert.equal(service.get(agent), undefined)
    void adapter
  })

  it('reports a fixed cadence and pauses/resumes through real turns', async () => {
    const { ctx, service, agent } = await mountAgentLoopHarness(() => textResponse('ok'))
    const session = agent.session
    await runCommand(ctx, agent, '/loop 1s keep going')
    await waitFor(() => loopMessages(session).length >= 1, 'the first turn')

    const paused = await runCommand(ctx, agent, '/loop pause')
    assert.equal(paused.kind, 'success')
    const atPause = loopMessages(session).length
    await new Promise(resolve => setTimeout(resolve, 1_200))
    assert.equal(loopMessages(session).length, atPause, 'a paused loop runs no turns')

    await runCommand(ctx, agent, '/loop resume')
    await waitFor(() => loopMessages(session).length > atPause, 'resume runs one more turn')
    const status = await runCommand(ctx, agent, '/loop status')
    assert.match(status.text, /Status: active \(fixed, every 1s\)/u)
    await runCommand(ctx, agent, '/loop stop')
  })
})

describe('loop controls', () => {
  it('resumes an adaptive loop while its turn is still running', async () => {
    const held = Promise.withResolvers()
    const { ctx, agent, service, adapter } = await mountAgentLoopHarness(async index => {
      if (index === 0) await held.promise
      return textResponse('done')
    })
    try {
      await runCommand(ctx, agent, '/loop watch the job')
      await waitFor(() => adapter.requests.length === 1, 'the first request')
      await runCommand(ctx, agent, '/loop pause')
      const resumed = await runCommand(ctx, agent, '/loop resume')
      assert.equal(resumed.kind, 'success')
      held.resolve()
      await agent.whenIdle()
      assert.equal(loopMessages(agent.session).length, 2)
      assert.equal(adapter.maxConcurrent, 1)
      assert.equal(service.get(agent).pauseReason, 'awaiting-schedule')
    } finally {
      held.resolve()
    }
  })

  it('lets human resume override the current adaptive turn’s schedule', async () => {
    const held = Promise.withResolvers()
    const { ctx, agent, service, adapter } = await mountAgentLoopHarness(async index => {
      if (index === 0) return toolCallResponse('schedule-resume', 'schedule_next_loop', { delay: '1h' })
      if (index === 1) await held.promise
      return textResponse('done')
    })
    try {
      await runCommand(ctx, agent, '/loop watch the job')
      await waitFor(() => adapter.requests.length === 2, 'the scheduled turn to keep running')
      assert.equal(service.get(agent).scheduleRequest.delayMs, 3_600_000)
      await runCommand(ctx, agent, '/loop pause')
      await runCommand(ctx, agent, '/loop resume')
      held.resolve()
      await agent.whenIdle()
      assert.equal(loopMessages(agent.session).length, 2)
      assert.equal(adapter.maxConcurrent, 1)
    } finally {
      held.resolve()
    }
  })

  for (const action of ['pause', 'stop']) {
    it(`removes an unclaimed iteration on ${action} without discarding human input`, async () => {
      const held = Promise.withResolvers()
      const { ctx, agent, service, adapter } = await mountAgentLoopHarness(() => textResponse('done'))
      const maintenance = agent.runMaintenance(() => held.promise)
      try {
        agent.followup(createUserMessage({ content: 'Answer the human message.' }))
        await runCommand(ctx, agent, '/loop 1h watch the job')
        await waitFor(() => service.get(agent)?.pending?.phase === 'queued', 'the queued iteration')
        const result = await runCommand(ctx, agent, `/loop ${action}`)
        assert.equal(result.kind, 'success')
        assert.equal(agent.inbox.nextTurn.length, 1)
        if (action === 'stop') assert.doesNotMatch(result.text, /already running/u)
        held.resolve()
        await maintenance
        await agent.whenIdle()
        assert.equal(loopMessages(agent.session).length, 0)
        assert.equal(adapter.requests.length, 1, 'only the human turn runs')
        if (action === 'pause') {
          assert.equal(service.get(agent).phase, 'paused')
          await runCommand(ctx, agent, '/loop resume')
          await agent.whenIdle()
          assert.equal(loopMessages(agent.session).length, 1)
        } else {
          assert.equal(service.get(agent), undefined)
          await runCommand(ctx, agent, '/loop 1h a new loop')
          await waitFor(() => loopMessages(agent.session).length === 1, 'the replacement loop')
        }
      } finally {
        held.resolve()
        await maintenance
      }
    })
  }

  it('clears canceled queued work and continues on the next fixed tick', async () => {
    const held = Promise.withResolvers()
    const { ctx, agent, service, adapter } = await mountAgentLoopHarness(() => textResponse('done'))
    const maintenance = agent.runMaintenance(() => held.promise)
    try {
      service.start(agent, { mode: 'fixed', prompt: 'watch the job', intervalMs: 100 })
      await waitFor(() => service.get(agent)?.pending?.phase === 'queued', 'the queued iteration')
      agent.cancel({ kind: 'user' })
      assert.equal(service.view(service.get(agent)).running, false)
      assert.equal(service.get(agent).lastEndReason, 'discarded')
      held.resolve()
      await maintenance
      await waitFor(() => adapter.requests.length >= 1, 'the next fixed iteration')
      await runCommand(ctx, agent, '/loop stop')
      assert.equal(loopMessages(agent.session).length, 1)
    } finally {
      held.resolve()
      await maintenance
    }
  })

  it('cleans iteration tools and guidance before a queued human turn', async () => {
    const held = Promise.withResolvers()
    let agent
    let ordinaryAssembly
    const mounted = await mountAgentLoopHarness(async index => {
      if (index === 0) await held.promise
      else ordinaryAssembly = await mounted.ctx.systemPrompt.assemble({ agent, scope: agent })
      return textResponse('done')
    })
    agent = mounted.agent
    try {
      await runCommand(mounted.ctx, agent, '/loop watch the job')
      await waitFor(() => mounted.adapter.requests.length === 1, 'the iteration request')
      agent.followup(createUserMessage({ content: 'Explain another topic.' }))
      held.resolve()
      await agent.whenIdle()
      assert.equal(mounted.adapter.requests.length, 2)
      assert.equal(ordinaryAssembly.tools.some(tool => ['schedule_next_loop', 'stop_loop'].includes(tool.name)), false)
      assert.doesNotMatch(renderPrompt(ordinaryAssembly), /one iteration of an adaptive \/loop/u)
      assert.equal(mounted.service.get(agent).pauseReason, 'awaiting-schedule')
    } finally {
      held.resolve()
    }
  })

  it('exposes iteration tools only when the queued loop message is claimed', async () => {
    const held = Promise.withResolvers()
    const assemblies = []
    const mounted = await mountAgentLoopHarness(async () => {
      assemblies.push(await mounted.ctx.systemPrompt.assemble({ agent: mounted.agent, scope: mounted.agent }))
      return textResponse('done')
    })
    const { ctx, agent, service } = mounted
    const maintenance = agent.runMaintenance(() => held.promise)
    try {
      agent.followup(createUserMessage({ content: 'Answer first.' }))
      await runCommand(ctx, agent, '/loop watch the job')
      await waitFor(() => service.get(agent)?.pending?.phase === 'queued', 'the queued iteration')
      held.resolve()
      await maintenance
      await agent.whenIdle()
      assert.equal(assemblies.length, 2)
      assert.equal(assemblies[0].tools.some(tool => tool.name === 'schedule_next_loop'), false)
      assert.doesNotMatch(renderPrompt(assemblies[0]), /one iteration of an adaptive \/loop/u)
      assert.equal(assemblies[1].tools.some(tool => tool.name === 'schedule_next_loop'), true)
      assert.match(renderPrompt(assemblies[1]), /one iteration of an adaptive \/loop/u)
      assert.equal(loopMessages(agent.session).length, 1)
    } finally {
      held.resolve()
      await maintenance
    }
  })

  it('rejects zero and overflowing intervals without starting a loop', async () => {
    const { ctx, agent, service, adapter } = await mountAgentLoopHarness(() => textResponse('done'))
    for (const interval of ['0s', '9007199254741s']) {
      const result = await runCommand(ctx, agent, `/loop ${interval} watch the job`)
      assert.equal(result.kind, 'error')
      assert.equal(service.get(agent), undefined)
    }
    assert.equal(adapter.requests.length, 0)
  })
})
