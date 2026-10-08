/** Iteration messages and scoped system guidance; reuse the original loop prompt. */

/** Fallback when neither the command nor .dsh/loop.md supplies a prompt. */
export const DEFAULT_MAINTENANCE_PROMPT = [
  'Continue making useful progress on the current task.',
  'Inspect the workspace and any running work, then take the next concrete step.',
  'Do not repeat work that is already done or merely describe what could be done.',
].join(' ')

/** Render one iteration message, with adaptive guidance when no prompt section exists. */
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

/** Render system guidance for a loop iteration. */
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
