import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateApiKey, VALIDATABLE_PROVIDERS } from '../src/desktop/validate-key.js';

/** A fetch stub that records the request and returns a chosen status. */
function fakeFetch(status, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    return { status, ok: status >= 200 && status < 300 };
  };
}

test('a 200 from the model-list probe is a valid key', async () => {
  const cap = {};
  const res = await validateApiKey('openai', 'sk-test', { fetchImpl: fakeFetch(200, cap) });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(cap.url, 'https://api.openai.com/v1/models');
  assert.equal(cap.init.headers.Authorization, 'Bearer sk-test');
});

test('401/403 is reported as a rejected key', async () => {
  for (const status of [401, 403]) {
    const res = await validateApiKey('anthropic', 'bad', { fetchImpl: fakeFetch(status) });
    assert.equal(res.ok, false);
    assert.equal(res.status, status);
    assert.match(res.message, /rejected/i);
  }
});

test('429 still counts as authenticated (rate-limited, not invalid)', async () => {
  const res = await validateApiKey('anthropic', 'ok', { fetchImpl: fakeFetch(429) });
  assert.equal(res.ok, true);
  assert.match(res.message, /rate-limited/i);
});

test('anthropic uses the x-api-key header and version', async () => {
  const cap = {};
  await validateApiKey('anthropic', 'sk-ant', { fetchImpl: fakeFetch(200, cap) });
  assert.equal(cap.init.headers['x-api-key'], 'sk-ant');
  assert.ok(cap.init.headers['anthropic-version']);
});

test('an unknown provider is rejected without a network call', async () => {
  let called = false;
  const res = await validateApiKey('nope', 'x', { fetchImpl: async () => ((called = true), { status: 200 }) });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

test('an empty key short-circuits before fetching', async () => {
  let called = false;
  const res = await validateApiKey('openai', '   ', { fetchImpl: async () => ((called = true), { status: 200 }) });
  assert.equal(res.ok, false);
  assert.equal(called, false);
  assert.match(res.message, /enter a key/i);
});

test('a network/abort error is surfaced, not thrown', async () => {
  const boom = async () => {
    throw new Error('ECONNREFUSED');
  };
  const res = await validateApiKey('grok', 'k', { fetchImpl: boom });
  assert.equal(res.ok, false);
  assert.match(res.message, /could not reach grok/i);

  const timeout = async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  const res2 = await validateApiKey('grok', 'k', { fetchImpl: timeout });
  assert.equal(res2.ok, false);
  assert.match(res2.message, /timed out/i);
});

test('all validatable providers are the three HTTP providers', () => {
  assert.deepEqual([...VALIDATABLE_PROVIDERS].sort(), ['anthropic', 'grok', 'openai']);
});
