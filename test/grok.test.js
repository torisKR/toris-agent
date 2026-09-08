import test from 'node:test';
import assert from 'node:assert/strict';

import { createGrokProvider, GROK_DEFAULT_BASE_URL } from '../src/providers/grok.js';
import { createProvider } from '../src/providers/index.js';
import { API_PROVIDERS, apiKeyEnvVar, readApiKey, whichApiKey } from '../src/core/models.js';
import { detectCandidates } from '../src/cli/commands/connect.js';

test('grok is a first-class HTTP chat provider', () => {
  assert.ok(API_PROVIDERS.includes('grok'));
  assert.equal(apiKeyEnvVar('grok'), 'XAI_API_KEY');
});

test('GROK_API_KEY is accepted as an alias for XAI_API_KEY', () => {
  assert.equal(whichApiKey('grok', { GROK_API_KEY: 'xai-test' }), 'GROK_API_KEY');
  assert.equal(readApiKey('grok', { GROK_API_KEY: 'xai-test' }), 'xai-test');
  assert.equal(
    whichApiKey('grok', { XAI_API_KEY: 'official', GROK_API_KEY: 'alias' }),
    'XAI_API_KEY',
  );
});

test('createGrokProvider refuses to start without a key', () => {
  assert.throws(
    () => createGrokProvider({ apiKey: '' }),
    (err) => {
      assert.equal(err.code, 'E_PROVIDER_AUTH');
      assert.match(err.message, /XAI_API_KEY/);
      return true;
    },
  );
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
    body: null,
  };
}

test('complete posts to the xAI chat completions URL', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return jsonResponse(200, {
      choices: [{ message: { content: 'hi', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
  };
  const provider = createGrokProvider({ apiKey: 'xai-test', fetchImpl });
  assert.equal(provider.name, 'grok');
  const result = await provider.complete({
    model: 'operator-owned-id',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.text, 'hi');
  assert.equal(seen[0].url, `${GROK_DEFAULT_BASE_URL}/v1/chat/completions`);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, 'operator-owned-id');
  assert.match(seen[0].init.headers.authorization, /Bearer xai-test/);
});

test('auth failures name XAI_API_KEY, not OPENAI_API_KEY', async () => {
  const fetchImpl = async () => jsonResponse(401, { error: 'nope' });
  const provider = createGrokProvider({ apiKey: 'bad', fetchImpl });
  await assert.rejects(
    () => provider.complete({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.equal(err.code, 'E_PROVIDER_AUTH');
      assert.match(err.message, /XAI_API_KEY/);
      assert.doesNotMatch(err.message, /OPENAI_API_KEY/);
      return true;
    },
  );
});

test('auto is rejected for grok the same way as other API providers', async () => {
  const provider = createGrokProvider({
    apiKey: 'xai-test',
    fetchImpl: async () => {
      throw new Error('must not hit the network');
    },
  });
  await assert.rejects(
    () => provider.complete({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.equal(err.code, 'E_MODEL_REQUIRED');
      assert.match(err.message, /grok/);
      return true;
    },
  );
});

test('createProvider wires grok from a resolved profile', async () => {
  const fetchImpl = async () =>
    jsonResponse(200, {
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    });
  const provider = createProvider(
    { provider: 'grok', model: 'owned-id', profile: 'main' },
    { env: { XAI_API_KEY: 'xai-test' }, fetchImpl },
  );
  assert.equal(provider.name, 'grok');
  const result = await provider.complete({
    model: 'owned-id',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.text, 'ok');
});

test('connect lists grok when XAI_API_KEY is set', () => {
  const candidates = detectCandidates({ env: { XAI_API_KEY: 'xai-test' }, detect: () => null });
  const grok = candidates.find((one) => one.provider === 'grok');
  assert.equal(grok.available, true);
  assert.match(grok.reason, /XAI_API_KEY set/);
});

test('connect reports GROK_API_KEY when that alias is what is set', () => {
  const candidates = detectCandidates({ env: { GROK_API_KEY: 'xai-test' }, detect: () => null });
  const grok = candidates.find((one) => one.provider === 'grok');
  assert.equal(grok.available, true);
  assert.match(grok.reason, /GROK_API_KEY set/);
});
