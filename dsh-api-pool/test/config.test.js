import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Config, plainConfig, resolvePoolConfig, normalizeEndpoints, validBaseURL } from '../src/config.js'
import { buildProviderProfile, PROVIDER_ID_PATTERN } from '../src/provider.js'
import { BASE_PATH, PROVIDER_ID, PROVIDER_MODELS, PROVIDER_SETTINGS_NS, RELAY_PORT, RELAY_TOKEN_REF } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePatch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')

test('defaults are a least-loaded pool with no endpoints', () => {
  const plain = plainConfig(Config({}))
  assert.equal(plain.enabled, true)
  assert.equal(plain.strategy, 'least_loaded')
  assert.deepEqual(plain.endpoints, [])
  const resolved = resolvePoolConfig(plain)
  assert.deepEqual(resolved.endpoints, [])
  assert.equal(resolved.rpmWindowMs, 60_000)
  assert.equal(resolved.maxCooldownMs, 3_600_000)
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

test('the exposed profile shape points at the relay and advertises the model', () => {
  const profile = buildProviderProfile({
    baseURL: `http://127.0.0.1:${RELAY_PORT}${BASE_PATH}`,
    models: [...PROVIDER_MODELS],
    apiKeyEnv: RELAY_TOKEN_REF,
  })
  assert.equal(profile.api, 'openai-completions')
  assert.equal(profile.baseURL, 'http://127.0.0.1:8765/v1')
  assert.equal(profile.apiKeyEnv, 'DSH_API_POOL_LOCAL_KEY')
  assert.deepEqual(profile.models.map(model => model.id), ['deepseek-flash'])
  assert.deepEqual(profile.models[0].input, ['text', 'image'])
  assert.deepEqual(profile.models[0].compat, { thinkingFormat: 'deepseek' })
})

test('the bundle patch declares exactly the profile the code builds', () => {
  // Drift guard: the provider profile lives in the patch, the relay in code,
  // and the two must name the same route, URL, credential and model.
  assert.match(bundlePatch, /- id: dsh-api-pool\n\s+name: dsh-api-pool/)
  assert.match(bundlePatch, new RegExp(`- id: ${PROVIDER_SETTINGS_NS}`))
  assert.match(bundlePatch, new RegExp(`${PROVIDER_ID}:`))
  assert.match(bundlePatch, /displayName: API Pool/)
  assert.match(bundlePatch, new RegExp(`baseURL: http://127\\.0\\.0\\.1:${RELAY_PORT}${BASE_PATH.replace('/', '\\/')}`))
  assert.match(bundlePatch, new RegExp(`apiKeyEnv: ${RELAY_TOKEN_REF}`))
  for (const model of PROVIDER_MODELS) assert.match(bundlePatch, new RegExp(`- id: ${model}\\b`))

  const declared = buildProviderProfile({
    baseURL: `http://127.0.0.1:${RELAY_PORT}${BASE_PATH}`,
    models: [...PROVIDER_MODELS],
    apiKeyEnv: RELAY_TOKEN_REF,
  })
  assert.equal(declared.displayName, /displayName: (.+)/.exec(bundlePatch)[1].trim())
  assert.equal(declared.api, /api: (\S+)/.exec(bundlePatch)[1])
})
