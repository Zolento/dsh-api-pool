/**
 * Provider-profile shape shared by the bundle patch and its drift test.
 *
 * The published DSH packages ship only their compiled entry points, so an
 * out-of-tree plugin cannot construct a `ResolvedPiAiProviderProfile` or reuse
 * the pi-ai adapter's translation internals. The provider profile therefore
 * lives declaratively in `cordis.patch.yml`, in the `llm-pi-ai` namespace, and
 * `llm-pi-ai` serves it with its own adapter. This module builds the same
 * profile in code so a test can prove the two never drift apart.
 */

/** A route id usable as a settings key and as the stem of a credential name. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Build the `llm-pi-ai` provider profile the bundle patch must declare.
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
