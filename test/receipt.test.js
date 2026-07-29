import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt, receiptToMarkdown, RECEIPT_SCHEMA_VERSION } from '../src/core/receipt.js';
import { createId, newRunId } from '../src/core/ids.js';

const run = {
  id: 'run_abc',
  goal: 'ship it',
  status: 'succeeded',
  autonomy: 'L3',
  provider: 'claude',
  costUsd: 0.42,
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:00.000Z',
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
  const md = receiptToMarkdown(
    buildReceipt({ id: 'r', goal: 'g', tasks: [], verification: {} }, []),
  );
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

test('the receipt carries a schema version so stored receipts stay readable', () => {
  assert.equal(buildReceipt(run, []).schemaVersion, RECEIPT_SCHEMA_VERSION);
});

test('the verdict states outcome, task tally, verification and cost in one line', () => {
  // Arrange / Act
  const verdict = buildReceipt(run, []).verdict;

  // Assert
  assert.match(verdict, /succeeded/);
  assert.match(verdict, /1\/2 tasks succeeded/);
  assert.match(verdict, /1 check passed/);
  assert.match(verdict, /\$0\.4200/);
});

test('the verdict says "nothing verified" when no checks ran', () => {
  // Arrange: a run that edited files but proved nothing must not read as verified.
  const unproven = { ...run, verification: { passed: null, checks: [] } };

  // Act
  const receipt = buildReceipt(unproven, []);

  // Assert
  assert.match(receipt.verdict, /nothing verified/);
  assert.equal(receipt.verification.total, 0);
});

test('the verdict counts failed checks', () => {
  // Arrange
  const broken = {
    ...run,
    status: 'failed',
    verification: {
      passed: false,
      checks: [
        { command: 'npm run lint', passed: true, exitCode: 0 },
        { command: 'npm test', passed: false, exitCode: 1 },
      ],
    },
  };

  // Act
  const receipt = buildReceipt(broken, []);

  // Assert
  assert.match(receipt.verdict, /1 of 2 checks failed/);
  assert.equal(receipt.verification.failed, 1);
});

test('every failure lands in one list regardless of where it came from', () => {
  // Arrange
  const broken = {
    ...run,
    verification: {
      passed: false,
      checks: [{ command: 'npm test', passed: false, exitCode: 1, stderr: 'AssertionError: nope' }],
    },
  };

  // Act
  const { failures } = buildReceipt(broken, []);

  // Assert: one failed task plus one failed check, without cross-referencing sections.
  assert.equal(failures.length, 2);
  assert.deepEqual(
    failures.map((f) => f.kind),
    ['task', 'check'],
  );
  assert.equal(failures[0].detail, 'boom');
  assert.match(failures[1].detail, /AssertionError: nope/);
});

test('a clean run reports no failures at all', () => {
  // Arrange
  const clean = { ...run, tasks: [{ id: 't1', title: 'Do A', status: 'succeeded' }] };

  // Act / Assert
  assert.deepEqual(buildReceipt(clean, []).failures, []);
});

test('the markdown leads with the verdict before any evidence', () => {
  // Arrange / Act
  const md = receiptToMarkdown(buildReceipt(run, []));
  const verdictAt = md.indexOf('1/2 tasks succeeded');
  const tasksAt = md.indexOf('## Tasks');
  const detailsAt = md.indexOf('## Details');

  // Assert: a solo developer reads the top and only scrolls when something is red.
  assert.ok(verdictAt !== -1, 'the verdict must appear in the markdown');
  assert.ok(verdictAt < tasksAt, 'the verdict must come before the task list');
  assert.ok(tasksAt < detailsAt, 'metadata belongs at the bottom, not the top');
});

test('a failed check prints its actual output, not just an exit code', () => {
  // Arrange
  const broken = {
    ...run,
    status: 'failed',
    verification: {
      passed: false,
      checks: [
        {
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stderr: 'AssertionError: expected 1 to equal 2',
        },
      ],
    },
  };

  // Act
  const md = receiptToMarkdown(buildReceipt(broken, []));

  // Assert
  assert.match(md, /## What went wrong/);
  assert.match(md, /AssertionError: expected 1 to equal 2/);
  assert.ok(md.indexOf('## What went wrong') < md.indexOf('## Tasks'), 'failures come first');
});

test('a run that verified nothing says so instead of staying silent', () => {
  // Arrange
  const unproven = { id: 'r', goal: 'g', status: 'succeeded', tasks: [], verification: {} };

  // Act
  const md = receiptToMarkdown(buildReceipt(unproven, []));

  // Assert: an empty Verification section would read as "all good".
  assert.match(md, /nothing about this run was proved/);
});

test('a long changed-file list is truncated rather than flooding the receipt', () => {
  // Arrange
  const many = { ...run, artifacts: Array.from({ length: 25 }, (_, i) => `src/f${i}.js`) };

  // Act
  const md = receiptToMarkdown(buildReceipt(many, []));

  // Assert
  assert.match(md, /## Changed files \(25\)/);
  assert.match(md, /and 5 more/);
  assert.ok(!md.includes('src/f24.js'), 'the tail must be summarised, not printed');
});

test('buildReceipt never mutates the run it describes', () => {
  // Arrange
  const snapshot = structuredClone(run);

  // Act
  buildReceipt(run, []);

  // Assert
  assert.deepEqual(run, snapshot);
});
