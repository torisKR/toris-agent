import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildBrief,
  looksLikeBriefGoal,
  resolveBriefPeriod,
  verifyOutcome,
  summarizeGoal,
} from '../src/core/brief.js';
import { Store } from '../src/core/store.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { dayKey } from '../src/core/cost.js';
import { addSchedule } from '../src/daemon/index.js';
import { ScheduleExprError } from '../src/daemon/cron.js';

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-brief-'));
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify(DEFAULT_CONFIG), 'utf8');
    const store = new Store(home);
    await store.init();
    await fn(home, store);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function isoOn(day, hour = '09:00:00.000') {
  return `${day}T${hour}`;
}

test('looksLikeBriefGoal catches the digest spellings and ignores real goals', () => {
  assert.equal(looksLikeBriefGoal('brief'), true);
  assert.equal(looksLikeBriefGoal('toris brief'), true);
  assert.equal(looksLikeBriefGoal('toris brief today'), true);
  assert.equal(looksLikeBriefGoal('toris brief --json'), true);
  assert.equal(looksLikeBriefGoal('  TORIS BRIEF  '), true);
  assert.equal(looksLikeBriefGoal('add a health endpoint'), false);
  assert.equal(looksLikeBriefGoal('brief the stakeholders'), false);
  assert.equal(looksLikeBriefGoal(''), false);
});

test('resolveBriefPeriod defaults to today and rejects unknowns', () => {
  assert.equal(resolveBriefPeriod(), 'today');
  assert.equal(resolveBriefPeriod('today'), 'today');
  assert.throws(() => resolveBriefPeriod('week'), /Unknown brief period/);
});

test('verifyOutcome maps receipt verification without inventing a pass', () => {
  assert.equal(verifyOutcome({ verification: { passed: true } }), 'pass');
  assert.equal(verifyOutcome({ verification: { passed: false } }), 'fail');
  assert.equal(verifyOutcome({ verification: { passed: null } }), null);
  assert.equal(verifyOutcome({}), null);
});

test('summarizeGoal clips long text', () => {
  assert.equal(summarizeGoal('ship it'), 'ship it');
  assert.match(summarizeGoal('x'.repeat(80), 16), /…$/);
});

test('empty home: spend is zero, runs omitted, knowledge unavailable, daemon stopped', async () => {
  await withHome(async (home, store) => {
    const brief = await buildBrief({
      home,
      store,
      config: DEFAULT_CONFIG,
      cwd: home,
      now: new Date('2026-09-17T12:00:00'),
    });
    assert.equal(brief.period, 'today');
    assert.equal(brief.timezone, 'local');
    assert.equal(brief.spend.spentUsd, 0);
    assert.equal(brief.spend.capUsd, 20);
    assert.deepEqual(brief.runs, []);
    assert.equal(brief.daemon.running, false);
    assert.equal(brief.daemon.nextDueAt, null);
    assert.equal(brief.knowledge.available, false);
    assert.deepEqual(brief.knowledge.headlines, []);
  });
});

test('today scoped runs include verify and skip yesterday', async () => {
  await withHome(async (home, store) => {
    const today = dayKey(new Date('2026-09-17T12:00:00'));
    await store.saveRun({
      id: 'run_todayok',
      goal: 'add a health endpoint for the flutter play release',
      status: 'succeeded',
      costUsd: 1.25,
      createdAt: isoOn(today),
      finishedAt: isoOn(today, '09:01:00.000'),
      verification: { passed: true, checks: [{ command: 'npm test', passed: true, exitCode: 0 }] },
    });
    await store.saveRun({
      id: 'run_todayfail',
      goal: 'fix the parser',
      status: 'failed',
      costUsd: 0.5,
      createdAt: isoOn(today, '10:00:00.000'),
      finishedAt: isoOn(today, '10:02:00.000'),
      verification: { passed: false, checks: [{ command: 'npm test', passed: false, exitCode: 1 }] },
    });
    await store.saveRun({
      id: 'run_yest',
      goal: 'old work',
      status: 'succeeded',
      costUsd: 9,
      createdAt: '2026-09-16T09:00:00.000',
      finishedAt: '2026-09-16T09:01:00.000',
      verification: { passed: true, checks: [] },
    });

    const brief = await buildBrief({
      home,
      store,
      config: DEFAULT_CONFIG,
      cwd: home,
      now: new Date('2026-09-17T12:00:00'),
    });
    assert.equal(brief.spend.spentUsd, 1.75);
    assert.equal(brief.spend.runCount, 2);
    assert.deepEqual(
      brief.runs.map((run) => run.id),
      ['run_todayok', 'run_todayfail'],
    );
    assert.equal(brief.runs[0].verify, 'pass');
    assert.equal(brief.runs[1].verify, 'fail');
    assert.ok(!brief.runs.some((run) => run.id === 'run_yest'));
  });
});

test('knowledge headlines skip when uninitialized and surface tacit after init', async () => {
  await withHome(async (home, store) => {
    const before = await buildBrief({ home, store, config: DEFAULT_CONFIG, cwd: home });
    assert.equal(before.knowledge.available, false);

    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });
    const after = await buildBrief({ home, store, config: DEFAULT_CONFIG, cwd: home });
    assert.equal(after.knowledge.available, true);
    assert.ok(after.knowledge.headlines.length >= 1);
    assert.ok(after.knowledge.headlines.length <= 5);
    assert.ok(after.knowledge.headlines.every((item) => item.kind === 'tacit' || item.kind === 'inbox'));
  });
});

test('goal keywords prefer matching tacit or nodes over an unrelated dump', async () => {
  await withHome(async (home, store) => {
    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });
    const today = dayKey(new Date());
    await store.saveRun({
      id: 'run_kw',
      goal: 'flutter play store listing on a mid-range phone',
      status: 'succeeded',
      costUsd: 0.1,
      createdAt: `${today}T09:00:00.000`,
      finishedAt: `${today}T09:01:00.000`,
      verification: { passed: true, checks: [] },
    });
    const brief = await buildBrief({ home, store, config: DEFAULT_CONFIG, cwd: home });
    assert.equal(brief.knowledge.available, true);
    assert.ok(brief.knowledge.headlines.length >= 1);
    const blob = brief.knowledge.headlines
      .map((item) => `${item.domain} ${item.id} ${item.title}`)
      .join(' ')
      .toLowerCase();
    assert.match(blob, /flutter|play|android|phone|listing/);
  });
});

test('daemon next due appears without requiring the worker', async () => {
  await withHome(async (home, store) => {
    await addSchedule(
      home,
      { expr: '@daily', goal: 'lint the repo', dryRun: true },
      { idFactory: () => 'sch_brief', clock: () => new Date('2026-09-17T00:00:00.000Z') },
    );
    const brief = await buildBrief({
      home,
      store,
      config: DEFAULT_CONFIG,
      cwd: home,
      now: new Date('2026-09-17T12:00:00.000Z'),
    });
    assert.equal(brief.daemon.running, false);
    assert.equal(brief.daemon.scheduleCount, 1);
    assert.equal(brief.daemon.nextId, 'sch_brief');
    assert.ok(brief.daemon.nextDueAt);
  });
});

test('addSchedule refuses a brief goal so the worker cannot treat it as a run', async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () => addSchedule(home, { expr: '09:00', goal: 'toris brief' }),
      (err) => err instanceof ScheduleExprError && /foreground CLI digest/.test(err.message),
    );
  });
});
