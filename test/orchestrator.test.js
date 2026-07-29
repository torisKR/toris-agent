import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator, buildTaskPrompt } from '../src/core/orchestrator.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { RECOMMENDED_AUTONOMY } from '../src/core/autonomy.js';
import { tmpdir } from 'node:os';

/** Minimal in-memory store so tests never touch the filesystem. */
const memoryStore = () => {
  const runs = new Map();
  const events = [];
  return {
    runs,
    events,
    async saveRun(run) {
      runs.set(run.id, run);
    },
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async appendEvent(runId, event) {
      events.push({ runId, ...event });
    },
    async readEvents() {
      return events;
    },
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
    detectChecksFn: over.detectChecksFn ?? (async () => []),
  });
  return { orch, store };
};

test('a dry run plans and stops before any execution', async () => {
  let invocations = 0;
  const { orch, store } = build({
    invoke: async () => {
      invocations += 1;
      return { text: planReply, costUsd: 0 };
    },
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

test('a provider that errors during planning degrades to a fallback plan', async () => {
  // Regression: an *absent* provider fell back, but a provider that was present
  // and then failed (e.g. codex refusing a non-git directory) crashed the whole
  // run. Both are the same class of problem and must degrade the same way.
  const { orch, store } = build({
    invoke: async () => {
      throw new Error('codex exited with code 1: Not inside a trusted directory');
    },
  });
  const run = await orch.run({ goal: 'do the thing', dryRun: true });
  assert.equal(run.status, 'dry-run');
  assert.ok(run.tasks.length > 0, 'a plan is still produced');
  assert.equal(run.costUsd, 0);
  const failed = store.events.find((e) => e.type === 'plan.failed');
  assert.ok(failed, 'the failure is recorded as an event');
  assert.match(failed.reason, /trusted directory/);
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
  const { orch } = build({
    verifyFn: async () => ({ passed: false, checks: [{ command: 'npm test', passed: false }] }),
  });
  const run = await orch.run({
    goal: 'g',
    autonomy: 'L2',
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
  assert.ok(
    store.events.some((e) => e.type === 'task.skipped'),
    'work must stop when the budget is gone',
  );
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
  store.saveRun = async (run) => {
    seen.push(run);
    return original(run);
  };
  const orch = new Orchestrator({
    store,
    config: DEFAULT_CONFIG,
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
  const { orch } = build({
    verifyFn: async () => {
      called += 1;
      return { passed: true, checks: [] };
    },
  });
  await orch.run({ goal: 'g', autonomy: 'L2' });
  assert.equal(called, 0, 'no checks means nothing to verify');
  await orch.run({
    goal: 'g',
    autonomy: 'L2',
    project: { id: 'p', path: tmpdir() },
    checks: ['npm test'],
  });
  assert.equal(called, 1);
});

test('a project with no recorded checks is sniffed on disk instead of skipping verification', async () => {
  // Arrange: the project was registered before its test script existed, so its
  // stored checks are empty — the run must still prove something.
  let verified = null;
  const { orch, store } = build({
    detectChecksFn: async () => ['npm run test'],
    verifyFn: async (commands) => {
      verified = commands;
      return { passed: true, checks: [{ command: commands[0], passed: true, exitCode: 0 }] };
    },
  });

  // Act
  const run = await orch.run({
    goal: 'g',
    autonomy: 'L2',
    project: { id: 'p', path: tmpdir() },
    checks: [],
  });

  // Assert
  assert.deepEqual(verified, ['npm run test']);
  assert.equal(run.verification.passed, true);
  const started = store.events.find((e) => e.type === 'verify.started');
  assert.equal(started.inferred, true, 'the receipt must show these checks were guessed');
});

test('explicitly configured checks are never overridden by detection', async () => {
  // Arrange
  let detectCalls = 0;
  let verified = null;
  const { orch, store } = build({
    detectChecksFn: async () => {
      detectCalls += 1;
      return ['cargo test'];
    },
    verifyFn: async (commands) => {
      verified = commands;
      return { passed: true, checks: [] };
    },
  });

  // Act
  await orch.run({
    goal: 'g',
    autonomy: 'L2',
    project: { id: 'p', path: tmpdir() },
    checks: ['npm run lint'],
  });

  // Assert
  assert.deepEqual(verified, ['npm run lint']);
  assert.equal(detectCalls, 0, 'detection must not run when the user already said what to run');
  assert.equal(store.events.find((e) => e.type === 'verify.started').inferred, false);
});

test('a run that proves nothing records why, rather than passing silently', async () => {
  // Arrange
  const { orch, store } = build({ detectChecksFn: async () => [] });

  // Act
  const run = await orch.run({
    goal: 'g',
    autonomy: 'L2',
    project: { id: 'p', path: tmpdir() },
  });

  // Assert: "succeeded" with no evidence is the failure mode this guards against.
  const skipped = store.events.find((e) => e.type === 'verify.skipped');
  assert.ok(skipped, 'the absence of verification must be an event, not silence');
  assert.match(skipped.reason, /none could be detected/);
  assert.equal(run.verification.passed, null);
});

test('a run with no project explains that there is nothing to verify against', async () => {
  // Arrange
  const { orch, store } = build();

  // Act
  await orch.run({ goal: 'g', autonomy: 'L2' });

  // Assert
  const skipped = store.events.find((e) => e.type === 'verify.skipped');
  assert.match(skipped.reason, /no project path/);
});

test('a failed verification names the commands that broke', async () => {
  // Arrange
  const { orch, store } = build({
    verifyFn: async () => ({
      passed: false,
      checks: [
        { command: 'npm run lint', passed: true, exitCode: 0 },
        { command: 'npm test', passed: false, exitCode: 1 },
      ],
    }),
  });

  // Act
  await orch.run({
    goal: 'g',
    autonomy: 'L2',
    project: { id: 'p', path: tmpdir() },
    checks: ['npm run lint', 'npm test'],
  });

  // Assert
  const finished = store.events.find((e) => e.type === 'verify.finished');
  assert.deepEqual(finished.failed, ['npm test'], 'the log must say which check failed');
});

test('task events carry a readable title, not just an opaque id', async () => {
  // Arrange
  const { orch, store } = build();

  // Act
  await orch.run({ goal: 'g', autonomy: 'L2' });

  // Assert: `toris run --verbose` prints event.title, so an id-only event is noise.
  const started = store.events.filter((e) => e.type === 'task.started');
  const succeeded = store.events.filter((e) => e.type === 'task.succeeded');
  assert.ok(started.length > 0);
  assert.ok(succeeded.every((e) => typeof e.title === 'string' && e.title.length > 0));
  assert.ok(succeeded.every((e) => typeof e.costUsd === 'number'));
});

test('a failed task event reports both its title and its error', async () => {
  // Arrange
  let call = 0;
  const { orch, store } = build({
    invoke: async () => {
      call += 1;
      if (call === 1) return { text: planReply, costUsd: 0 };
      throw new Error('provider exploded');
    },
  });

  // Act
  await orch.run({ goal: 'g', autonomy: 'L2' });

  // Assert
  const failed = store.events.find((e) => e.type === 'task.failed');
  assert.match(failed.title, /\w/);
  assert.match(failed.error, /provider exploded/);
});

test('a skipped task explains the budget ceiling that stopped it', async () => {
  // Arrange
  const { orch, store } = build({ invoke: async () => ({ text: planReply, costUsd: 5 }) });

  // Act
  await orch.run({ goal: 'g', autonomy: 'L2', budgetUsd: 0.01 });

  // Assert
  const skipped = store.events.find((e) => e.type === 'task.skipped');
  assert.match(skipped.reason, /budget exhausted/);
  assert.match(skipped.reason, /0\.01/, 'a solo dev needs to know which cap they hit');
  assert.ok(skipped.title, 'the skipped task must be identifiable');
});

test('an orchestrator with no config falls back to the recommended solo autonomy', async () => {
  // Arrange: programmatic use via src/index.js need not construct a full config.
  const orch = new Orchestrator({
    invoke: async () => ({ text: planReply, costUsd: 0 }),
    detect: async () => true,
    verifyFn: async () => ({ passed: true, checks: [] }),
  });

  // Act
  const run = await orch.run({ goal: 'g', dryRun: true });

  // Assert
  assert.equal(run.autonomy, RECOMMENDED_AUTONOMY);
  assert.equal(run.status, 'dry-run');
});

test('the task prompt tells the agent nobody is there to answer questions', async () => {
  // Arrange
  const run = { goal: 'ship it', autonomy: 'L3' };
  const task = { agent: 'implementer', title: 'Do the thing', detail: '', verify: '' };

  // Act
  const prompt = buildTaskPrompt(task, run, { path: '/srv/app' });

  // Assert: a mid-run question just stalls the task until the provider times out.
  assert.match(prompt, /Do not ask for confirmation/);
  assert.match(prompt, /autonomy L3/);
});
