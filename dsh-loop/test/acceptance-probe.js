/**
 * Acceptance probe: a test-only plugin that proves the real composition.
 *
 * `scripts/acceptance.sh` boots a real `dsh` profile (an isolated DSH_HOME, so
 * nothing touches the developer's harness) with this row added by an overlay
 * patch. Once the profile is up, the probe reports what it can observe from
 * inside the running process:
 *
 * - the `dsh-loop` loader row reached the active fiber state;
 * - the `loop` service is provided on the context;
 * - `/loop` is a registered command, reachable through the same global command
 *   lookup an agent's slash menu uses.
 *
 * It writes one JSON file and never mutates anything. It intentionally imports
 * nothing from `@deepseek-ai/*`: a probe loaded by an out-of-tree `--patch`
 * overlay is outside the profile's module-interception layer, so it must work
 * with the context alone.
 *
 * @module dsh-loop/test/acceptance-probe
 */

import { writeFileSync } from 'node:fs'

export const name = 'loop-acceptance-probe'
export const inject = ['loader', 'commands', 'loop', 'timer']

/** Fiber state value meaning "active" in cordis. */
const FIBER_ACTIVE = 2

export function apply(ctx, config) {
  const reportPath = config?.reportPath
  if (typeof reportPath !== 'string' || reportPath.length === 0) {
    throw new TypeError('loop-acceptance-probe: reportPath is required')
  }
  const delayMs = config?.delayMs ?? 2000

  const report = payload => {
    try {
      writeFileSync(reportPath, JSON.stringify(payload, null, 2))
    } catch (error) {
      ctx.logger?.warn?.(`loop-acceptance-probe: could not write the report: ${String(error)}`)
    }
  }

  ctx.timeout(() => {
    const result = { ok: false, checks: {}, errors: [] }
    try {
      const entries = [...ctx.loader.entries()]
      const row = entries.find(entry => entry.options?.id === 'dsh-loop')
      result.checks.rowPresent = row !== undefined
      result.checks.rowFiberState = row?.fiber?.state
      result.checks.rowActive = row?.fiber?.state === FIBER_ACTIVE
      result.checks.loopServiceProvided = ctx.get('loop') !== undefined
      // The same lookup the slash menu performs for an agent: global layer plus
      // that agent's scope chain. A bare object is a valid scope key and yields
      // the global registrations.
      const commands = ctx.commands.list({ id: 'loop-acceptance-probe' })
      result.checks.commandNames = commands.map(command => command.name)
      result.checks.loopCommandRegistered = commands.some(command => command.name === 'loop')
      result.ok = result.checks.rowPresent === true
        && result.checks.rowActive === true
        && result.checks.loopServiceProvided === true
        && result.checks.loopCommandRegistered === true
    } catch (error) {
      result.errors.push(String(error?.stack ?? error))
    }
    report(result)
  }, delayMs)
}

