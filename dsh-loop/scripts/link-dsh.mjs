#!/usr/bin/env node
/** Link installed DSH packages for standalone tests. Usage: node scripts/link-dsh.mjs [--dsh <path>]. */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Packages this plugin imports at runtime (declared as peers). */
const RUNTIME_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
]

/**
 * Packages only the tests mount: the production agent loop and the projection
 * registry it needs. The plugin never imports them.
 */
const TEST_ONLY_PACKAGES = [
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-session-projection',
]

const PACKAGES = [...RUNTIME_PACKAGES, ...TEST_ONLY_PACKAGES]

/** Locate the dsh installation that ships every needed package. */
function locateDsh(argv) {
  const flag = argv.indexOf('--dsh')
  if (flag !== -1 && argv[flag + 1] !== undefined) return resolve(argv[flag + 1])
  if (process.env.DSH_INSTALL !== undefined && process.env.DSH_INSTALL !== '') return resolve(process.env.DSH_INSTALL)
  const candidates = [
    join(homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  return candidates.find(candidate => existsSync(join(candidate, 'package.json')))
}

const install = locateDsh(process.argv.slice(2))
if (install === undefined) {
  console.error('link-dsh: cannot find the installed @deepseek-ai/dsh package; pass --dsh <path>')
  process.exit(1)
}

const scope = join(root, 'node_modules', '@deepseek-ai')
mkdirSync(scope, { recursive: true })
let linked = 0
for (const name of PACKAGES) {
  const target = join(install, 'node_modules', name)
  if (!existsSync(join(target, 'package.json'))) {
    console.error(`link-dsh: ${name} is not part of the installation at ${install}`)
    process.exit(1)
  }
  const link = join(scope, name.slice('@deepseek-ai/'.length))
  rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, 'dir')
  linked += 1
}
console.log(`link-dsh: linked ${linked} packages from ${install}`)
