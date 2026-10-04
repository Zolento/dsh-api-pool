/**
 * Provider exposure through the `llm-pi-ai` settings namespace.
 *
 * DSH's published packages ship only their compiled entry points, so an
 * out-of-tree plugin cannot construct a `ResolvedPiAiProviderProfile` or reuse
 * the pi-ai adapter's translation internals. What it *can* do — through the
 * public settings seam — is declare a provider profile in the `llm-pi-ai`
 * namespace. `llm-pi-ai` then serves that route with its own adapter, exactly
 * as it serves the user's hand-written `ustc` routes. The profile points at the
 * loopback relay, so the pool sits in front of the real endpoints.
 */

/** A route id usable as a settings key and as the stem of a credential name. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Build one `llm-pi-ai` provider profile for the relay.
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

/**
 * Upsert the relay's provider profile into the `llm-pi-ai` settings namespace.
 *
 * @param {object} settings `ctx.settings` (SettingsForms).
 * @param {object} options
 * @returns {Promise<boolean>} whether the profile is now stored.
 */
export async function ensureProviderProfile(settings, { ns = 'llm-pi-ai', providerId, profile }) {
  try {
    await settings.mutate(ns, [{ op: 'set', path: ['providers', providerId], value: profile }])
    return true
  } catch (error) {
    error.providerExposureNs = ns
    throw error
  }
}

/** Remove the relay's provider profile, leaving every other route untouched. */
export async function removeProviderProfile(settings, { ns = 'llm-pi-ai', providerId }) {
  try {
    await settings.mutate(ns, [{ op: 'unset', path: ['providers', providerId] }])
    return true
  } catch {
    return false
  }
}
