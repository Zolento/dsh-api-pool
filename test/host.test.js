import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The relay port is a constant of the shipped configuration; a test may move it
// so it cannot collide with a running harness instance.
process.env.DSH_API_POOL_PORT = '18765'
const { Config } = await import('../src/config.js')
const { apply, RELAY_PORT, RELAY_TOKEN_REF, BASE_PATH } = await import('../src/index.js')

/** Minimal fake host context capturing the services the plugin uses. */
function fakeContext() {
  const credentials = new Map()
  const mutations = []
  const listeners = new Map()
  const disposers = []
  const commands = []
  function recordEffect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'settings') {
        // A disposal-time lookup can legitimately return nothing once the
        // registry is torn down; the plugin must have captured it earlier.
        if (ctx.settingsGone === true) return undefined
        return { mutate: async (ns, ops) => { mutations.push({ ns, ops }) } }
      }
      if (name === 'credentials') {
        return {
          resolve: async ref => credentials.has(ref) ? { value: credentials.get(ref) } : undefined,
          set: async (ref, value) => { credentials.set(ref, value) },
        }
      }
      return undefined
    },
    on(event, handler) { listeners.set(event, handler) },
    inject(names, callback) {
      if (names.includes('commands')) {
        callback({
          commands: { register: def => { commands.push(def); return () => {} } },
          effect: recordEffect,
        })
      }
    },
    effect: recordEffect,
  }
  return { ctx, credentials, mutations, listeners, disposers, commands }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

function withHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-api-pool-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
  return home
}

test('the host plugin runs a relay that serves the configured endpoints', async (t) => {
  withHome(t)
  const { ctx, credentials, mutations, disposers } = fakeContext()
  t.after(async () => { for (const dispose of disposers) await dispose() })

  apply(ctx, Config({
    endpoints: [
      { name: 'primary', baseURL: 'https://primary.example/v1', apiKeyEnv: 'PRIMARY_KEY' },
      { name: 'secondary', baseURL: 'https://secondary.example/v1', apiKeyEnv: 'SECONDARY_KEY' },
    ],
  }))

  assert.equal(await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`, { signal: AbortSignal.timeout(500) })
      return response.ok
    } catch { return false }
  }), true, 'the relay never became reachable')

  const health = await (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`)).json()
  assert.equal(health.provider, 'dsh-api-pool')
  assert.deepEqual(health.endpoints.map(endpoint => endpoint.name).sort(), ['primary', 'secondary'])

  // The token is stored so the published provider profile can present it.
  assert.equal(credentials.has(RELAY_TOKEN_REF), true)

  // The plugin publishes the route through the `llm-pi-ai` settings namespace.
  assert.equal(await waitFor(() => mutations.some(entry =>
    entry.ns === 'llm-pi-ai'
    && entry.ops[0]?.op === 'set'
    && entry.ops[0]?.path.join('.') === 'providers.deepseek-pool')), true, 'the provider profile was not published')
  const published = mutations.find(entry => entry.ops[0]?.op === 'set' && entry.ops[0]?.path.join('.') === 'providers.deepseek-pool')
  assert.equal(published.ops[0].value.displayName, 'API Pool')
  assert.equal(published.ops[0].value.baseURL, `http://127.0.0.1:${RELAY_PORT}${BASE_PATH}`)
  assert.deepEqual(published.ops[0].value.models.map(model => model.id), ['deepseek-flash'])

  // The relay advertises the same configured model list.
  const models = await (await fetch(`http://127.0.0.1:${RELAY_PORT}${BASE_PATH}/models`, {
    headers: { authorization: `Bearer ${credentials.get(RELAY_TOKEN_REF)}` },
  })).json()
  assert.deepEqual(models.data.map(model => model.id), ['deepseek-flash'])
})

test('disposal withdraws the provider profile and stops the relay this process owns', async (t) => {
  withHome(t)
  const { ctx, mutations, disposers } = fakeContext()
  apply(ctx, Config({ endpoints: [{ name: 'primary', baseURL: 'https://primary.example/v1', apiKeyEnv: 'K' }] }))

  assert.equal(await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`, { signal: AbortSignal.timeout(500) })).ok } catch { return false }
  }), true)

  for (const dispose of disposers) await dispose()
  assert.deepEqual(
    mutations.find(entry => entry.ops[0]?.op === 'unset')?.ops[0],
    { op: 'unset', path: ['providers', 'deepseek-pool'] },
  )
  await assert.rejects(() => fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`, { signal: AbortSignal.timeout(500) }))
})

test('disposal withdraws the profile even after the settings registry is gone', async (t) => {
  withHome(t)
  const { ctx, mutations, disposers } = fakeContext()
  apply(ctx, Config({ endpoints: [{ name: 'primary', baseURL: 'https://primary.example/v1', apiKeyEnv: 'K' }] }))

  assert.equal(await waitFor(() => mutations.some(entry => entry.ops[0]?.op === 'set')), true)
  // Simulate teardown ordering: the settings service is no longer resolvable.
  ctx.settingsGone = true
  for (const dispose of disposers) await dispose()

  const unset = mutations.find(entry => entry.ops[0]?.op === 'unset')
  assert.deepEqual(unset?.ops[0], { op: 'unset', path: ['providers', 'deepseek-pool'] })
})

test('the /api-pool command shows endpoint health without spend accounting', async (t) => {
  withHome(t)
  const { ctx, disposers, commands } = fakeContext()
  t.after(async () => { for (const dispose of disposers) await dispose() })
  apply(ctx, Config({ endpoints: [{ name: 'primary', baseURL: 'https://primary.example/v1', apiKeyEnv: 'K' }] }))

  assert.equal(await waitFor(() => commands.some(command => command.name === 'api-pool')), true, 'the command was never registered')
  const command = commands.find(entry => entry.name === 'api-pool')
  assert.equal(await waitFor(() => !command.handler().text.includes('still starting')), true, 'the pool never became ready')

  const text = command.handler().text
  assert.match(text, /^dsh-api-pool — 1 endpoint\(s\), strategy=least_loaded/)
  assert.match(text, /\n  primary  /)
  assert.match(text, /capacity: \d+\/\d+ ready now/)
  assert.match(text, new RegExp(`relay: http://127\\.0\\.0\\.1:${RELAY_PORT}`))
  assert.equal(text.includes('cum='), false, 'the removed cum column must not come back')
  assert.equal(text.includes('cumulative'), false, 'the removed cumulative line must not come back')
})

test('a port held by a foreign process is reported as unavailable, not shared', async (t) => {
  withHome(t)
  // Occupy the relay port the way a harness instance with another token would.
  const blocker = createServer(() => {})
  await new Promise(resolve => blocker.listen(RELAY_PORT, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => blocker.close(() => resolve())))

  const { ctx, disposers, commands } = fakeContext()
  t.after(async () => { for (const dispose of disposers) await dispose() })
  apply(ctx, Config({ endpoints: [{ name: 'primary', baseURL: 'https://primary.example/v1', apiKeyEnv: 'K' }] }))

  assert.equal(await waitFor(() => commands.some(command => command.name === 'api-pool')), true)
  const command = commands.find(entry => entry.name === 'api-pool')
  assert.equal(await waitFor(() => command.handler().text.includes('unavailable')), true,
    'a taken port must not be advertised as shared or owned')
  assert.match(command.handler().text, /relay: http:\/\/127\.0\.0\.1:\d+\/v1 \(unavailable/)
})

test('the observed provider budget is published for the settings page', async (t) => {
  withHome(t)
  const upstream = createServer((req, res) => {
    if (req.url.startsWith('/key/info')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ info: { spend: 10, max_budget: 100, rpm_limit: 20 } }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => upstream.close(() => resolve())))
  const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`

  const { ctx, credentials, mutations, disposers } = fakeContext()
  credentials.set('K', 'secret')
  t.after(async () => { for (const dispose of disposers) await dispose() })
  apply(ctx, Config({ endpoints: [{ name: 'primary', baseURL, apiKeyEnv: 'K', budgetLimit: 50 }] }))

  const published = () => mutations.find(entry =>
    entry.ns === 'dsh-api-pool' && entry.ops[0]?.path.join('.') === 'observed')
  assert.equal(await waitFor(() => published() !== undefined), true,
    'the settings page can never enforce the limit while the caps stay unpublished')
  assert.deepEqual(published().ops[0].value, { primary: { maxBudget: 100 } })
})
