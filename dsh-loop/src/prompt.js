/**
 * Model-facing text for loops: the per-iteration message and the scoped
 * system-prompt section.
 *
 * Two rules shape this module.
 *
 * 1. The loop prompt is stable. Every iteration carries the *original* prompt
 *    verbatim, never a rewritten or summarized one, so the recurrence cannot
 *    drift as the session grows.
 * 2. Continuity is the session's job. The iteration message says nothing about
 *    previous iterations and copies no conversation state: this is the same
 *    Agent, in the same conversation, with the same workspace.
 *
 * @module dsh-loop/prompt
 */

/**
 * Used when `/loop` carries no prompt and the workspace has no `.dsh/loop.md`.
 * Deliberately short and non-committal: it tells the model how to spend an
 * unattended iteration without inventing an objective the human never asked for.
 */
export const DEFAULT_MAINTENANCE_PROMPT = [
  'Continue making useful progress on the current task.',
  'Inspect the workspace and any running work, then take the next concrete step.',
  'Do not repeat work that is already done or merely describe what could be done.',
].join(' ')

/**
 * The per-iteration user message. One text block, one stable shape.
 * @param input - iteration facts and the note the loop cannot put in a prompt section.
 * @returns one model-facing text content block.
 */
export function renderLoopIteration({ prompt, iteration, adaptiveNote }) {
  const lines = [
    '<loop_iteration>',
    'Loop prompt:',
    prompt,
    '',
    'Iteration:',
    String(iteration),
    '',
    'Continue this recurring task in the current session.',
    '',
    'Treat the current conversation, workspace, tool results, and repository',
    'state as authoritative.',
    '',
    'Perform concrete work rather than only describing what could be done.',
    '',
    'This is a new scheduled iteration of the active /loop.',
  ]
  if (typeof adaptiveNote === 'string' && adaptiveNote.length > 0) {
    lines.push('', adaptiveNote)
  }
  lines.push('</loop_iteration>')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The adaptive contract, stated once and reused by the section and the fallback note. */
export const ADAPTIVE_GUIDANCE = [
  'You are running as one iteration of an adaptive /loop.',
  '',
  'Complete useful work for the loop objective.',
  '',
  'Before finishing this iteration, either schedule the next iteration',
  'with the loop scheduling tool or stop the loop if continued execution',
  'is no longer useful.',
  '',
  'Scheduling a next iteration does not interrupt the current turn.',
  'The next iteration will start only after this turn has completed and',
  'the requested delay has elapsed.',
].join('\n')

/**
 * The scoped system-prompt section rendered for one loop iteration turn only.
 * @param state - the loop's current view.
 * @param format - `formatDuration` from the parser module.
 * @returns the section text, or an empty string outside an iteration turn.
 */
export function renderLoopSection(state, format) {
  if (state === undefined) return ''
  if (state.mode === 'adaptive') return ADAPTIVE_GUIDANCE
  return [
    `This turn is iteration ${state.iteration} of a fixed /loop that repeats every ${format(state.intervalMs)}.`,
    '',
    'The next iteration is scheduled automatically; do not sleep or wait for it.',
    'Call stop_loop if the recurring task has become useless or unsafe to continue.',
  ].join('\n')
}
