import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdDoctor } from '../src/cli/commands/setup.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { Store } from '../src/core/store.js';

/**
 * Doctor reads process.env for API keys. Swap it for the duration of a check
 * and always put it back, so one test can never colour another.
 */
async function withEnv(vars, fn) {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Run doctor against a throwaway home and return its checks by name. */
async function runDoctor({ models } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-doctor-'));
  try {
    const config = { ...DEFAULT_CONFIG, models: models ?? DEFAULT_CONFIG.models };
    const captured = [];
    const ctx = {
      home,
      config,
      configExists: true,
      json: true,
      store: new Store(home),
    };
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(chunk); return true; };
    try {
      await cmdDoctor(ctx);
    } finally {
      process.stdout.write = write;
    }
    const { checks } = JSON.parse(captured.join(''));
    return new Map(checks.map((check) => [check.name, check]));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const CONFIGURED = {
  profiles: { main: { provider: 'anthropic', model: 'claude-sonnet-5' } },
  routing: { chat: 'main' },
};

test('a fresh install warns that no API key is set', async () => {
  await withEnv({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null }, async () => {
    const checks = await runDoctor();
    assert.equal(checks.get('api-keys').status, 'WARN');
    assert.match(checks.get('api-keys').detail, /ANTHROPIC_API_KEY/);
  });
});

test('a key alone is not enough - the profile gap is still reported', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: null }, async () => {
    const checks = await runDoctor();
    assert.equal(checks.get('api-keys').status, 'PASS');
    assert.equal(checks.get('model-profiles').status, 'WARN');
    assert.equal(checks.get('chat').status, 'WARN');
  });
});

test('a profile without its key is reported, not called ready', async () => {
  await withEnv({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null }, async () => {
    const checks = await runDoctor({ models: CONFIGURED });
    assert.equal(checks.get('model-profiles').status, 'PASS');
    assert.equal(checks.get('chat').status, 'WARN');
    assert.match(checks.get('chat').detail, /ANTHROPIC_API_KEY/);
  });
});

test('key plus profile reports the concrete model chat will use', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const checks = await runDoctor({ models: CONFIGURED });
    assert.equal(checks.get('chat').status, 'PASS');
    assert.equal(checks.get('chat').detail, 'anthropic/claude-sonnet-5');
  });
});

test('the skills that ship with toris are discovered', async () => {
  const checks = await runDoctor();
  assert.equal(checks.get('skills').status, 'PASS');
  assert.match(checks.get('skills').detail, /ship-small/);
});

test('a missing chat setup never fails the exit code - runs do not need it', async () => {
  await withEnv({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null }, async () => {
    const checks = await runDoctor();
    for (const name of ['api-keys', 'model-profiles', 'chat']) {
      assert.notEqual(checks.get(name).status, 'FAIL');
    }
  });
});
