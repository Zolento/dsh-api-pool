/**
 * Integration harness: the loop plugin composed over the *real* cordis context
 * and the real registries this feature depends on (timer, sessions, tools,
 * system prompt, commands, agents).
 *
 * Only the Agent is scripted: a real `AgentLoop` would need an LLM adapter and a
 * wall clock, and its turn lifecycle is not what these tests are pinning down.
 * The scripted Agent reproduces the parts of the contract the driver relies on
 * -- `status` transitions published as `agent/status`, inbox claim/discard
 * events, and balanced `turn/start` / `user/message` / `turn/end` session
 * events -- and nothing else.
 *
 * @module dsh-loop/test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import { apply as applyLoop } from '../../src/index.js'

/** Inbox implementation matching the public `Inbox` contract. */
export function createInboxStub() {
  const lists = { 'next-turn': [], 'next-step': [] }
  const target = name => {
    const list = lists[name]
    if (list === undefined) throw new Error(`unknown inbox target ${name}`)
    return list
  }
  return {
    get nextTurn() {
      return lists['next-turn']
    },
    get nextStep() {
      return lists['next-step']
    },
    clear() {
      lists['next-step'].length = 0
      lists['next-turn'].length = 0
    },
    append(name, message) {
      target(name).push(message)
    },
    prepend(name, message) {
      target(name).unshift(message)
    },
    replace(messageId, newMessage) {
      for (const list of Object.values(lists)) {
        const index = list.findIndex(candidate => candidate.id === messageId)
        if (index !== -1) {
          list[index] = newMessage
          return true
        }
      }
      return false
    },
    remove(messageId) {
      for (const list of Object.values(lists)) {
        const index = list.findIndex(candidate => candidate.id === messageId)
        if (index !== -1) {
          list.splice(index, 1)
          return true
        }
      }
      return false
    },
    splice(name, start, deleteCount, inserted = []) {
      return target(name).splice(start, deleteCount, ...inserted)
    },
  }
}

/**
 * Mount the real services the loop composes over, plus the plugin itself.
 * @param options - plugin config and scripted-Agent behaviour.
 * @returns harness handles.
 */
export async function mountHarness({ config = {}, autoRun = true, onTurn } = {}) {
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  // The agent scope must hang below a context that injected `tools` and
  // `systemPrompt`, exactly as `AgentLoop` does in production
  // (`static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', ...]`):
  // service resolution walks the *accessing* context's fiber chain, so an agent
  // scope created directly under the root could not reach `agent.ctx.tools`.
  let driverCtx
  await ctx.plugin({
    name: 'loop-test-driver',
    inject: ['tools', 'systemPrompt', 'commands', 'sessions'],
    apply(inner) {
      driverCtx = inner
    },
  })
  const service = applyLoop(ctx, config)
  const scopes = []
  const agents = []

  /**
   * Build and register one scripted Agent with its own session and scope.
   * @param id - session id.
   * @param options - cwd metadata and auto-run override.
   */
  async function addAgent(id, options = {}) {
    const session = ctx.sessions.create(SessionId(id), {
      ...(options.cwd === undefined ? {} : { meta: { cwd: options.cwd } }),
    })
    const inbox = createInboxStub()
    let status = 'idle'
    let turn = 0
    const followups = []
    const turns = []
    const emit = (name, payload) => agentEvents(ctx, agent).emit(name, payload)
    const setStatus = next => {
      if (status === next) return
      status = next
      emit('agent/status', { agent, status: next })
    }
    const agent = {
      id: session.id,
      options: {},
      session,
      inbox,
      // Replaced below: the scope key must be the Agent itself, exactly as
      // `AgentRegistry` mints it (`scopeTarget(agent, agent)`), because tool and
      // prompt assemblies are resolved for `scope: agent`.
      ctx: undefined,
      get status() {
        return status
      },
      send(message, target) {
        inbox.append(target, message)
      },
      followup(message) {
        followups.push(message)
        inbox.append('next-turn', message)
        wake()
      },
      steer(message) {
        inbox.append('next-step', message)
        wake()
      },
      inject(message) {
        inbox.append('next-step', message)
      },
      cancel() {
        setStatus('idle')
      },
      runMaintenance: task => task(new AbortController().signal),
      whenIdle() {
        return Promise.resolve()
      },
    }

    const runTurns = options.autoRun ?? autoRun
    const turnHook = options.onTurn ?? onTurn
    const scope = createScope(driverCtx, agent)
    scopes.push(scope)
    agent.ctx = scope.ctx
    const drain = async () => {
      while (inbox.nextTurn.length > 0) {
        const [message] = inbox.splice('next-turn', 0, 1)
        turn += 1
        const claimed = turn
        emit('agent/inbox/claimed', { agent, message, turn: claimed })
        session.append('turn/start', { turn: claimed })
        session.append('user/message', message, { surfaceOp: 'append' })
        turns.push({ turn: claimed, message })
        if (turnHook !== undefined) await turnHook({ agent, message, turn: claimed, session })
        session.append('turn/end', { turn: claimed, reason: { kind: 'completed' } })
      }
      setStatus('idle')
    }
    const wake = () => {
      if (status !== 'idle' || !runTurns) return
      setStatus('running')
      queueMicrotask(() => {
        void drain()
      })
    }

    await ctx.agents.register(agent)
    const handle = {
      agent,
      session,
      inbox,
      followups,
      turns,
      /** Pretend a turn is in flight without running one. */
      setBusy: () => setStatus('running'),
      setIdle: () => setStatus('idle'),
      /** Run the queue explicitly (for `autoRun: false` agents). */
      runTurns: drain,
      /** Abort the pending turn the way the driver would: discard the inbox. */
      discardPending() {
        for (const message of [...inbox.nextTurn, ...inbox.nextStep]) {
          inbox.remove(message.id)
          emit('agent/inbox/discarded', { agent, message })
        }
      },
    }
    agents.push(handle)
    return handle
  }

  return {
    ctx,
    service,
    addAgent,
    agents,
    /** Drain microtasks so scripted turns settle. */
    settle: async () => {
      for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve))
    },
    /** Tear the whole composition down. */
    dispose: async () => {
      for (const scope of scopes.reverse()) await scope.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/**
 * Execute one `/loop` line through the real command registry, exactly as a UI
 * adapter does.
 * @param ctx - harness context.
 * @param agent - invoking Agent.
 * @param line - complete command line.
 * @returns the command result.
 */
export async function runCommand(ctx, agent, line) {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`command was not registered: ${line}`)
  return execution.result
}
