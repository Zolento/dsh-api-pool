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
import { buildProviderProfile, ensureProviderProfile, jsonEqual, removeProviderProfile, storedProfile } from './provider.js'

export { Config } from './config.js'

export const name = 'dsh-api-pool'
export const inject = ['settings']

/** The provider route the plugin publishes into the `llm-pi-ai` namespace. */
export const PROVIDER_ID = 'deepseek-pool'
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

/** Human-readable duration for status output (`45s`, `3m20s`, `1h5m`). */
function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'never'
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m`
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
  // Captured at apply time: re-resolving it during disposal can return
  // undefined once the registry is torn down, which would silently leave the
  // published provider profile behind in the user's settings document.
  const settingsService = ctx.get('settings')
  if (settingsService === undefined) {
    ctx.logger.warn('api-pool: this composition has no settings service; the API Pool provider profile cannot be published')
  }

  /** Live runtime, rebuilt on every configuration change. */
  const runtime = {
    pool: undefined,
    relay: undefined,
    ownsRelay: false,
    // Set when REPLAY_PORT is held by a process that is not ours; the port is
    // then neither owned nor shared, and the status surface must say so.
    bindFailed: false,
    config: undefined,
    exposedId: undefined,
    syncing: false,
    quotaPrimed: false,
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
    let credentials = ctx.get('credentials')
    // During startup the service may not be visible to this fiber yet; a brief
    // wait is what lets the very first quota probe succeed instead of reading
    // nothing and deferring the window figures by a whole retry interval.
    for (let attempt = 0; attempt < 20 && credentials === undefined; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      credentials = ctx.get('credentials')
    }
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        runtime.keyCache.set(ref, { at: Date.now(), value: hit.value })
        return hit.value
      }
    }
    throw new Error(`no credential for endpoint "${spec.name}": export ${ref} or store it in Settings → Models`)
  }

  /** Publish (or withdraw) the pool route in the `llm-pi-ai` namespace. */
  async function syncExposure() {
    // One write at a time: overlapping reconciliations could otherwise both
    // read a stale profile and both write.
    if (runtime.syncing) return
    runtime.syncing = true
    try {
      await syncExposureOnce()
    } finally {
      runtime.syncing = false
    }
  }

  async function syncExposureOnce() {
    const settings = settingsService
    if (settings === undefined) return
    if (!runtime.config.enabled) {
      if (runtime.exposedId !== undefined) {
        await removeProviderProfile(settings, { ns: PROVIDER_SETTINGS_NS, providerId: runtime.exposedId }, ctx.logger)
        runtime.exposedId = undefined
      }
      return
    }
    const providerId = PROVIDER_ID
    const profile = buildProviderProfile({
      baseURL: `http://127.0.0.1:${RELAY_PORT}${BASE_PATH}`,
      models: runtime.config.models,
      api: runtime.config.api,
      apiKeyEnv: RELAY_TOKEN_REF,
      displayName: 'API Pool',
      reasoning: runtime.config.reasoning,
      thinkingFormat: runtime.config.thinkingFormat,
      contextWindow: runtime.config.contextWindow,
      maxTokens: runtime.config.maxTokens,
    })
    // Skip an identical write: this document is the live profile, so a no-op
    // write would chase its own settings-update event.
    if (jsonEqual(storedProfile(settings, PROVIDER_SETTINGS_NS, providerId), profile)) {
      runtime.exposedId = providerId
      return
    }
    await ensureProviderProfile(settings, { ns: PROVIDER_SETTINGS_NS, providerId, profile })
    runtime.exposedId = providerId
  }

  /** Rebuild the pool from current config; start (or reuse) the relay once. */
  async function rebuild() {
    const plain = plainConfig(config)
    runtime.config = resolvePoolConfig(plain, {
      events,
      fetchImpl: fetch,
      onEvent: (name, fields) => events.emit(name, fields),
    })
    events.logSuccesses = plain.logSuccesses === true
    runtime.config.api = plain.api ?? 'openai-completions'
    runtime.config.reasoning = plain.reasoning ?? 'high'
    runtime.config.thinkingFormat = plain.thinkingFormat ?? 'deepseek'
    runtime.config.contextWindow = plain.contextWindow ?? 1_000_000
    runtime.config.maxTokens = plain.maxTokens ?? 65_536
    const models = runtime.config.models

    // Cancel the previous pool's pending coalesced save before swapping.
    runtime.pool?.flush()
    runtime.pool = new ApiPool({
      config: runtime.config,
      state: runtime.pool?.state ?? store.load(),
      store,
      events,
      resolveKey,
    })

    // Probe once at startup, past the throttle: persisted quota may have been
    // written by an older build (or by another process) and must not keep a
    // healthy endpoint disabled until the next scheduled refresh.
    if (!runtime.quotaPrimed) {
      runtime.quotaPrimed = true
      const pool = runtime.pool
      void (async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await pool.refreshQuotas(true).catch((error) => {
            ctx.logger.warn(`api-pool: startup quota probe failed: ${String(error)}`)
          })
          if (pool.hasQuotaHints()) return
          ctx.logger.warn(`api-pool: startup quota probe found no budget data (attempt ${attempt}/3); retrying`)
          await new Promise(resolve => setTimeout(resolve, 5000))
        }
      })()
    }

    if (runtime.relay === undefined) {
      if (await relayAlreadyServing(token)) {
        // Another harness process owns the relay; this one shares its state
        // through the same settings document and does not fight for the port.
        runtime.relay = new Relay({ pool: runtime.pool, token, basePath: BASE_PATH, models, logger: ctx.logger })
        ctx.logger.info(`api-pool: reusing the relay already listening on http://127.0.0.1:${RELAY_PORT}${BASE_PATH}`)
      } else {
        const relay = new Relay({ pool: runtime.pool, token, basePath: BASE_PATH, models, logger: ctx.logger })
        try {
          await relay.listen(RELAY_PORT)
          runtime.relay = relay
          runtime.ownsRelay = true
          ctx.logger.info(`api-pool: relay listening on ${relay.url}${BASE_PATH} (token ${tokenFingerprint(token)})`)
        } catch (error) {
          runtime.bindFailed = true
          ctx.logger.error(
            `api-pool: could not bind 127.0.0.1:${RELAY_PORT} — another process holds it and does not accept this`
            + ` instance's relay token, so this pool cannot serve requests. ${String(error)}`,
          )
        }
      }
    } else {
      runtime.relay.pool = runtime.pool
      runtime.relay.models = models
    }

    try {
      await syncExposure()
    } catch (error) {
      ctx.logger.error(`api-pool: could not publish provider "${PROVIDER_ID}" through the "${PROVIDER_SETTINGS_NS}" settings namespace`)
      ctx.logger.error(error)
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

  // Another writer (a settings edit, a profile reload, or a hand edit) can drop
  // the provider profile; re-assert it. The write is skipped when the stored
  // profile already matches, so this cannot feed back into its own trigger.
  const reconcile = () => {
    if (runtime.config === undefined) return
    void syncExposure().catch((error) => {
      ctx.logger.warn(`api-pool: could not re-assert the provider profile: ${String(error)}`)
    })
  }
  ctx.on('settings/document-updated', reconcile)
  ctx.on('app-boot/config-reload', reconcile)

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
          const window = Number.isFinite(row.spend) && Number.isFinite(row.maxBudget) && row.maxBudget > 0
            ? ` window=$${row.spend.toFixed(2)}/$${row.maxBudget}`
            : ''
          const rpm = row.rpmLimit === undefined ? `${row.recent}` : `${row.recent}/${row.rpmLimit}`
          lines.push(`  ${row.name}  ${row.state}  rpm=${rpm}${window}${row.lastErrorKind === undefined ? '' : `  last=${row.lastErrorKind}`}`)
        }
        const capacity = pool.availability()
        lines.push(`  capacity: ${capacity.ready}/${capacity.enabled} ready now`)
        if (capacity.blocked) {
          lines.push(capacity.next === undefined
            ? '  blocked: every endpoint is permanently disabled (fix the credential or re-enable the endpoint)'
            : `  blocked: no endpoint available — waiting for ${capacity.next.name} to recover in ${formatDuration(capacity.next.inMs)}`
              + ` (${capacity.next.reason}${capacity.next.lastErrorKind === undefined ? '' : `, last=${capacity.next.lastErrorKind}`})`)
        } else if (capacity.next !== undefined) {
          lines.push(`  next recovery: ${capacity.next.name} in ${formatDuration(capacity.next.inMs)} (${capacity.next.reason})`)
        }
        if (capacity.permanentlyDisabled.length > 0) {
          lines.push(`  permanently disabled: ${capacity.permanentlyDisabled.join(', ')}`)
        }
        lines.push(runtime.ownsRelay
          ? `  relay: http://127.0.0.1:${RELAY_PORT}${BASE_PATH} (owned by this process)`
          : runtime.bindFailed
            ? `  relay: http://127.0.0.1:${RELAY_PORT}${BASE_PATH} (unavailable — the port is held by another process; this pool cannot serve)`
            : `  relay: http://127.0.0.1:${RELAY_PORT}${BASE_PATH} (shared)`)
        return { kind: 'success', text: lines.join('\n') }
      },
    }), 'api-pool: status command')
  })

  ctx.effect(() => async () => {
    const settings = settingsService
    if (settings !== undefined && runtime.exposedId !== undefined) {
      await removeProviderProfile(settings, { ns: PROVIDER_SETTINGS_NS, providerId: runtime.exposedId }, ctx.logger)
    }
    if (runtime.ownsRelay) await runtime.relay?.close()
    // Writes the coalesced state immediately (see ApiPool.persist).
    runtime.pool?.flush()
  }, 'api-pool: withdraw the provider profile and stop the relay this process owns')
}
