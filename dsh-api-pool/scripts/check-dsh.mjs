#!/usr/bin/env node
/**
 * Verify that the DSH this plugin is installed against still matches the
 * compatibility pin in dsh-compat.json.
 *
 * Checks three independent facts:
 *   1. the installed `dsh --version`;
 *   2. the DSH source checkout's exact tag at HEAD (when one exists locally);
 *   3. the DSH source checkout's commit.
 *
 * Exit code 0 = everything matches. Exit code 1 = drift: re-run the suite and
 * acceptance, fix whatever seam broke (the list is in dsh-compat.json), then
 * bump the pin and the plugin version.
 *
 * Usage: node scripts/check-dsh.mjs [--source <path>]
 *        DSH_SOURCE=/path/to/deepseek-harness node scripts/check-dsh.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pin = JSON.parse(readFileSync(join(root, 'dsh-compat.json'), 'utf8'))
const expected = pin.dsh

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options }).trim()
  } catch {
    return undefined
  }
}

const sourceIndex = process.argv.indexOf('--source')
const source = resolve(
  sourceIndex !== -1 && process.argv[sourceIndex + 1]
    ? process.argv[sourceIndex + 1]
    : process.env.DSH_SOURCE ?? join(homedir(), 'code', 'deepseek-harness'),
)

const results = []
const installed = run('dsh', ['--version'])?.split('\n')[0].trim()
results.push({
  name: 'installed dsh --version',
  actual: installed,
  expected: expected.version,
  ...installed === undefined ? { note: 'dsh is not on PATH; skipping this check' } : {},
})

let tag
let commit
if (run('git', ['-C', source, 'rev-parse', '--is-inside-work-tree']) === 'true') {
  tag = run('git', ['-C', source, 'describe', '--tags', '--exact-match', 'HEAD'])
  commit = run('git', ['-C', source, 'rev-parse', 'HEAD'])
  results.push({ name: 'source HEAD tag', actual: tag, expected: expected.tag })
  results.push({ name: 'source HEAD commit', actual: commit, expected: expected.commit })
} else {
  results.push({ name: 'source checkout', actual: undefined, expected: `${source} (a git checkout)`, note: 'not found; set DSH_SOURCE to check the source pin' })
}

let drift = false
for (const result of results) {
  const matches = result.actual !== undefined && result.actual === result.expected
  if (!matches && result.note === undefined) drift = true
  const mark = result.note !== undefined ? '–' : matches ? 'OK  ' : 'DRIFT'
  console.log(`${mark} ${result.name}: expected ${result.expected}, actual ${result.actual ?? '(unavailable)'}${result.note === undefined ? '' : ` — ${result.note}`}`)
}

if (drift) {
  console.log('\nThe plugin was verified against a different DSH build.')
  console.log('Next steps:')
  console.log('  1. npm test && ACCEPTANCE_BOOT=1 bash scripts/acceptance.sh')
  console.log('  2. re-check every seam listed in dsh-compat.json')
  console.log('  3. update dsh-compat.json and package.json version, add a CHANGELOG entry, tag the release')
  process.exit(1)
}
console.log(`\nOK: dsh-api-pool ${pin.pluginVersion} matches DSH ${expected.version} (${expected.commit.slice(0, 12)}).`)
