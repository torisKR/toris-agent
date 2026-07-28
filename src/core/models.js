import { TorisError } from './errors.js';

/**
 * Model profile resolution.
 *
 * A *profile* is a logical name ("claude:opus") that the user maps to a real
 * provider and model in their config. Product code never hardcodes model IDs:
 * roles point at profiles, profiles point at models, and the user owns that
 * mapping. Swapping a model is a config edit, not a code change.
 *
 * @typedef {{profile:string, provider:string, model:string, reasoning:string|null, maxTokens:number|null}} ResolvedModel
 */

/** Providers that toris talks to over HTTP itself. */
export const API_PROVIDERS = Object.freeze(['anthropic', 'openai']);

/** Providers that toris drives by spawning an installed agent CLI. */
export const CLI_PROVIDERS = Object.freeze(['claude-cli', 'codex-cli']);

/** Sentinel meaning "let the provider runtime choose"; never substituted. */
export const AUTO_MODEL = 'auto';

/** @param {any} config */
export const listProfiles = (config) => Object.keys(config?.models?.profiles ?? {});

/**
 * Resolve a profile name to a concrete provider/model pair.
 * @param {string} name
 * @param {any} config
 * @returns {ResolvedModel}
 */
export function resolveProfile(name, config) {
  if (!name || typeof name !== 'string') {
    throw new TorisError('A model profile name is required.', 'E_UNKNOWN_PROFILE');
  }
  const entry = config?.models?.profiles?.[name];
  if (!entry) {
    const available = listProfiles(config);
    const hint = available.length > 0 ? available.join(', ') : '(none configured — run: toris init)';
    throw new TorisError(`Unknown model profile "${name}". Available: ${hint}`, 'E_UNKNOWN_PROFILE');
  }
  if (!entry.provider) {
    throw new TorisError(`Model profile "${name}" is missing "provider".`, 'E_UNKNOWN_PROFILE');
  }
  return Object.freeze({
    profile: name,
    provider: entry.provider,
    // 'auto' is meaningful: it defers to the provider runtime. Do not replace it
    // with a concrete ID here, or the "no pinned model IDs" rule breaks.
    model: entry.model ?? AUTO_MODEL,
    reasoning: entry.reasoning ?? null,
    maxTokens: typeof entry.maxTokens === 'number' ? entry.maxTokens : null,
  });
}

/**
 * Find a profile whose provider differs from `provider`.
 * Used for cross-provider review, where the reviewer must not be the implementer.
 * @param {string} provider
 * @param {any} config
 * @returns {ResolvedModel}
 */
export function resolveOppositeProvider(provider, config) {
  for (const name of listProfiles(config)) {
    const candidate = resolveProfile(name, config);
    if (candidate.provider !== provider) return candidate;
  }
  throw new TorisError(
    `No profile uses a provider other than "${provider}", so cross-provider review is impossible. ` +
      `Add a second profile with a different provider.`,
    'E_UNKNOWN_PROFILE',
  );
}

/**
 * Resolve the model for a role via config.models.routing.
 * `opposite-provider` is resolved relative to `opts.against`.
 * @param {string} role
 * @param {any} config
 * @param {{against?:string}} [opts]
 * @returns {ResolvedModel}
 */
export function resolveRole(role, config, opts = {}) {
  const routing = config?.models?.routing ?? {};
  const target = routing[role];
  if (!target) {
    const known = Object.keys(routing);
    const hint = known.length > 0 ? known.join(', ') : '(no routing configured)';
    throw new TorisError(
      `No model routing for role "${role}". Configured roles: ${hint}`,
      'E_UNKNOWN_PROFILE',
    );
  }
  if (target === 'opposite-provider') {
    if (!opts.against) {
      throw new TorisError(
        `Role "${role}" routes to opposite-provider, which needs the provider it must differ from.`,
        'E_UNKNOWN_PROFILE',
      );
    }
    return resolveOppositeProvider(opts.against, config);
  }
  return resolveProfile(target, config);
}

/**
 * Where a provider's credential comes from. Keys live in the environment, never
 * in config on disk, so a shared config file can never leak one.
 * @param {string} provider
 */
export const apiKeyEnvVar = (provider) =>
  ({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' })[provider] ?? null;

/**
 * @param {string} provider
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|null}
 */
export function readApiKey(provider, env = process.env) {
  const varName = apiKeyEnvVar(provider);
  if (!varName) return null;
  const value = env[varName];
  return value && value.trim() !== '' ? value : null;
}

/**
 * True when a resolved model can actually be invoked right now.
 * CLI-backed providers verify their own binary elsewhere, so they pass here.
 * @param {ResolvedModel} resolved
 * @param {Record<string,string|undefined>} [env]
 */
export function isInvokable(resolved, env = process.env) {
  if (!API_PROVIDERS.includes(resolved.provider)) return true;
  return readApiKey(resolved.provider, env) !== null;
}
