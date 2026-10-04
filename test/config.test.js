import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, plainConfig, resolvePoolConfig, normalizeEndpoints, normalizeModels } from '../src/config.js'
import { buildProviderProfile, PROVIDER_ID_PATTERN } from '../src/provider.js'

test('defaults advertise deepseek-flash and a least-loaded pool', () => {
  const plain = plainConfig(Config({}))
  assert.deepEqual(plain.models, ['deepseek-flash'])
  assert.equal(plain.strategy, 'least_loaded')
  assert.equal(plain.providerId, 'deepseek-pool')
  assert.equal(plain.displayName, 'API Pool')
  assert.equal(plain.exposeProvider, true)
  const resolved = resolvePoolConfig(plain)
  assert.deepEqual(resolved.endpoints, [])
  assert.deepEqual(resolved.models, ['deepseek-flash'])
  assert.equal(resolved.rpmWindowMs, 60_000)
})

test('a configured endpoint survives resolution and invalid rows are dropped', () => {
  const plain = plainConfig(Config({
    endpoints: [
      { name: 'ustc', baseURL: 'https://api.llm.ustc.edu.cn/v1/', apiKeyEnv: 'USTC_API_KEY' },
      { name: 'bad', baseURL: 'not a url' },
      { name: '', baseURL: 'https://x.example/v1' },
      { name: 'ustc', baseURL: 'https://api.llm.ustc.edu.cn/v1' },
      { name: 'ustc-1', baseURL: 'https://api.llm.ustc.edu.cn/v1', apiKeyEnv: 'USTC_1_API_KEY', priority: 2, rpmLimit: 20 },
    ],
  }))
  const endpoints = resolvePoolConfig(plain).endpoints
  assert.deepEqual(endpoints.map(endpoint => endpoint.name), ['ustc', 'ustc-1'])
  assert.equal(endpoints[0].baseURL, 'https://api.llm.ustc.edu.cn/v1')
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

test('provider ids must be settings/credential safe', () => {
  assert.equal(PROVIDER_ID_PATTERN.test('deepseek-pool'), true)
  assert.equal(PROVIDER_ID_PATTERN.test('1pool'), false)
  assert.equal(PROVIDER_ID_PATTERN.test('pool_1'), false)
})

test('the exposed profile points at the relay and advertises configured models', () => {
  const profile = buildProviderProfile({
    baseURL: 'http://127.0.0.1:9999/v1',
    models: ['deepseek-flash', 'deepseek-flash-2'],
    apiKeyEnv: 'DSH_API_POOL_LOCAL_KEY',
    displayName: 'API Pool',
  })
  assert.equal(profile.api, 'openai-completions')
  assert.equal(profile.baseURL, 'http://127.0.0.1:9999/v1')
  assert.equal(profile.apiKeyEnv, 'DSH_API_POOL_LOCAL_KEY')
  assert.deepEqual(profile.models.map(model => model.id), ['deepseek-flash', 'deepseek-flash-2'])
  assert.deepEqual(profile.models[0].input, ['text', 'image'])
  assert.deepEqual(profile.models[0].compat, { thinkingFormat: 'deepseek' })
})
