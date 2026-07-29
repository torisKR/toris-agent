import { TorisError } from '../core/errors.js';
import { API_PROVIDERS, CLI_PROVIDERS, readApiKey } from '../core/models.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { createClaudeCliProvider } from './claude-cli.js';
import { createCodexCliProvider } from './codex-cli.js';

/**
 * Maps a resolved profile onto a live chat transport.
 *
 * Two families exist:
 *  - direct-API providers (anthropic, openai) speak HTTP with an env API key;
 *  - CLI-backed providers (claude-cli, codex-cli) spawn the installed agent
 *    CLI per turn and reuse its existing login session, so no key is needed.
 */
const API_FACTORIES = Object.freeze({
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
});

const CLI_FACTORIES = Object.freeze({
  'claude-cli': createClaudeCliProvider,
  'codex-cli': createCodexCliProvider,
});

/**
 * @param {{provider:string, model:string, profile?:string}} resolved
 * @param {{env?:object, fetchImpl?:Function, baseUrl?:string,
 *          bins?:{[provider:string]:string}, timeoutMs?:number}} [opts]
 */
export function createProvider(
  resolved,
  { env = process.env, fetchImpl, baseUrl, bins = {}, timeoutMs } = {},
) {
  const cliFactory = CLI_FACTORIES[resolved?.provider];
  if (cliFactory) {
    return cliFactory({
      ...(bins[resolved.provider] ? { bin: bins[resolved.provider] } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      env,
    });
  }

  const factory = API_FACTORIES[resolved?.provider];
  if (!factory) {
    throw new TorisError(
      `"${resolved?.provider}" is not a chat provider. ` +
        `Chat supports: ${[...API_PROVIDERS, ...CLI_PROVIDERS].join(', ')}.`,
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
