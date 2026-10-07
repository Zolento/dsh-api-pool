/**
 * End-to-end over the REAL agent loop.
 *
 * The other suites script the Agent because they pin scheduler semantics. This
 * one mounts the production `@deepseek-ai/dsh-agent-loop` and scripts only the
 * model, so the claim "a loop starts normal agent turns" is checked against real
 * turns: real pre-step, real tool dispatch, real `turn/start`/`turn/end`
 * session recording, and real serialization of physical turns.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
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
      const entry = this.script(this.requests.length - 1, options) ?? textResponse('done')
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
