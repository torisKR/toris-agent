import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, validateConfig, DEFAULT_CONFIG, resolveHome } from '../src/core/config.js';

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
  const problems = validateConfig({ defaultAutonomy: 'L9', maxParallelAgents: 0, maxDailyCostUsd: -1 });
  assert.equal(problems.length, 3);
  assert.match(problems.join(' '), /L9/);
});

test('resolveHome prefers an explicit path over the environment', () => {
  assert.match(resolveHome('/tmp/explicit'), /explicit$/);
});
