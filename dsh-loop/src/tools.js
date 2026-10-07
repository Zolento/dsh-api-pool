/**
 * Model-facing adaptive control: `schedule_next_loop` and `stop_loop`.
 *
 * These two tools are the entire adaptive surface. They are registered into the
 * looping Agent's scope (`agent.ctx`) for the duration of one iteration turn and
 * disposed when that turn ends, so:
 *
 * - a turn that is not part of a loop iteration never sees them (no catalog
 *   pollution, and no chance of a stray call from an unrelated session);
 * - a subagent never inherits them;
 * - neither tool touches the running turn: scheduling only records a time, and
 *   stop ends the loop without cancelling the turn that called it.
 *
 * @module dsh-loop/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { LoopError } from './service.js'
import { formatDuration, parseDuration } from './parser.js'

/**
 * Output value schemas, written in the repository's value-schema DSL: a
 * per-property `required: true` flag, not JSON Schema's object-level `required`
 * array (which `defineTool` rejects).
 */
const SCHEDULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scheduled: { type: 'boolean', required: true },
    delay: { type: 'string', required: true },
    next_iteration: { type: 'number', required: true },
    next_run_in_ms: { type: 'number', required: true },
    reason: { type: 'string' },
  },
}

const STOP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stopped: { type: 'boolean', required: true },
    iteration: { type: 'number', required: true },
    reason: { type: 'string' },
  },
}

/** Error values are plain objects: callers branch on `code`, never on a throw. */
const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
}

/**
 * A tool's output schema must accept every value `execute` can return, so each
 * one is the union of its success shape and the error shape (the shipped
 * Schedule tools use the same construction).
 */
const SCHEDULE_OUTPUT = { oneOf: [SCHEDULE_SCHEMA, ERROR_SCHEMA] }
const STOP_OUTPUT = { oneOf: [STOP_SCHEMA, ERROR_SCHEMA] }

const SCHEDULE_DESCRIPTION = [
  'Schedule the next iteration of the adaptive /loop from inside the current iteration.',
  'Use it before finishing the turn. It records a time only: the current turn continues normally,',
  'nothing is interrupted, and the next iteration starts after this turn has completed and the',
  'delay has elapsed. Calling it more than once in one iteration replaces the earlier choice.',
].join(' ')

const STOP_DESCRIPTION = [
  'End the active /loop after the current iteration.',
  'The current turn continues normally; no further iterations are scheduled.',
  'Use it when the recurring task is complete, no longer useful, or unsafe to continue.',
].join(' ')

/** Render one canonical tool value as the model-facing JSON text. */
function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Generic pending card, matching the shipped tools' presentation. */
function present(title, kind, rawInput) {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

/** Stable error value; never leak internal failures into model text. */
function toolError(code, message) {
  return { code, message }
}

/**
 * Authorise one loop-tool call: the exact live Agent, inside its own driver,
 * inside an admitted iteration of the loop these tools belong to.
 */
function requireIteration(ctx, exec, agent, service, loopId) {
  if (exec.agent !== agent) {
    throw new LoopError('The loop tools belong to another session.', 'LOOP_TOOL_WRONG_AGENT')
  }
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    throw new LoopError(
      'The loop tools require the exact live calling agent inside its active turn.',
      'LOOP_TOOL_DRIVER_REQUIRED',
    )
  }
  const state = service.get(agent)
  if (state === undefined || state.id !== loopId) {
    throw new LoopError('The loop has ended.', 'LOOP_TOOL_NO_LOOP')
  }
  const view = service.view(state)
  if (!view.inIteration) {
    throw new LoopError('The loop tools are only valid during a loop iteration.', 'LOOP_TOOL_NOT_IN_ITERATION')
  }
  return state
}

/**
 * Register the model-facing control surface for one loop iteration.
 * @param options - collaborators.
 * @param options.ctx - plugin context exposing `agents`.
 * @param options.agent - the looping Agent (tool scope owner).
 * @param options.service - the loop driver.
 * @param options.loopId - loop identity captured when the tools were registered.
 * @returns an idempotent disposer for every registration.
 */
export function registerLoopTools({ ctx, agent, service, loopId }) {
  const toolCtx = agent.ctx
  const disposers = []
  const state = service.get(agent)
  const adaptive = state?.mode === 'adaptive'

  if (adaptive) {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_next_loop',
      description: SCHEDULE_DESCRIPTION,
      parameters: {
        delay: {
          type: 'string',
          required: true,
          description: 'How long to wait before the next iteration, e.g. "5m", "30s", "1h".',
        },
        reason: {
          type: 'string',
          description: 'Why that delay is right; shown in /loop status.',
        },
      },
      output: { schema: SCHEDULE_OUTPUT, render: renderValue },
      async execute(args, exec) {
        try {
          const state = requireIteration(ctx, exec, agent, service, loopId)
          const delayMs = parseDuration(args.delay)
          if (delayMs === undefined) {
            return toolError('invalid_delay', 'delay must be a duration like 30s, 5m or 1h.')
          }
          if (delayMs < service.minIntervalMs) {
            return toolError(
              'delay_too_short',
              `delay must be at least ${formatDuration(service.minIntervalMs)}.`,
            )
          }
          const iteration = service.view(state).iteration
          service.scheduleNext(agent, {
            at: Date.now() + delayMs,
            delayMs,
            reason: args.reason,
            iteration,
          })
          return {
            scheduled: true,
            delay: formatDuration(delayMs),
            next_iteration: iteration + 1,
            next_run_in_ms: delayMs,
            ...(args.reason === undefined ? {} : { reason: args.reason }),
          }
        } catch (error) {
          if (error instanceof LoopError) return toolError(error.code, error.message)
          return toolError('internal_error', 'The scheduling call failed.')
        }
      },
      presentCall: args => present('Schedule next loop iteration', 'other', args.delay),
    })))
  }

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'stop_loop',
    description: STOP_DESCRIPTION,
    parameters: {
      reason: {
        type: 'string',
        description: 'Why the loop should end; recorded in the session log.',
      },
    },
    output: { schema: STOP_OUTPUT, render: renderValue },
    async execute(args, exec) {
      try {
        const current = requireIteration(ctx, exec, agent, service, loopId)
        const iteration = current.iteration
        service.stop(agent, args.reason === undefined ? 'model' : `model: ${args.reason}`)
        return {
          stopped: true,
          iteration,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        }
      } catch (error) {
        if (error instanceof LoopError) return toolError(error.code, error.message)
        return toolError('internal_error', 'The stop call failed.')
      }
    },
    presentCall: () => present('Stop loop', 'other'),
  })))

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // Teardown is best-effort: the registrations are effect-scoped anyway.
      }
    }
  }
}
