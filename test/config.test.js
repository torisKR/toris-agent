import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeConfig,
  validateConfig,
  migrateLegacyProviders,
  DEFAULT_CONFIG,
  resolveHome,
} from '../src/core/config.js';

test('mergeConfig deep-merges without mutating either input', () => {
  const base = { a: 1, nested: { x: 1, y: 2 } };
  const frozen = JSON.stringify(base);
  const merged = mergeConfig(base, { nested: { y: 99 } });
  assert.deepEqual(merged.nested, { x: 1, y: 99 });
  assert.equal(JSON.stringify(base), frozen, 'base must not be mutated');
});

test('mergeConfig preserves unknown keys so newer configs survive', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { futureFeature: true });
  assert.equal(merged.futureFeature, true);
});

test('arrays replace rather than merge', () => {
  assert.deepEqual(mergeConfig({ list: [1, 2, 3] }, { list: [9] }).list, [9]);
});

test('validateConfig accepts defaults', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test('validateConfig reports each bad field', () => {
  const problems = validateConfig({
    defaultAutonomy: 'L9',
    maxParallelAgents: 0,
    maxDailyCostUsd: -1,
  });
  assert.equal(problems.length, 3);
  assert.match(problems.join(' '), /L9/);
});

test('resolveHome prefers an explicit path over the environment', () => {
  assert.match(resolveHome('/tmp/explicit'), /explicit$/);
});

test('migrateLegacyProviders derives CLI profiles from an old providers block', () => {
  const legacy = {
    providers: {
      claude: { bin: 'claude', enabled: true },
      codex: { bin: 'codex', enabled: true },
    },
    models: { profiles: {}, routing: {} },
  };
  const before = JSON.stringify(legacy);
  const migrated = migrateLegacyProviders(legacy);
  assert.deepEqual(migrated.models.profiles['claude-cli'], {
    provider: 'claude-cli',
    model: 'auto',
  });
  assert.deepEqual(migrated.models.profiles['codex-cli'], {
    provider: 'codex-cli',
    model: 'auto',
  });
  assert.equal(migrated.models.routing.chat, 'claude-cli', 'chat routes to the first profile');
  assert.equal(JSON.stringify(legacy), before, 'input must not be mutated');
});

test('migrateLegacyProviders leaves an explicit profile setup alone', () => {
  const configured = {
    providers: { claude: { bin: 'claude', enabled: true } },
    models: {
      profiles: { mine: { provider: 'anthropic', model: 'auto' } },
      routing: { chat: 'mine' },
    },
  };
  assert.equal(migrateLegacyProviders(configured), configured, 'no copy when nothing to do');
});

test('migrateLegacyProviders ignores disabled or unknown legacy entries', () => {
  const legacy = {
    providers: {
      claude: { bin: 'claude', enabled: false },
      mystery: { bin: 'mystery', enabled: true },
    },
    models: { profiles: {}, routing: {} },
  };
  const migrated = migrateLegacyProviders(legacy);
  assert.deepEqual(Object.keys(migrated.models.profiles), []);
  assert.equal(migrated.models.routing.chat, undefined);
});
