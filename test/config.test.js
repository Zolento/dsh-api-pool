import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, plainConfig, resolvePoolConfig, normalizeEndpoints, normalizeModels, validBaseURL } from '../src/config.js'
import { buildProviderProfile, jsonEqual, PROVIDER_ID_PATTERN } from '../src/provider.js'
import { BASE_PATH, RELAY_PORT, RELAY_TOKEN_REF } from '../src/index.js'

test('defaults are a least-loaded pool advertising deepseek-flash', () => {
  const plain = plainConfig(Config({}))
  assert.equal(plain.enabled, true)
  assert.equal(plain.strategy, 'least_loaded')
  assert.deepEqual(plain.endpoints, [])
  assert.deepEqual(plain.models, ['deepseek-flash'])
  const resolved = resolvePoolConfig(plain)
  assert.deepEqual(resolved.endpoints, [])
  assert.deepEqual(resolved.models, ['deepseek-flash'])
  assert.equal(resolved.rpmWindowMs, 60_000)
  assert.equal(resolved.maxCooldownMs, 3_600_000)
})

test('a configured endpoint survives resolution and invalid rows are dropped', () => {
  const plain = plainConfig(Config({
    endpoints: [
      { name: 'primary', baseURL: 'https://api.example.com/v1/', apiKeyEnv: 'PRIMARY_API_KEY' },
      { name: 'bad', baseURL: 'not a url' },
      { name: '', baseURL: 'https://x.example/v1' },
      { name: 'primary', baseURL: 'https://api.example.com/v1' },
      { name: 'secondary', baseURL: 'https://api.example.com/v1', apiKeyEnv: 'SECONDARY_API_KEY', priority: 2, rpmLimit: 20 },
    ],
  }))
  const endpoints = resolvePoolConfig(plain).endpoints
  assert.deepEqual(endpoints.map(endpoint => endpoint.name), ['primary', 'secondary'])
  assert.equal(endpoints[0].baseURL, 'https://api.example.com/v1')
  assert.equal(endpoints[0].priority, 100)
  assert.equal(endpoints[1].priority, 2)
  assert.equal(endpoints[1].rpmLimit, 20)
})

test('normalizeEndpoints trims and keeps an explicit disable', () => {
  const endpoints = normalizeEndpoints([{ name: ' a ', baseURL: 'https://a.example/v1', enabled: false }])
  assert.equal(endpoints[0].name, 'a')
  assert.equal(endpoints[0].enabled, false)
})

test('normalizeModels falls back to deepseek-flash and de-duplicates', () => {
  assert.deepEqual(normalizeModels([]), ['deepseek-flash'])
  assert.deepEqual(normalizeModels(['a', 'a', ' b ']), ['a', 'b'])
  assert.deepEqual(normalizeModels('deepseek-flash'), ['deepseek-flash'])
})

test('base URL validation rejects credentials, query and fragment', () => {
  assert.equal(validBaseURL('https://api.example.com/v1'), true)
  assert.equal(validBaseURL('https://user:pw@api.example.com/v1'), false)
  assert.equal(validBaseURL('https://api.example.com/v1?x=1'), false)
  assert.equal(validBaseURL('file:///tmp/x'), false)
})

test('provider ids must be settings/credential safe', () => {
  assert.equal(PROVIDER_ID_PATTERN.test('deepseek-pool'), true)
  assert.equal(PROVIDER_ID_PATTERN.test('1pool'), false)
  assert.equal(PROVIDER_ID_PATTERN.test('pool_1'), false)
})

test('the provider profile points at the relay and lists every configured model', () => {
  const profile = buildProviderProfile({
    baseURL: `http://127.0.0.1:${RELAY_PORT}${BASE_PATH}`,
    models: ['deepseek-flash', 'deepseek-flash-2'],
    apiKeyEnv: RELAY_TOKEN_REF,
  })
  assert.equal(profile.displayName, 'API Pool')
  assert.equal(profile.api, 'openai-completions')
  assert.equal(profile.baseURL, `http://127.0.0.1:${RELAY_PORT}${BASE_PATH}`)
  assert.equal(profile.apiKeyEnv, 'DSH_API_POOL_LOCAL_KEY')
  assert.deepEqual(profile.models.map(model => model.id), ['deepseek-flash', 'deepseek-flash-2'])
  assert.deepEqual(profile.models[0].input, ['text', 'image'])
  assert.deepEqual(profile.models[0].compat, { thinkingFormat: 'deepseek' })
})

test('jsonEqual drives the idempotent settings write', () => {
  assert.equal(jsonEqual({ a: [1, 2] }, { a: [1, 2] }), true)
  assert.equal(jsonEqual({ a: [1, 2] }, { a: [2, 1] }), false)
  assert.equal(jsonEqual(undefined, undefined), true)
})



test('budgetLimit survives normalization only when it is a usable cap', () => {
  const endpoints = normalizeEndpoints([
    { name: 'a', baseURL: 'https://a.example/v1', budgetLimit: 50 },
    { name: 'b', baseURL: 'https://b.example/v1', budgetLimit: 0 },
    { name: 'c', baseURL: 'https://c.example/v1', budgetLimit: 'lots' },
    { name: 'd', baseURL: 'https://d.example/v1' },
  ])
  assert.equal(endpoints[0].budgetLimit, 50)
  assert.equal(endpoints[1].budgetLimit, undefined)
  assert.equal(endpoints[2].budgetLimit, undefined)
  assert.equal(endpoints[3].budgetLimit, undefined)
})

test('the config accepts the observed map the plugin publishes', () => {
  const resolved = Config({ observed: { primary: { maxBudget: 100 } } })
  assert.deepEqual(plainConfig(resolved).observed, { primary: { maxBudget: 100 } })
})
