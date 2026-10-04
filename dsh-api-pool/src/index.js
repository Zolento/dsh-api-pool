/**
 * dsh-api-pool — a multi-endpoint, quota-aware API pool for DeepSeek Harness.
 *
 * The bundle declares the provider route `deepseek-pool` ("API Pool") in the
 * `llm-pi-ai` namespace ([cordis.patch.yml](../cordis.patch.yml)), and this host
 * half runs the loopback relay that profile points at. Requests from the
 * harness reach the relay in OpenAI-compatible form, and the relay applies the
 * pool: pick an endpoint, forward, classify a failure, cool the endpoint down,
 * and retry the same request on the next one when nothing was streamed yet.
 *
 * Endpoints and pool tuning live in this plugin's own settings section, which
 * the browser half renders as the "API Pool" page.
 *
 * @module dsh-api-pool
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, plainConfig, resolvePoolConfig } from './config.js'
import { ApiPool, StateStore } from './pool/pool.js'
import { EventLog } from './pool/events.js'
import { Relay } from './relay.js'

export { Config } from './config.js'

export const name = 'dsh-api-pool'
export const inject = ['settings']

/** The provider route the bundle declares. Mirrored by `PROVIDER_MODELS`. */
export const PROVIDER_ID = 'deepseek-pool'
/** Models the bundle's provider profile advertises. */
export const PROVIDER_MODELS = Object.freeze(['deepseek-flash'])
/** Loopback port the bundle's provider profile points at (override only for tests/ops). */
export const RELAY_PORT = Number(process.env.DSH_API_POOL_PORT ?? 8765)
/** Path prefix the bundle's provider profile uses. */
export const BASE_PATH = '/v1'
/** Credential reference the relay token is stored under. */
export const RELAY_TOKEN_REF = 'DSH_API_POOL_LOCAL_KEY'
/** The `llm-pi-ai` settings namespace, where the provider profile lives. */
export const PROVIDER_SETTINGS_NS = 'llm-pi-ai'

/** Plugin-owned runtime directory under the harness home. */
export function stateDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'api-pool')
}

/** Read or create the per-installation relay token. */
function relayToken(dir) {
  const file = join(dir, 'relay-token')
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length >= 32) return existing
    }
  } catch { /* regenerate below */ }
  const token = randomBytes(24).toString('hex')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `${token}\n`, { mode: 0o600 })
  } catch { /* the in-memory token still protects this boot */ }
  return token
}

/** Short non-secret label for a token, used in logs. */
function tokenFingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 8)
}

/**
 * Whether another dsh-api-pool process already serves the fixed relay port.
 * Two instances of the harness (web plus headless) share one provider profile,
 * so the first one to start owns the relay and the others reuse it.
 * @returns {Promise<boolean>} true when an existing relay answers for us.
 */
async function relayAlreadyServing(token) {
  try {
    const response = await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`, { signal: AbortSignal.timeout(1000) })
    if (!response.ok) return false
    const body = await response.json()
    if (body?.provider !== 'dsh-api-pool') return false
    // Prove it is ours by presenting the shared token against the model list.
    const authed = await fetch(`http://127.0.0.1:${RELAY_PORT}${BASE_PATH}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1000),
    })
    return authed.ok
  } catch {
    return false
  }
}

/**
 * Install the API pool.
 * @param {object} ctx harness plugin context.
 * @param {object} config validated plugin config.
 */
export function apply(ctx, config) {
  const dir = stateDir()
  const token = relayToken(dir)
  const events = new EventLog({
    logFile: join(dir, 'api-pool.log'),
    eventsFile: join(dir, 'api-pool-events.jsonl'),
    logger: ctx.logger,
    logSuccesses: plainConfig(config).logSuccesses === true,
  })
  const store = new StateStore(join(dir, 'state.json'))

  /** Live runtime, rebuilt on every configuration change. */
  const runtime = {
    pool: undefined,
    relay: undefined,
    ownsRelay: false,
    config: undefined,
    keyCache: new Map(),
  }

  /** Resolve one endpoint's API key: inline -> environment -> credentials service. */
  async function resolveKey(spec) {
    if (spec.apiKey !== undefined) return spec.apiKey
    const ref = spec.apiKeyEnv
    if (ref === undefined) return undefined
    const cached = runtime.keyCache.get(ref)
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.value
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) {
      runtime.keyCache.set(ref, { at: Date.now(), value: ambient })
      return ambient
    }
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        runtime.keyCache.set(ref, { at: Date.now(), value: hit.value })
        return hit.value
      }
    }
    throw new Error(`no credential for endpoint "${spec.name}": export ${ref} or store it in Settings → Models`)
  }

  /** Rebuild the pool from current config; start (or reuse) the relay once. */
  async function rebuild() {
    const plain = plainConfig(config)
    runtime.config = resolvePoolConfig(plain, {
      events,
      fetchImpl: fetch,
      models: [...PROVIDER_MODELS],
    })
    events.logSuccesses = plain.logSuccesses === true

    runtime.pool = new ApiPool({
      config: runtime.config,
      state: runtime.pool?.state ?? store.load(),
      store,
      events,
      resolveKey,
    })

    if (runtime.relay === undefined) {
      if (await relayAlreadyServing(token)) {
        // Another harness process owns the relay; this one shares its state
        // through the same settings document and does not fight for the port.
        runtime.relay = new Relay({ pool: runtime.pool, token, basePath: BASE_PATH, models: [...PROVIDER_MODELS], logger: ctx.logger })
        ctx.logger.info(`api-pool: reusing the relay already listening on http://127.0.0.1:${RELAY_PORT}${BASE_PATH}`)
      } else {
        const relay = new Relay({ pool: runtime.pool, token, basePath: BASE_PATH, models: [...PROVIDER_MODELS], logger: ctx.logger })
        try {
          await relay.listen(RELAY_PORT)
          runtime.relay = relay
          runtime.ownsRelay = true
          ctx.logger.info(`api-pool: relay listening on ${relay.url}${BASE_PATH} (token ${tokenFingerprint(token)})`)
        } catch (error) {
          ctx.logger.error(`api-pool: could not bind 127.0.0.1:${RELAY_PORT}; the declared provider profile points there. ${String(error)}`)
        }
      }
    } else {
      runtime.relay.pool = runtime.pool
    }

    if (runtime.config.endpoints.length === 0) {
      ctx.logger.warn('api-pool: no endpoints configured yet; open Settings → API Pool to add one')
    } else {
      ctx.logger.info(`api-pool: ${runtime.config.endpoints.length} endpoint(s), strategy=${runtime.config.strategy}, provider=${PROVIDER_ID}`)
    }
  }

  /** Store the relay token so the declared provider profile can present it. */
  async function syncToken() {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      ctx.logger.warn(`api-pool: no credentials service; relay token is not stored under ${RELAY_TOKEN_REF}`)
      return
    }
    try {
      const current = await credentials.resolve(RELAY_TOKEN_REF)
      if (current?.value !== token) await credentials.set(RELAY_TOKEN_REF, token)
    } catch (error) {
      ctx.logger.warn(`api-pool: could not store the relay token: ${String(error)}`)
    }
  }

  void (async () => {
    await syncToken()
    await rebuild().catch((error) => {
      ctx.logger.error('api-pool: initial startup failed')
      ctx.logger.error(error)
    })
  })()

  // Settings edits arrive as a volatile update; rebuild without a restart.
  ctx.on('loader/volatile-update', () => {
    void rebuild().catch((error) => {
      ctx.logger.error('api-pool: rebuild after configuration change failed')
      ctx.logger.error(error)
    })
  })

  // A `/api-pool` command surfaces live endpoint health inside the chat.
  ctx.inject(['commands'], (child) => {
    child.effect(() => child.commands.register({
      name: 'api-pool',
      description: 'Show dsh-api-pool endpoint health',
      handler: () => {
        const pool = runtime.pool
        if (pool === undefined) return { kind: 'success', text: 'api-pool: still starting' }
        const lines = [`dsh-api-pool — ${pool.specs.length} endpoint(s), strategy=${pool.config.strategy}`]
        for (const row of pool.status()) {
          const quota = row.spend !== undefined && row.maxBudget !== undefined
            ? ` spend=$${row.spend}/$${row.maxBudget}`
            : ''
          const rpm = row.rpmLimit === undefined ? `${row.recent}` : `${row.recent}/${row.rpmLimit}`
          lines.push(`  ${row.name}  ${row.state}  rpm=${rpm}${quota}${row.lastErrorKind === undefined ? '' : `  last=${row.lastErrorKind}`}`)
        }
        if (runtime.ownsRelay) lines.push(`  relay: http://127.0.0.1:${RELAY_PORT}${BASE_PATH} (owned by this process)`)
        else lines.push(`  relay: http://127.0.0.1:${RELAY_PORT}${BASE_PATH} (shared)`)
        return { kind: 'success', text: lines.join('\n') }
      },
    }), 'api-pool: status command')
  })

  ctx.effect(() => async () => {
    if (runtime.ownsRelay) await runtime.relay?.close()
    store.save(runtime.pool?.state)
  }, 'api-pool: stop the relay this process owns')
}
