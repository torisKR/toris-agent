import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt, receiptToMarkdown } from '../src/core/receipt.js';
import { createId, newRunId } from '../src/core/ids.js';

const run = {
  id: 'run_abc', goal: 'ship it', status: 'succeeded', autonomy: 'L3', provider: 'claude',
  costUsd: 0.42, createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
  tasks: [
    { id: 't1', title: 'Do A', status: 'succeeded', agent: 'implementer' },
    { id: 't2', title: 'Do B', status: 'failed', agent: 'implementer', error: 'boom' },
  ],
  artifacts: ['src/a.js'],
  verification: { passed: true, checks: [{ command: 'npm test', passed: true }] },
};

test('the receipt summarises task outcomes', () => {
  const receipt = buildReceipt(run, []);
  assert.equal(receipt.tasks.total, 2);
  assert.equal(receipt.tasks.succeeded, 1);
  assert.equal(receipt.tasks.failed, 1);
});

test('the receipt records duration and cost', () => {
  const receipt = buildReceipt(run, []);
  assert.equal(receipt.costUsd, 0.42);
  assert.equal(receipt.durationMs, 60000);
});

test('markdown rendering includes the goal, verdict and every task', () => {
  const md = receiptToMarkdown(buildReceipt(run, []));
  assert.match(md, /ship it/);
  assert.match(md, /Do A/);
  assert.match(md, /Do B/);
  assert.match(md, /run_abc/);
});

test('a receipt for an empty run does not throw', () => {
  const md = receiptToMarkdown(buildReceipt({ id: 'r', goal: 'g', tasks: [], verification: {} }, []));
  assert.match(md, /g/);
});

test('ids are unique, prefixed and sortable by creation time', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newRunId()));
  assert.equal(ids.size, 500, 'ids must not collide');
  assert.match(createId('tsk'), /^tsk_/);
  const early = createId('run', () => 1000);
  const late = createId('run', () => 9_000_000);
  assert.ok(early < late, 'ids should sort chronologically');
});

test('the markdown lists each task with its outcome and error', () => {
  const md = receiptToMarkdown(buildReceipt(run, []));
  assert.match(md, /✅ Do A/);
  assert.match(md, /❌ Do B/);
  assert.match(md, /boom/, 'a failure must explain itself');
});

test('a run with no verification block renders without throwing', () => {
  const md = receiptToMarkdown(buildReceipt({ id: 'r', goal: 'g', tasks: [] }, []));
  assert.match(md, /Run receipt/);
});
