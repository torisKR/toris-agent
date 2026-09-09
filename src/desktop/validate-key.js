/**
 * Lightweight API-key validation for the desktop Settings flow.
 *
 * The desktop app lets a solo operator paste a provider key and check it before
 * committing to a real chat turn. Rather than burning a full completion, we hit
 * each provider's cheapest authenticated read (its model-list endpoint) and map
 * the HTTP status onto a clear, human-readable verdict.
 *
 * This module is deliberately transport-only and dependency-free so it can be
 * unit-tested with an injected `fetchImpl` (no network, no real key).
 */

/**
 * How to probe each API provider: the URL and the auth header its key goes in.
 * Model-list endpoints are read-only and count as a trivial (often free) call,
 * which is exactly what "is this key valid?" wants.
 */
const PROBES = Object.freeze({
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  grok: {
    url: 'https://api.x.ai/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
});

/** Providers this module knows how to validate. */
export const VALIDATABLE_PROVIDERS = Object.freeze(Object.keys(PROBES));

/**
 * Validate an API key by making one authenticated read against the provider.
 *
 * @param {string} provider  one of VALIDATABLE_PROVIDERS
 * @param {string} key       the API key to test
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, status:number|null, message:string}>}
 */
export async function validateApiKey(provider, key, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const probe = PROBES[provider];
  if (!probe) {
    return { ok: false, status: null, message: `Don't know how to validate "${provider}".` };
  }
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed) {
    return { ok: false, status: null, message: 'Enter a key first.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(probe.url, {
      method: 'GET',
      headers: probe.headers(trimmed),
      signal: controller.signal,
    });
    return interpret(provider, res.status);
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ok: false, status: null, message: `Timed out reaching ${provider}. Check your connection.` };
    }
    return { ok: false, status: null, message: `Could not reach ${provider}: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Map an HTTP status from a model-list probe onto a validation verdict. */
function interpret(provider, status) {
  if (status >= 200 && status < 300) {
    return { ok: true, status, message: `${provider} key looks valid.` };
  }
  if (status === 401 || status === 403) {
    return { ok: false, status, message: `${provider} rejected the key (HTTP ${status}). Double-check it.` };
  }
  if (status === 429) {
    // The key authenticated (otherwise we'd get 401); it's just rate-limited.
    return { ok: true, status, message: `${provider} key authenticated but is rate-limited right now (HTTP 429).` };
  }
  return { ok: false, status, message: `${provider} returned HTTP ${status}.` };
}
