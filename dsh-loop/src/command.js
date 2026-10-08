/** Human-facing /loop command and status rendering. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { USAGE, formatDuration, parseLoopInput } from './parser.js'
import { LoopError } from './service.js'

/** Default workspace-relative file holding a loop prompt. */
export const LOOP_FILE = '.dsh/loop.md'

/** Commands meaningful from one exact live state. */
function commandHint(view) {
  switch (view.phase) {
    case 'active':
      return '/loop status, /loop pause, /loop stop'
    case 'paused':
      return '/loop status, /loop resume, /loop stop'
    default:
      return '/loop status'
  }
}

/** One-line phase label, including why a paused loop is paused. */
function phaseLabel(view) {
  if (view.phase === 'paused') {
    if (view.pauseReason === 'awaiting-schedule') return 'paused (awaiting schedule)'
    if (view.pauseReason === 'queue-failed') return 'paused (could not queue an iteration)'
    return 'paused'
  }
  return view.phase
}

/** Whether the loop's active work is an iteration currently in flight. */
function activityLabel(view) {
  if (view.running) return `iteration ${view.pendingIteration}`
  return 'idle'
}

/** Render status with times relative to `now`. */
export function renderLoopStatus(title, view, now) {
  const cadence = view.mode === 'fixed'
    ? `fixed, every ${formatDuration(view.intervalMs)}`
    : 'adaptive, scheduled by the model each iteration'
  const lines = [
    title,
    `Status: ${phaseLabel(view)} (${cadence})`,
    `Iterations started: ${view.iteration}`,
    `Current: ${activityLabel(view)}`,
    `Prompt: ${view.prompt}`,
  ]
  if (view.lastRunAt !== undefined) lines.push(`Last iteration started: ${formatDuration(now - view.lastRunAt)} ago`)
  if (view.phase === 'active') {
    if (view.nextRunAt === undefined) {
      lines.push('Next iteration: waiting for the current iteration to schedule one')
    } else if (view.nextRunAt <= now) {
      lines.push('Next iteration: due now (starts as soon as the session is idle)')
    } else {
      lines.push(`Next iteration: in ${formatDuration(view.nextRunAt - now)}`)
    }
  } else if (view.phase === 'paused' && view.pauseReason === 'awaiting-schedule') {
    lines.push('Next iteration: none — the adaptive iteration ended without schedule_next_loop or stop_loop')
  }
  if (view.lastSchedule?.reason !== undefined) {
    lines.push(`Last scheduling reason: ${view.lastSchedule.reason}`)
  }
  if (view.stopReason !== undefined) lines.push(`Stopped because: ${view.stopReason}`)
  lines.push('', `Commands: ${commandHint(view)}`)
  return lines.join('\n')
}

/** Read the trimmed workspace prompt; return undefined if absent, empty or unreadable. */
export function readLoopPromptFile(agent) {
  const cwd = agent.session?.header?.cwd ?? process.cwd()
  try {
    const text = readFileSync(join(cwd, LOOP_FILE), 'utf8').trim()
    return text.length === 0 ? undefined : text
  } catch {
    // Fall back to the configured default prompt.
    return undefined
  }
}

/** Register /loop and return its disposer. */
export function registerLoopCommand({ ctx, service }) {
  return ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-loop'),
    name: 'loop',
    description: 'Repeat a prompt in this session on a fixed interval or an adaptive schedule',
    input: { hint: '[<interval>] [<prompt>] | status | stop | pause | resume' },
    handler: invocation => execute(ctx, service, invocation),
  })
}

/** Parse and execute one /loop invocation. */
export function execute(ctx, service, invocation) {
  const parsed = parseLoopInput(invocation.rawInput, { minIntervalMs: service.minIntervalMs })
  if (parsed.kind === 'error') return { kind: 'error', text: `${parsed.message}\n${USAGE}` }

  const agent = invocation.agent
  const now = Date.now()

  if (parsed.kind === 'control') {
    const current = service.get(agent)
    if (parsed.action === 'status') {
      if (current === undefined) {
        return { kind: 'success', text: `No loop is active in this session.\n${USAGE}` }
      }
      return { kind: 'success', text: renderLoopStatus('Loop', service.view(current), now) }
    }
    if (current === undefined) {
      return { kind: 'error', text: `No loop is active in this session, so there is nothing to ${parsed.action}.\n${USAGE}` }
    }
    try {
      if (parsed.action === 'stop') {
        const view = service.stop(agent, 'user')
        return {
          kind: 'success',
          text: [
            `Loop stopped after ${view.iteration} iteration${view.iteration === 1 ? '' : 's'}.`,
            view.running
              ? 'The iteration that is already running will finish normally; nothing follows it.'
              : 'No further iterations will start.',
          ].join('\n'),
        }
      }
      if (parsed.action === 'pause') {
        const view = service.pause(agent, 'user')
        return { kind: 'success', text: renderLoopStatus('Loop paused', view, now) }
      }
      const view = service.resume(agent)
      return { kind: 'success', text: renderLoopStatus('Loop resumed', view, now) }
    } catch (error) {
      if (error instanceof LoopError) return { kind: 'error', text: `${error.message}\n${USAGE}` }
      throw error
    }
  }

  const fromFile = parsed.prompt === null ? readLoopPromptFile(agent) : undefined
  const prompt = parsed.prompt ?? fromFile ?? service.defaultPrompt
  const mode = parsed.intervalMs === null ? 'adaptive' : 'fixed'
  try {
    const state = service.start(agent, { prompt, mode, intervalMs: parsed.intervalMs ?? undefined })
    const view = service.view(state)
    const origin = parsed.prompt !== null
      ? 'prompt'
      : fromFile !== undefined ? `prompt from ${LOOP_FILE}` : 'default maintenance prompt'
    const headline = mode === 'fixed'
      ? `Loop started: one iteration every ${formatDuration(parsed.intervalMs)} (${origin}).`
      : `Loop started: adaptive scheduling (${origin}).`
    return {
      kind: 'success',
      text: [
        headline,
        `Prompt: ${prompt}`,
        'The first iteration starts as soon as this session is idle. Iterations never overlap and missed',
        'ticks are not replayed; the loop lives only while this session stays open.',
        view.mode === 'adaptive'
          ? 'Each iteration must call schedule_next_loop or stop_loop before it finishes.'
          : 'The next iteration is scheduled automatically; /loop stop ends it.',
      ].join('\n'),
    }
  } catch (error) {
    if (error instanceof LoopError) return { kind: 'error', text: `${error.message}\n${USAGE}` }
    throw error
  }
}
