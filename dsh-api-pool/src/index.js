/**
 * dsh-api-pool — a multi-endpoint, quota-aware API pool for DeepSeek Harness.
 *
 * The plugin registers a loopback OpenAI-compatible relay and publishes it as
 * the provider route `deepseek-pool` through the `llm-pi-ai` settings
 * namespace, so the provider and its models (default `deepseek-flash`) appear
 * in the harness's provider/model pickers and in Settings. Endpoints are
 * managed from the "API Pool" settings page the browser half contributes.
 *
 * @module dsh-api-pool
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, plainConfig, resolvePoolConfig, normalizeModels } from './config.js'
import { ApiPool, StateStore } from './pool/pool.js'
import { EventLog } from './pool/events.js'
import { Relay } from './relay.js'
import { buildProviderProfile, ensureProviderProfile, removeProviderProfile, PROVIDER_ID_PATTERN } from './provider.js'

export { Config } from './config.js'

export const name = 'dsh-api-pool'
export const inject = ['settings']

/** Credential reference the relay token is stored under. */
export const RELAY_TOKEN_REF = 'DSH_API_POOL_LOCAL_KEY'

/** The `llm-pi-ai` settings namespace, where provider profiles live. */
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
    config: undefined,
    exposedId: undefined,
    wantExposure: false,
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

  /** Advertise (or withdraw) the pool route through llm-pi-ai. */
  async function syncExposure() {
    const settings = ctx.get('settings')
    if (settings === undefined) return
    const providerId = runtime.config.providerId
    const wanted = runtime.wantExposure && PROVIDER_ID_PATTERN.test(providerId)
    if (!wanted) {
      if (runtime.exposedId !== undefined) await removeProviderProfile(settings, { providerId: runtime.exposedId })
      runtime.exposedId = undefined
      return
    }
    if (runtime.exposedId !== undefined && runtime.exposedId !== providerId) {
      await removeProviderProfile(settings, { providerId: runtime.exposedId })
      runtime.exposedId = undefined
    }
    const profile = buildProviderProfile({
      baseURL: `${runtime.relay.url}${runtime.config.basePath}`,
      models: runtime.config.models,
      api: runtime.config.api,
      apiKeyEnv: RELAY_TOKEN_REF,
      displayName: runtime.config.displayName,
      reasoning: runtime.config.reasoning,
      thinkingFormat: runtime.config.thinkingFormat,
      contextWindow: runtime.config.contextWindow,
      maxTokens: runtime.config.maxTokens,
    })
    await ensureProviderProfile(settings, { ns: PROVIDER_SETTINGS_NS, providerId, profile })
    runtime.exposedId = providerId
  }

  /** Rebuild the pool from current config, starting the relay on first use. */
  async function rebuild() {
    const plain = plainConfig(config)
    const models = normalizeModels(plain.models)
    runtime.config = resolvePoolConfig(plain, {
      events,
      fetchImpl: fetch,
      models,
      basePath: plain.basePath ?? '/v1',
      providerId: plain.providerId ?? 'deepseek-pool',
      displayName: plain.displayName ?? 'API Pool',
      api: plain.api ?? 'openai-completions',
      reasoning: plain.reasoning ?? 'high',
      thinkingFormat: plain.thinkingFormat ?? 'deepseek',
      contextWindow: plain.contextWindow ?? 1_000_000,
      maxTokens: plain.maxTokens ?? 65_536,
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
      runtime.relay = new Relay({
        pool: runtime.pool,
        token,
        basePath: runtime.config.basePath,
        models,
        logger: ctx.logger,
      })
      await runtime.relay.listen(0)
      ctx.logger.info(`api-pool: relay listening on ${runtime.relay.url}${runtime.config.basePath} (token ${tokenFingerprint(token)})`)
    } else {
      runtime.relay.pool = runtime.pool
      runtime.relay.basePath = runtime.config.basePath
      runtime.relay.models = models
    }

    runtime.wantExposure = runtime.config.enabled && plain.exposeProvider !== false
    try {
      await syncExposure()
    } catch (error) {
      runtime.wantExposure = false
      runtime.exposedId = undefined
      ctx.logger.error(
        `api-pool: could not expose provider "${runtime.config.providerId}"; is the "${PROVIDER_SETTINGS_NS}" plugin installed and is its providers section writable?`,
      )
      ctx.logger.error(error)
    }
    if (runtime.config.endpoints.length === 0) {
      ctx.logger.warn('api-pool: no endpoints configured yet; open Settings → API Pool to add one')
    } else {
      ctx.logger.info(`api-pool: ${runtime.config.endpoints.length} endpoint(s), strategy=${runtime.config.strategy}, provider=${runtime.config.providerId}`)
    }
  }

  /** Store the relay token so `llm-pi-ai` can present it. */
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
        if (runtime.relay !== undefined) lines.push(`  relay: ${runtime.relay.url}${pool.config.basePath}`)
        return { kind: 'success', text: lines.join('\n') }
      },
    }), 'api-pool: status command')
  })

  ctx.effect(() => async () => {
    const settings = ctx.get('settings')
    if (settings !== undefined && runtime.exposedId !== undefined) {
      await removeProviderProfile(settings, { ns: PROVIDER_SETTINGS_NS, providerId: runtime.exposedId })
    }
    await runtime.relay?.close()
    store.save(runtime.pool?.state)
  }, 'api-pool: withdraw route and stop relay')
}
