import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import {
  budgetHeadroom,
  canAfford,
  checkBudget,
  dailySpendFromRuns,
  dayKey,
  formatUsd,
  loadCostLedger,
  parseDailyBudgetUsd,
  recordRunCost,
  roundUsd,
  setDailyBudget,
  summarizeCost,
  upsertLedgerEntry,
  emptyLedger,
} from '../src/core/cost.js';
import { loadConfig } from '../src/core/config.js';

const withHome = async (fn) => {
  const home = await mkdtemp(join(tmpdir(), 'toris-cost-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

test('dayKey uses the local calendar, not UTC shifting', () => {
  const local = new Date(2026, 8, 17, 23, 30, 0);
  assert.equal(dayKey(local), '2026-09-17');
});

test('checkBudget treats a missing or non-positive cap as unlimited', () => {
  assert.equal(checkBudget(99, 0, { maxDailyCostUsd: 0 }).ok, true);
  assert.equal(checkBudget(99, undefined, { maxDailyCostUsd: 0 }).ok, true);
  assert.equal(checkBudget(1, undefined, {}).ok, true);
});

test('checkBudget refuses when spent reaches the tighter cap', () => {
  assert.equal(checkBudget(20, undefined, { maxDailyCostUsd: 20 }).ok, false);
  assert.match(checkBudget(20, undefined, { maxDailyCostUsd: 20 }).reason, /daily budget/);
  assert.equal(checkBudget(2, 2, { maxDailyCostUsd: 20 }).ok, false);
  assert.match(checkBudget(2, 2, { maxDailyCostUsd: 20 }).reason, /run budget/);
  assert.equal(checkBudget(1.5, 2, { maxDailyCostUsd: 20 }).ok, true);
});

test('canAfford combines the run ceiling with remaining daily headroom', () => {
  assert.equal(
    canAfford({
      spentUsd: 0.04,
      dailySpentUsd: 19.96,
      estimateUsd: 0.05,
      budgetUsd: 5,
      maxDailyCostUsd: 20,
    }).ok,
    false,
  );
  assert.equal(
    canAfford({
      spentUsd: 0.4,
      dailySpentUsd: 1,
      estimateUsd: 0.05,
      budgetUsd: 0.01,
      maxDailyCostUsd: 20,
    }).ok,
    false,
  );
  assert.equal(
    canAfford({
      spentUsd: 0.1,
      dailySpentUsd: 1,
      estimateUsd: 0.05,
      budgetUsd: 2,
      maxDailyCostUsd: 20,
    }).ok,
    true,
  );
});

test('budgetHeadroom reports the tighter remaining allowance', () => {
  const room = budgetHeadroom({ spentUsd: 1, dailySpentUsd: 18, budgetUsd: 5, maxDailyCostUsd: 20 });
  assert.equal(room.runRemaining, 4);
  assert.equal(room.dailyRemaining, 1);
  assert.equal(room.remaining, 1);
});

test('the ledger upserts a run instead of double-counting it', () => {
  const first = upsertLedgerEntry(emptyLedger(), {
    runId: 'run_1',
    costUsd: 1.25,
    goal: 'a',
    status: 'running',
    at: '2026-09-17T01:00:00.000Z',
  }, '2026-09-17');
  const second = upsertLedgerEntry(first, {
    runId: 'run_1',
    costUsd: 1.5,
    goal: 'a',
    status: 'succeeded',
    at: '2026-09-17T01:05:00.000Z',
  }, '2026-09-17');
  assert.equal(second.days['2026-09-17'].entries.length, 1);
  assert.equal(second.days['2026-09-17'].spentUsd, 1.5);
});

test('recordRunCost writes a greppable cost.json under the home dir', async () => {
  await withHome(async (home) => {
    await recordRunCost(home, {
      id: 'run_abc',
      costUsd: 0.42,
      goal: 'ship',
      status: 'succeeded',
      createdAt: '2026-09-17T00:00:00.000Z',
      finishedAt: '2026-09-17T00:01:00.000Z',
    });
    const raw = JSON.parse(await readFile(join(home, 'cost.json'), 'utf8'));
    assert.equal(raw.version, 1);
    const day = Object.values(raw.days)[0];
    assert.equal(day.spentUsd, 0.42);
    assert.equal(day.entries[0].runId, 'run_abc');
    const loaded = await loadCostLedger(home);
    assert.equal(loaded.days[Object.keys(loaded.days)[0]].spentUsd, 0.42);
  });
});

test('summarizeCost backfills from run files when the ledger is missing', async () => {
  await withHome(async (home) => {
    const store = new Store(home);
    await store.init();
    const today = dayKey(new Date());
    await store.saveRun({
      id: 'run_old',
      goal: 'legacy spend',
      status: 'succeeded',
      costUsd: 3.25,
      createdAt: `${today}T08:00:00.000`,
      finishedAt: `${today}T08:01:00.000`,
    });
    const summary = await summarizeCost({ home, store, config: DEFAULT_CONFIG });
    assert.equal(summary.today.spentUsd, 3.25);
    assert.equal(summary.today.capUsd, 20);
    assert.equal(summary.today.remainingUsd, 16.75);
    assert.ok(summary.runs.some((run) => run.id === 'run_old'));
  });
});

test('dailySpendFromRuns ignores another run id and other days', () => {
  const today = '2026-09-17T12:00:00';
  const spent = dailySpendFromRuns(
    [
      { id: 'run_a', costUsd: 1, createdAt: today, finishedAt: today },
      { id: 'run_b', costUsd: 4, createdAt: today, finishedAt: today },
      { id: 'run_c', costUsd: 9, createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z' },
    ],
    { day: dayKey(today), excludeRunId: 'run_b' },
  );
  assert.equal(spent.spentUsd, 1);
  assert.deepEqual(spent.entries.map((entry) => entry.runId), ['run_a']);
});

test('formatUsd and roundUsd stay at receipt precision', () => {
  assert.equal(formatUsd(1.2), '$1.2000');
  assert.equal(roundUsd(1.23456), 1.2346);
});

test('parseDailyBudgetUsd accepts a ceiling and treats empty as unlimited', () => {
  assert.equal(parseDailyBudgetUsd(12.5), 12.5);
  assert.equal(parseDailyBudgetUsd('7'), 7);
  assert.equal(parseDailyBudgetUsd(null), 0);
  assert.equal(parseDailyBudgetUsd(''), 0);
  assert.throws(() => parseDailyBudgetUsd(-1), /non-negative/);
  assert.throws(() => parseDailyBudgetUsd('nope'), /non-negative/);
  assert.throws(() => parseDailyBudgetUsd({}), /non-negative/);
});

test('setDailyBudget writes config.maxDailyCostUsd without touching spend entries', async () => {
  await withHome(async (home) => {
    await recordRunCost(home, {
      id: 'run_keep',
      costUsd: 1.25,
      goal: 'keep',
      status: 'succeeded',
      createdAt: '2026-09-17T00:00:00.000Z',
      finishedAt: '2026-09-17T00:01:00.000Z',
    });
    const before = JSON.parse(await readFile(join(home, 'cost.json'), 'utf8'));
    const next = await setDailyBudget(home, 8);
    assert.equal(next.maxDailyCostUsd, 8);
    const { config } = await loadConfig(home);
    assert.equal(config.maxDailyCostUsd, 8);
    assert.equal(checkBudget(8, undefined, config).ok, false);
    assert.deepEqual(JSON.parse(await readFile(join(home, 'cost.json'), 'utf8')), before);

    const cleared = await setDailyBudget(home, null);
    assert.equal(cleared.maxDailyCostUsd, 0);
    const after = await loadConfig(home);
    assert.equal(after.config.maxDailyCostUsd, 0);
    assert.equal(checkBudget(99, undefined, after.config).ok, true);
    assert.deepEqual(JSON.parse(await readFile(join(home, 'cost.json'), 'utf8')), before);
  });
});
