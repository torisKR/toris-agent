import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addSchedule,
  DaemonQueue,
  findSchedule,
  listSchedules,
  matchesCron,
  nextDueAfter,
  parseScheduleExpr,
  publicSchedule,
  readDaemonStatus,
  removeSchedule,
  runDaemonWorker,
  setScheduleEnabled,
  summarizeSchedules,
  tickSchedules,
} from '../src/daemon/index.js';
import { ScheduleExprError } from '../src/daemon/cron.js';

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-sched-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('parses 5-field cron, aliases, @every, and HH:MM weekday forms', () => {
  const daily = parseScheduleExpr('@daily');
  assert.equal(daily.kind, 'cron');
  assert.equal(daily.source, '@daily');
  assert.ok(daily.minute.values.has(0));
  assert.ok(daily.hour.values.has(0));

  const hourly = parseScheduleExpr('@hourly');
  assert.ok(hourly.hour.any);

  const every = parseScheduleExpr('@every 15m');
  assert.equal(every.kind, 'every');
  assert.equal(every.everyMs, 15 * 60_000);

  const clock = parseScheduleExpr('09:00 mon-fri');
  assert.equal(clock.kind, 'cron');
  assert.ok(clock.minute.values.has(0));
  assert.ok(clock.hour.values.has(9));
  assert.deepEqual([...clock.weekday.values].sort(), [1, 2, 3, 4, 5]);

  const cron = parseScheduleExpr('*/15 8-17 * * 1-5');
  assert.ok(cron.minute.values.has(0));
  assert.ok(cron.minute.values.has(15));
  assert.ok(cron.hour.values.has(8));
  assert.ok(cron.hour.values.has(17));
});

test('rejects unsupported expressions with an actionable error', () => {
  assert.throws(() => parseScheduleExpr('@reboot'), ScheduleExprError);
  assert.throws(() => parseScheduleExpr('0 0 0 0 0 0'), /5 fields/);
  assert.throws(() => parseScheduleExpr('25:00'), /HH:MM/);
  assert.throws(() => parseScheduleExpr(''), /required/);
});

test('cron matching uses standard either-or for restricted dom and dow', () => {
  const parsed = parseScheduleExpr('0 0 1 * 1');
  assert.equal(matchesCron(parsed, { minute: 0, hour: 0, day: 1, month: 4, weekday: 3 }), true);
  assert.equal(matchesCron(parsed, { minute: 0, hour: 0, day: 6, month: 4, weekday: 1 }), true);
  assert.equal(matchesCron(parsed, { minute: 0, hour: 0, day: 6, month: 4, weekday: 3 }), false);
});

test('nextDueAfter walks local minutes for cron and adds @every intervals', () => {
  const mondayMorning = new Date(2026, 8, 14, 8, 30, 0); // local Monday
  const nextClock = nextDueAfter('09:00 mon-fri', mondayMorning);
  assert.equal(nextClock.getHours(), 9);
  assert.equal(nextClock.getMinutes(), 0);
  assert.equal(nextClock.getDay(), 1);

  const fridayNight = new Date(2026, 8, 18, 9, 1, 0);
  const afterWeekend = nextDueAfter('09:00 weekdays', fridayNight);
  assert.equal(afterWeekend.getDay(), 1);
  assert.equal(afterWeekend.getHours(), 9);

  const from = new Date('2026-09-17T00:00:00.000Z');
  assert.equal(nextDueAfter('@every 5m', from).getTime(), from.getTime() + 5 * 60_000);
});

test('store writes one JSON file and enable recomputes next due', async () => {
  await withHome(async (home) => {
    const added = await addSchedule(
      home,
      { expr: '@every 30m', goal: 'lint the repo', dryRun: true, autonomy: 'L3' },
      { idFactory: () => 'sch_test1', clock: () => new Date('2026-09-17T00:00:00.000Z') },
    );
    assert.equal(added.id, 'sch_test1');
    assert.equal(added.enabled, true);
    assert.equal(added.nextDueAt, '2026-09-17T00:30:00.000Z');
    const raw = JSON.parse(await readFile(join(home, 'daemon', 'schedules', 'sch_test1.json'), 'utf8'));
    assert.equal(raw.goal, 'lint the repo');
    assert.equal(raw.dryRun, true);

    const listed = await listSchedules(home);
    assert.equal(findSchedule(listed, 'sch_te').id, 'sch_test1');

    const disabled = await setScheduleEnabled(home, 'sch_test1', false);
    assert.equal(disabled.enabled, false);
    const enabled = await setScheduleEnabled(
      home,
      'sch_test1',
      true,
      { clock: () => new Date('2026-09-17T01:00:00.000Z') },
    );
    assert.equal(enabled.nextDueAt, '2026-09-17T01:30:00.000Z');

    assert.equal((await removeSchedule(home, 'sch_test1')).id, 'sch_test1');
    assert.deepEqual(await listSchedules(home), []);
  });
});

test('tick enqueues a daemon-run job and does not double-fire while it is in flight', async () => {
  await withHome(async (home) => {
    const clock = () => new Date('2026-09-17T00:31:00.000Z');
    await addSchedule(
      home,
      { expr: '@every 30m', goal: 'review open PRs', dryRun: true },
      { idFactory: () => 'sch_tick', clock: () => new Date('2026-09-17T00:00:00.000Z') },
    );
    const queue = new DaemonQueue(home, { idFactory: () => 'job_from_sched' });
    await queue.init();

    const first = await tickSchedules(home, queue, { clock });
    assert.equal(first.length, 1);
    assert.equal(first[0].scheduleId, 'sch_tick');
    const inbox = JSON.parse(await readFile(join(home, 'daemon', 'inbox', 'job_from_sched.json'), 'utf8'));
    assert.equal(inbox.type, 'run');
    assert.equal(inbox.goal, 'review open PRs');
    assert.equal(inbox.scheduleId, 'sch_tick');
    assert.equal(inbox.dryRun, true);

    const again = await tickSchedules(home, queue, { clock });
    assert.deepEqual(again, []);
    const names = await readdir(join(home, 'daemon', 'inbox'));
    assert.deepEqual(names.filter((name) => name.endsWith('.json')), ['job_from_sched.json']);

    await queue.drainInbox();
    const still = await tickSchedules(home, queue, { clock });
    assert.deepEqual(still, []);
    assert.equal(queue.jobs[0].status, 'queued');
    assert.equal(queue.jobs[0].scheduleId, 'sch_tick');
  });
});

test('disabled schedules never enqueue and status reports next due', async () => {
  await withHome(async (home) => {
    await addSchedule(
      home,
      { expr: '@every 10m', goal: 'skip me', enabled: false },
      { idFactory: () => 'sch_off', clock: () => new Date('2026-09-17T00:00:00.000Z') },
    );
    await addSchedule(
      home,
      { expr: '@every 1h', goal: 'later', enabled: true },
      { idFactory: () => 'sch_on', clock: () => new Date('2026-09-17T00:00:00.000Z') },
    );
    const queue = new DaemonQueue(home);
    await queue.init();
    const fired = await tickSchedules(home, queue, { clock: () => new Date('2026-09-17T00:20:00.000Z') });
    assert.deepEqual(fired, []);

    const summary = await summarizeSchedules(home, () => Date.parse('2026-09-17T00:00:00.000Z'));
    assert.equal(summary.count, 2);
    assert.equal(summary.enabled, 1);
    assert.equal(summary.nextId, 'sch_on');
    assert.equal(summary.nextDueAt, '2026-09-17T01:00:00.000Z');

    const status = await readDaemonStatus(home);
    assert.equal(status.schedules.count, 2);
    assert.equal(status.schedules.enabled, 1);
    assert.equal(status.schedules.nextId, 'sch_on');
  });
});

test('worker heartbeat ticks a due schedule into the inbox runner', async () => {
  await withHome(async (home) => {
    await addSchedule(
      home,
      { expr: '@every 1s', goal: 'heartbeat goal', dryRun: true },
      { idFactory: () => 'sch_beat', clock: () => new Date(Date.now() - 2_000) },
    );
    const jobs = [];
    const signals = new EventEmitter();
    const queue = new DaemonQueue(home, {
      runners: {
        run: async (job) => {
          jobs.push(job);
          return { runId: 'run_sched', status: 'dry-run' };
        },
      },
    });
    await queue.init();
    await runDaemonWorker({
      home,
      signals,
      queue,
      intervalMs: 10,
      heartbeatMs: 10,
      drainMs: 50,
      onReady: ({ stop }) => {
        setTimeout(() => stop(), 80);
      },
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].goal, 'heartbeat goal');
    assert.equal(jobs[0].scheduleId, 'sch_beat');
    assert.equal(publicSchedule(await listSchedules(home).then((items) => items[0])).lastFiredAt != null, true);
  });
});
