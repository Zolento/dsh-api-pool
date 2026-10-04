import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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
  function recordEffect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'settings') return { mutate: async (ns, ops) => { mutations.push({ ns, ops }) } }
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
      if (names.includes('commands')) callback({ commands: { register: () => () => {} }, effect: recordEffect })
    },
    effect: recordEffect,
  }
  return { ctx, credentials, mutations, listeners, disposers }
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

  // The token is stored so the declared provider profile can present it.
  assert.equal(credentials.has(RELAY_TOKEN_REF), true)
  // The provider profile is declarative: the plugin writes no settings at all.
  assert.deepEqual(mutations, [])
  // The advertised model list comes from the bundle's profile.
  const models = await (await fetch(`http://127.0.0.1:${RELAY_PORT}${BASE_PATH}/models`, {
    headers: { authorization: `Bearer ${credentials.get(RELAY_TOKEN_REF)}` },
  })).json()
  assert.deepEqual(models.data.map(model => model.id), ['deepseek-flash'])
})

test('disposal stops the relay this process owns', async (t) => {
  withHome(t)
  const { ctx, disposers } = fakeContext()
  apply(ctx, Config({ endpoints: [{ name: 'primary', baseURL: 'https://primary.example/v1', apiKeyEnv: 'K' }] }))

  assert.equal(await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`, { signal: AbortSignal.timeout(500) })).ok } catch { return false }
  }), true)

  for (const dispose of disposers) await dispose()
  await assert.rejects(() => fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`, { signal: AbortSignal.timeout(500) }))
})
