import { createOpenAIProvider } from './openai.js';

/**
 * xAI Grok over the OpenAI-compatible Chat Completions endpoint.
 *
 * Same `{complete,stream}` surface as anthropic/openai. Product code never
 * pins a Grok model id; the operator puts one on the profile.
 */

export const GROK_DEFAULT_BASE_URL = 'https://api.x.ai';

/**
 * @param {{apiKey:string, fetchImpl?:Function, baseUrl?:string}} opts
 */
export function createGrokProvider({ apiKey, fetchImpl, baseUrl = GROK_DEFAULT_BASE_URL }) {
  return createOpenAIProvider({
    apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
    baseUrl,
    name: 'grok',
    label: 'xAI',
    keyHint: 'XAI_API_KEY',
  });
}
