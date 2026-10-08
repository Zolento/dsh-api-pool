/** Compose the session-scoped /loop scheduler, command, tools and prompt section. */

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

/** Required host services; timers are scoped to the plugin lifecycle. */
export const inject = ['agents', 'timer']

/** Prompt-section placement; after the shipped tool-guidance sections. */
export const LOOP_SECTION_ORDER = 2_500

/** Validate and resolve plugin configuration. */
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

/** Register the plugin surfaces and return the loop service. */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  let toolsAvailable = false
  const service = new LoopService({
    ctx,
    minIntervalMs: resolved.minIntervalMs,
    defaultPrompt: resolved.defaultPrompt,
    // Plugin teardown also cancels timers through Cordis effects.
    timer: { schedule: (callback, delay) => ctx.timeout(callback, delay) },
    toolsAvailable: () => toolsAvailable,
    attachTools: state => registerLoopTools({
      ctx,
      agent: state.agent,
      service,
      loopId: state.id,
    }),
  })

  // Expose loop state to other plugins.
  ctx.provide('loop', service)

  // Release service state before removing lifecycle listeners.
  ctx.effect(function* () {
    // Idle transitions drive iteration cleanup and scheduling.
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

    // Session restore does not replay seed events here.
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

  // Render guidance when the service marks an iteration as pending.
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

  // Register model tools per iteration when the tools service exists.
  ctx.inject(['tools'], () => {
    toolsAvailable = true
  })

  return service
}
