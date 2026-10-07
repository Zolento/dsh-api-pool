/**
 * dsh-loop — a Claude-Code-style `/loop` for DeepSeek Harness.
 *
 * `/loop 5m <prompt>` repeats an ordinary agent turn in the *current* session,
 * `/loop <prompt>` runs an adaptive loop whose iterations choose when to run
 * again, and `/loop status|stop|pause|resume` controls it. The loop is a
 * consumer of the normal agent loop: iterations enter through
 * `Agent.followup(...)`, so tools, permissions, compaction and session
 * recording are unchanged, and `@deepseek-ai/dsh-agent-loop` is untouched.
 *
 * Lifecycle is session-scoped and intentionally not persisted: a loop lives
 * while its Agent is live, and dies with it. Only one loop per session is
 * allowed; the driver's store is the single place a multi-loop revision would
 * have to change.
 *
 * @module dsh-loop
 */

import { MIN_INTERVAL_MS, formatDuration } from './parser.js'
import { DEFAULT_MAINTENANCE_PROMPT, renderLoopSection } from './prompt.js'
import { LoopService } from './service.js'
import { registerLoopCommand } from './command.js'
import { registerLoopTools } from './tools.js'

export { LoopService, LoopError, MAX_TIMER_DELAY_MS } from './service.js'
export { registerLoopTools } from './tools.js'
export { registerLoopCommand, renderLoopStatus, readLoopPromptFile, LOOP_FILE } from './command.js'
export {
  ADAPTIVE_GUIDANCE,
  DEFAULT_MAINTENANCE_PROMPT,
  renderLoopIteration,
  renderLoopSection,
} from './prompt.js'
export {
  DURATION_UNITS,
  MIN_INTERVAL_MS,
  CONTROL_WORDS,
  USAGE,
  formatDuration,
  looksLikeMalformedDuration,
  parseDuration,
  parseLoopInput,
} from './parser.js'

export const name = 'loop'

/**
 * Required services. `timer` is the cordis timer service: it is the
 * repository's one in-process timer abstraction, and its effects are torn down
 * with this plugin, which is what keeps a stopped profile free of zombie loop
 * timers.
 */
export const inject = ['agents', 'timer']

/** Prompt-section placement; after the shipped tool-guidance sections. */
export const LOOP_SECTION_ORDER = 2_500

/**
 * Validate the row config even when `apply` is called directly, without Loader
 * normalization (the shipped plugins do the same).
 * @param config - raw row config.
 * @returns resolved config.
 */
function resolveConfig(config) {
  const minIntervalMs = config?.minIntervalMs
  if (minIntervalMs !== undefined && !(Number.isSafeInteger(minIntervalMs) && minIntervalMs > 0)) {
    throw new TypeError('dsh-loop: minIntervalMs must be a positive safe integer')
  }
  const defaultPrompt = config?.defaultPrompt
  if (defaultPrompt !== undefined && (typeof defaultPrompt !== 'string' || defaultPrompt.trim().length === 0)) {
    throw new TypeError('dsh-loop: defaultPrompt must be a non-empty string')
  }
  return {
    minIntervalMs: minIntervalMs ?? MIN_INTERVAL_MS,
    defaultPrompt: defaultPrompt ?? DEFAULT_MAINTENANCE_PROMPT,
  }
}

/**
 * Compose the loop driver, its human command, its scoped prompt section and its
 * per-iteration model tools.
 * @param ctx - plugin context.
 * @param config - optional row config.
 * @returns the composed {@link LoopService} (handy for tests and inspection).
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  let toolsAvailable = false
  const service = new LoopService({
    ctx,
    minIntervalMs: resolved.minIntervalMs,
    defaultPrompt: resolved.defaultPrompt,
    // `ctx.timeout` is a fiber effect: plugin teardown cancels every armed loop
    // timer even if a state was somehow missed by the explicit cleanup paths.
    timer: { schedule: (callback, delay) => ctx.timeout(callback, delay) },
    toolsAvailable: () => toolsAvailable,
    attachTools: state => registerLoopTools({
      ctx,
      agent: state.agent,
      service,
      loopId: state.id,
    }),
  })

  // The driver is provided as the `loop` service: `inject: ['loop']` gives other
  // plugins the session-scoped state (status surfaces, future multi-loop
  // extensions), and it is what an out-of-process acceptance probe checks to
  // prove the row activated.
  ctx.provide('loop', service)

  // One composite effect: the listeners stay installed until the service's own
  // timers and registrations have been released.
  ctx.effect(function* () {
    // An idle Agent is the only moment an iteration may start, and the moment a
    // finished iteration is accounted for.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') service.onIdle(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => service.discard(agent))
    ctx.on('session/disposed', session => {
      for (const state of service.list()) {
        if (state.agent.session === session) service.discard(state.agent)
      }
    })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => service.onClaimed(agent, message.id, turn))
    ctx.on('agent/inbox/discarded', ({ agent, message }) => service.onDiscarded(agent, message.id))

    // Durable turn facts classify an iteration's turn. Restore/fork never
    // republishes seed events, so replaying history cannot restart a loop.
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      switch (event.type) {
        case 'turn/start':
          service.onTurnStart(agent, event.data.turn)
          return
        case 'turn/end':
          service.onTurnEnd(agent, event.data.turn, event.data.reason.kind)
          return
        case 'user/message':
          service.onUserMessage(agent, event.data.id)
          return
        default:
          return
      }
    })

    yield () => service.dispose()
  }, 'dsh-loop lifecycle')

  // The scoped system prompt: rendered only while the calling Agent is inside
  // one of its loop's iteration turns, so non-loop turns are untouched.
  ctx.inject(['systemPrompt'], promptCtx => {
    service.setPromptSectionAvailable(true)
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'loop:iteration',
      order: LOOP_SECTION_ORDER,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        const state = service.get(agent)
        if (state === undefined) return ''
        const view = service.view(state)
        if (!view.inIteration) return ''
        return renderLoopSection(view, formatDuration)
      },
    }), 'dsh-loop prompt section')
  })

  // Compose the human command only where a command registry exists.
  ctx.inject(['commands'], commandCtx => {
    commandCtx.effect(() => registerLoopCommand({ ctx: commandCtx, service }), 'dsh-loop command')
  })

  // Compose the model-facing control surface only where tools exist. The tools
  // themselves are registered per iteration into the looping Agent's scope.
  ctx.inject(['tools'], () => {
    toolsAvailable = true
  })

  return service
}
