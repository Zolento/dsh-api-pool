import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeQuota, rootURL } from '../src/pool/quota.js'

/** Fake LiteLLM-compatible `/key/info` and `/user/info` responses. */
function fakeFetch({ key, user }) {
  return async (url) => ({
    ok: true,
    json: async () => (url.endsWith('/key/info') ? key : user),
  })
}

const spec = { name: 'ustc-1', baseURL: 'https://api.llm.ustc.edu.cn/v1' }

test('rootURL strips /v1 and the trailing slash', () => {
  assert.equal(rootURL('https://api.llm.ustc.edu.cn/v1'), 'https://api.llm.ustc.edu.cn')
  assert.equal(rootURL('https://api.llm.ustc.edu.cn/v1/'), 'https://api.llm.ustc.edu.cn')
})

test('a key-level budget binds, even when the user ratio looks worse', async () => {
  const discovered = await probeQuota(spec, 'k', {
    fetchImpl: fakeFetch({
      key: { info: { spend: 40, max_budget: 100, budget_duration: '24h', budget_reset_at: '2026-10-04T16:00:00Z', rpm_limit: 20 } },
      user: { user_info: { spend: 98, max_budget: 100, rpm_limit: 2147483647 } },
    }),
  })
  assert.equal(discovered.quotaSource, 'key')
  assert.equal(discovered.spend, 40)
  assert.equal(discovered.maxBudget, 100)
  assert.equal(discovered.rpmLimit, 20, 'RPM is the strictest key below the unlimited sentinel')
})

test('a key with no budget falls back to the user record (the real proxy case)', async () => {
  const discovered = await probeQuota(spec, 'k', {
    fetchImpl: fakeFetch({
      // Exactly what this proxy returns for USTC_1_API_KEY: the key carries a
      // lifetime spend but no budget; the enforced budget is on the user.
      key: { info: { spend: 1281.8, max_budget: null, rpm_limit: 20 } },
      user: { user_info: { spend: 89.26, max_budget: 100, budget_duration: '24h', budget_reset_at: '2026-10-04T16:00:00Z', rpm_limit: 2147483647 } },
    }),
  })
  assert.equal(discovered.quotaSource, 'user')
  assert.equal(discovered.spend, 89.26, 'the key lifetime spend must not be paired with the user budget')
  assert.equal(discovered.maxBudget, 100)
  assert.equal(discovered.rpmLimit, 20)
})

test('nothing discoverable yields undefined', async () => {
  const discovered = await probeQuota(spec, 'k', {
    fetchImpl: fakeFetch({ key: { info: { spend: 1 } }, user: { user_info: { spend: 2 } } }),
  })
  assert.equal(discovered, undefined)
})

test('a forced refresh probes past the throttle window', async () => {
  let calls = 0
  const fetchImpl = async (url) => {
    calls += 1
    return { ok: true, json: async () => (url.endsWith('/key/info') ? { info: { spend: 1, max_budget: 100, rpm_limit: 20 } } : {}) }
  }
  const { refreshQuotas } = await import('../src/pool/quota.js')
  const { emptyState } = await import('../src/pool/state.js')
  const state = emptyState()
  const config = { quotaEnabled: true, quotaRefreshMs: 300_000, quotaProbeTimeoutMs: 1000, fetchImpl, onEvent: undefined }
  const specs = [{ name: 'a', baseURL: 'https://api.example/v1', apiKey: 'k', enabled: true }]
  const resolveKey = async () => 'k'

  await refreshQuotas(specs, state, resolveKey, config, 1000, false)
  const afterFirst = calls
  await refreshQuotas(specs, state, resolveKey, config, 1001, false)
  assert.equal(calls, afterFirst, 'a throttled call must not probe')

  await refreshQuotas(specs, state, resolveKey, config, 1002, true)
  assert.equal(calls, afterFirst + 2, 'a forced call probes both records')
})
