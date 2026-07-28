import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../src/core/orchestrator.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { tmpdir } from 'node:os';

/** Minimal in-memory store so tests never touch the filesystem. */
const memoryStore = () => {
  const runs = new Map();
  const events = [];
  return {
    runs, events,
    async saveRun(run) { runs.set(run.id, run); },
    async getRun(id) { return runs.get(id) ?? null; },
    async appendEvent(runId, event) { events.push({ runId, ...event }); },
    async readEvents() { return events; },
  };
};

const planReply = JSON.stringify([
  { title: 'Write the failing test', agent: 'test-writer' },
  { title: 'Make it pass', agent: 'implementer' },
]);

/** @param {object} over */
const build = (over = {}) => {
  const store = memoryStore();
  const invoke = over.invoke ?? (async () => ({ text: planReply, costUsd: 0.01 }));
  const orch = new Orchestrator({
    store,
    config: { ...DEFAULT_CONFIG, ...over.config },
    invoke,
    detect: over.detect ?? (async () => true),
    verifyFn: over.verifyFn ?? (async () => ({ passed: true, checks: [] })),
  });
  return { orch, store };
};

test('a dry run plans and stops before any execution', async () => {
  let invocations = 0;
  const { orch, store } = build({
    invoke: async () => { invocations += 1; return { text: planReply, costUsd: 0 }; },
  });
  const run = await orch.run({ goal: 'ship a feature', dryRun: true });
  assert.equal(run.status, 'dry-run');
  assert.equal(run.tasks.length, 2);
  assert.equal(invocations, 1, 'only the planning call may happen during a dry run');
  assert.ok(store.events.some((e) => e.type === 'run.planned'));
});

test('L1 plans then blocks on the write gate instead of editing files', async () => {
  const { orch } = build();
  const run = await orch.run({ goal: 'refactor', autonomy: 'L1' });
  assert.equal(run.status, 'awaiting-approval');
  assert.ok(run.tasks.length > 0, 'planning still happens at L1');
  assert.match(run.blockedReason, /L1/);
});

test('a missing provider binary degrades to a fallback plan rather than crashing', async () => {
  const { orch, store } = build({ detect: async () => false });
  const run = await orch.run({ goal: 'do the thing', dryRun: true });
  assert.ok(run.tasks.length > 0);
  assert.equal(run.providerAvailable, false);
  assert.ok(store.events.some((e) => e.type === 'plan.fallback'));
});

test('an unparsable plan reply falls back and records why', async () => {
  const { orch, store } = build({ invoke: async () => ({ text: 'I refuse to emit JSON.' }) });
  const run = await orch.run({ goal: 'goal', dryRun: true });
  assert.ok(run.tasks.length > 0);
  assert.ok(store.events.some((e) => e.type === 'plan.unparsable'));
});

test('a failing task marks the run failed but still finishes cleanly', async () => {
  let call = 0;
  const { orch } = build({
    invoke: async () => {
      call += 1;
      if (call === 1) return { text: planReply, costUsd: 0 };
      throw new Error('provider exploded');
    },
  });
  const run = await orch.run({ goal: 'g', autonomy: 'L2' });
  assert.equal(run.status, 'failed');
  assert.ok(run.finishedAt, 'a failed run must still be closed out');
  assert.ok(run.tasks.some((t) => t.status === 'failed'));
});

test('failed verification prevents a successful status', async () => {
  const { orch } = build({ verifyFn: async () => ({ passed: false, checks: [{ command: 'npm test', passed: false }] }) });
  const run = await orch.run({
    goal: 'g', autonomy: 'L2',
    project: { id: 'p1', path: tmpdir() },
    checks: ['npm test'],
  });
  assert.notEqual(run.status, 'succeeded');
  assert.equal(run.verification.passed, false);
});

test('the run cost accumulates from every provider call', async () => {
  const { orch } = build({ invoke: async () => ({ text: planReply, costUsd: 0.25 }) });
  const run = await orch.run({ goal: 'g', autonomy: 'L2' });
  assert.ok(run.costUsd >= 0.25, `expected accumulated cost, got ${run.costUsd}`);
});

test('the budget ceiling skips remaining work instead of overspending', async () => {
  const { orch, store } = build({ invoke: async () => ({ text: planReply, costUsd: 5 }) });
  const run = await orch.run({ goal: 'g', autonomy: 'L2', budgetUsd: 0.01 });
  assert.ok(store.events.some((e) => e.type === 'task.skipped'), 'work must stop when the budget is gone');
  assert.ok(run.finishedAt);
});

test('every run emits a started and a finished event', async () => {
  const { orch, store } = build();
  await orch.run({ goal: 'g', dryRun: true });
  const types = store.events.map((e) => e.type);
  assert.ok(types.includes('run.started'));
  assert.ok(types.includes('run.finished'));
});

test('run state is never mutated in place across transitions', async () => {
  const seen = [];
  const store = memoryStore();
  const original = store.saveRun.bind(store);
  store.saveRun = async (run) => { seen.push(run); return original(run); };
  const orch = new Orchestrator({
    store, config: DEFAULT_CONFIG,
    invoke: async () => ({ text: planReply, costUsd: 0 }),
    detect: async () => true,
    verifyFn: async () => ({ passed: true, checks: [] }),
  });
  await orch.run({ goal: 'g', dryRun: true });
  assert.ok(seen.length >= 2);
  assert.notEqual(seen[0], seen[seen.length - 1], 'each transition must produce a new object');
});

test('a provider whose binary is absent is reported as unavailable', async () => {
  const { orch } = build({ detect: async () => false });
  const run = await orch.run({ goal: 'g', dryRun: true });
  assert.equal(run.providerAvailable, false, 'async binary detection must be awaited');
});

test('verification runs only when checks are supplied', async () => {
  let called = 0;
  const { orch } = build({ verifyFn: async () => { called += 1; return { passed: true, checks: [] }; } });
  await orch.run({ goal: 'g', autonomy: 'L2' });
  assert.equal(called, 0, 'no checks means nothing to verify');
  await orch.run({ goal: 'g', autonomy: 'L2', project: { id: 'p', path: tmpdir() }, checks: ['npm test'] });
  assert.equal(called, 1);
});
