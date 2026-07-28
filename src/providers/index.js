import { TorisError } from '../core/errors.js';
import { API_PROVIDERS, readApiKey } from '../core/models.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';

/**
 * Maps a resolved profile onto a live API client.
 *
 * Only direct-API providers live here. CLI-backed providers (claude-cli,
 * codex-cli) are spawned as subprocesses by the adapter layer instead, because
 * they own their own auth and transport.
 */
const FACTORIES = Object.freeze({
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
});

/**
 * @param {{provider:string, model:string, profile?:string}} resolved
 * @param {{env?:object, fetchImpl?:Function, baseUrl?:string}} [opts]
 */
export function createProvider(resolved, { env = process.env, fetchImpl, baseUrl } = {}) {
  const factory = FACTORIES[resolved?.provider];
  if (!factory) {
    throw new TorisError(
      `"${resolved?.provider}" is not a direct-API provider. ` +
        `Chat supports: ${API_PROVIDERS.join(', ')}.`,
      'E_UNKNOWN_PROVIDER',
    );
  }
  const apiKey = readApiKey(resolved.provider, env);
  return factory({
    apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });
}
