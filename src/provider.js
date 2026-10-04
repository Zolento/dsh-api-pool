/**
 * Provider exposure through the `llm-pi-ai` settings namespace.
 *
 * WHY THIS IS A RUNTIME WRITE, NOT A BUNDLE-PATCH DECLARATION: the loader
 * applies a patch entry's `config` as a replacement for that subtree, and a
 * profile that configures `llm-pi-ai` at all (the usual case) supplies its own
 * `providers` object in a later layer — which replaces anything a bundle
 * declared. So the pool route must be written into the *same* layer that owns
 * `llm-pi-ai.providers`, which is what the public settings seam does.
 *
 * The write is idempotent: it is skipped when the stored profile already
 * matches, so re-asserting it cannot feed back into the settings-update event
 * that triggered the re-assert. The relay URL is a fixed loopback port, so a
 * written profile never goes stale on the next boot.
 *
 * The published DSH packages ship only their compiled entry points, so this
 * plugin cannot construct a `ResolvedPiAiProviderProfile` or reuse the pi-ai
 * adapter's translation internals; declaring the profile and letting
 * `llm-pi-ai` serve it is the supported path.
 */

/** A route id usable as a settings key and as the stem of a credential name. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Build the `llm-pi-ai` provider profile for the relay.
 * @param {object} options
 * @returns {object} a JSON-serializable provider profile.
 */
export function buildProviderProfile({
  baseURL, models, api = 'openai-completions', apiKeyEnv, displayName = 'API Pool',
  reasoning = 'high', thinkingFormat = 'deepseek', contextWindow = 1_000_000, maxTokens = 65_536,
}) {
  return {
    displayName,
    reasoning,
    api,
    baseURL,
    ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
    models: models.map(id => ({
      id,
      name: id,
      input: ['text', 'image'],
      contextWindow,
      maxTokens,
      reasoningEfforts: { off: 'off', low: 'low', high: 'high', max: 'max' },
      ...thinkingFormat === '' ? {} : { compat: { thinkingFormat } },
    })),
  }
}

/** Structural JSON comparison, used to skip a no-op settings write. */
export function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Read the currently stored profile for one route from a live settings service.
 * @param {object} settings `ctx.settings`.
 * @returns {unknown|undefined} the stored profile, or undefined when absent.
 */
export function storedProfile(settings, ns, providerId) {
  try {
    const descriptor = settings.describe?.().find?.(row => row.ns === ns)
    return descriptor?.value?.providers?.[providerId]
  } catch {
    return undefined
  }
}

/**
 * Upsert the relay's provider profile into a settings namespace.
 * @returns {Promise<boolean>} whether the profile is now stored.
 */
export async function ensureProviderProfile(settings, { ns = 'llm-pi-ai', providerId, profile }) {
  await settings.mutate(ns, [{ op: 'set', path: ['providers', providerId], value: profile }])
  return true
}

/** Remove a provider profile, leaving every other route untouched. */
export async function removeProviderProfile(settings, { ns = 'llm-pi-ai', providerId }, logger) {
  try {
    await settings.mutate(ns, [{ op: 'unset', path: ['providers', providerId] }])
    return true
  } catch (error) {
    logger?.warn?.(`api-pool: could not remove provider profile "${providerId}" from "${ns}": ${String(error)}`)
    return false
  }
}
