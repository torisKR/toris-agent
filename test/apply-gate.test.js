import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDecision, formatApplySummary } from '../src/core/apply-gate.js';
import { gate } from '../src/core/autonomy.js';

test('L1 never applies isolated diffs', () => {
  assert.equal(applyDecision('L1'), 'never');
  assert.equal(gate('L1', 'apply').allowed, false);
});

test('L2 asks before applying to the original repo', () => {
  assert.equal(applyDecision('L2'), 'ask');
  assert.equal(gate('L2', 'write').allowed, true);
  assert.equal(gate('L2', 'apply').allowed, false);
});

test('L3 and above apply isolated diffs unattended', () => {
  assert.equal(applyDecision('L3'), 'auto');
  assert.equal(applyDecision('L5'), 'auto');
});

test('formatApplySummary names the files that would land', () => {
  assert.equal(formatApplySummary({ files: [] }), 'no file changes');
  assert.match(formatApplySummary({ files: ['a.js'], stats: ' a.js | 1 +' }), /1 file/);
});
