import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createId } from '../core/ids.js';
import { daemonPaths } from './paths.js';
import { describeExpr, nextDueAfter, parseScheduleExpr, ScheduleExprError } from './cron.js';

const IN_FLIGHT = new Set(['queued', 'running']);

function iso(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('clock must produce a valid date');
  return { date, iso: date.toISOString() };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function emptyScheduleSummary() {
  return { count: 0, enabled: 0, nextDueAt: null, nextId: null };
}

export function schedulesDir(home) {
  return daemonPaths(home).schedules;
}

function schedulePath(home, id) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw new ScheduleExprError(`Invalid schedule id "${id}".`);
  }
  return join(schedulesDir(home), `${id}.json`);
}

export function publicSchedule(record) {
  if (!record) return null;
  return {
    id: record.id,
    expr: record.expr,
    goal: record.goal,
    enabled: record.enabled,
    autonomy: record.autonomy ?? null,
    budgetUsd: record.budgetUsd ?? null,
    dryRun: Boolean(record.dryRun),
    apply: Boolean(record.apply),
    review: record.review !== false,
    provider: record.provider ?? null,
    cwd: record.cwd ?? null,
    project: record.project ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastFiredAt: record.lastFiredAt ?? null,
    nextDueAt: record.nextDueAt ?? null,
    describe: describeExpr(record.expr),
  };
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const expr = String(raw.expr || '').trim();
  const goal = String(raw.goal || '').trim();
  if (!id || !expr || !goal) return null;
  parseScheduleExpr(expr);
  return {
    id,
    expr,
    goal,
    enabled: raw.enabled !== false,
    autonomy: raw.autonomy ?? null,
    budgetUsd: typeof raw.budgetUsd === 'number' ? raw.budgetUsd : null,
    dryRun: Boolean(raw.dryRun),
    apply: Boolean(raw.apply),
    review: raw.review !== false,
    provider: raw.provider ?? null,
    cwd: raw.cwd ?? null,
    project: raw.project ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lastFiredAt: raw.lastFiredAt ?? null,
    nextDueAt: raw.nextDueAt ?? null,
  };
}

async function writeRecord(home, record) {
  const dir = schedulesDir(home);
  await mkdir(dir, { recursive: true });
  const target = schedulePath(home, record.id);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, target);
  return clone(record);
}

export async function listSchedules(home) {
  let names = [];
  try {
    names = await readdir(schedulesDir(home));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const items = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(schedulesDir(home), name), 'utf8'));
      const record = normalizeRecord(raw);
      if (record) items.push(record);
    } catch {
      continue;
    }
  }
  return items;
}

export async function readSchedule(home, id) {
  try {
    return normalizeRecord(JSON.parse(await readFile(schedulePath(home, id), 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function findSchedule(schedules, ref) {
  if (!ref) return null;
  const exact = schedules.find((item) => item.id === ref);
  if (exact) return exact;
  const matches = schedules.filter((item) => item.id.startsWith(ref));
  return matches.length === 1 ? matches[0] : null;
}

export async function addSchedule(home, input, options = {}) {
  const clock = options.clock || (() => new Date());
  const { date, iso: now } = iso(clock);
  const expr = String(input.expr || '').trim();
  const goal = String(input.goal || '').trim();
  parseScheduleExpr(expr);
  if (!goal) throw new ScheduleExprError('Schedule requires a goal.');
  const record = {
    id: input.id || (options.idFactory || (() => createId('sch')))(),
    expr,
    goal,
    enabled: input.enabled !== false,
    autonomy: input.autonomy ?? null,
    budgetUsd: input.budgetUsd ?? null,
    dryRun: Boolean(input.dryRun),
    apply: Boolean(input.apply),
    review: input.review !== false,
    provider: input.provider ?? null,
    cwd: input.cwd ?? null,
    project: input.project ?? null,
    createdAt: now,
    updatedAt: now,
    lastFiredAt: null,
    nextDueAt: nextDueAfter(expr, date).toISOString(),
  };
  await writeRecord(home, record);
  return clone(record);
}

export async function removeSchedule(home, id) {
  const current = await readSchedule(home, id);
  if (!current) return null;
  await unlink(schedulePath(home, id)).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  return current;
}

export async function setScheduleEnabled(home, id, enabled, options = {}) {
  const current = await readSchedule(home, id);
  if (!current) return null;
  const clock = options.clock || (() => new Date());
  const { date, iso: now } = iso(clock);
  current.enabled = Boolean(enabled);
  current.updatedAt = now;
  if (current.enabled) {
    current.nextDueAt = nextDueAfter(current.expr, date).toISOString();
  }
  await writeRecord(home, current);
  return clone(current);
}

export async function markScheduleFired(home, id, when, options = {}) {
  const current = await readSchedule(home, id);
  if (!current) return null;
  const { date, iso: now } = iso(when ?? options.clock ?? (() => new Date()));
  current.lastFiredAt = now;
  current.updatedAt = now;
  current.nextDueAt = nextDueAfter(current.expr, date).toISOString();
  await writeRecord(home, current);
  return clone(current);
}

export function summarizeScheduleList(schedules, now = Date.now) {
  const t = typeof now === 'function' ? now() : now;
  const enabled = schedules.filter((item) => item.enabled);
  let next = null;
  for (const item of enabled) {
    const due = Date.parse(item.nextDueAt);
    if (!Number.isFinite(due)) continue;
    if (!next || due < next.due) next = { due, id: item.id, at: item.nextDueAt };
  }
  return {
    count: schedules.length,
    enabled: enabled.length,
    nextDueAt: next?.at ?? null,
    nextId: next?.id ?? null,
    overdue: Boolean(next && next.due <= t),
  };
}

export async function summarizeSchedules(home, now = Date.now) {
  return summarizeScheduleList(await listSchedules(home), now);
}

function inFlightFromJobs(jobs) {
  const ids = new Set();
  for (const job of jobs || []) {
    if (!job?.scheduleId) continue;
    if (IN_FLIGHT.has(job.status)) ids.add(job.scheduleId);
  }
  return ids;
}

async function inFlightFromInbox(inbox) {
  const ids = new Set();
  let names = [];
  try {
    names = await readdir(inbox);
  } catch (err) {
    if (err.code === 'ENOENT') return ids;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(inbox, name), 'utf8'));
      if (raw?.scheduleId) ids.add(raw.scheduleId);
    } catch {
      continue;
    }
  }
  return ids;
}

export async function inFlightScheduleIds(queue) {
  const ids = inFlightFromJobs(queue?.jobs);
  if (queue?.paths?.inbox) {
    for (const id of await inFlightFromInbox(queue.paths.inbox)) ids.add(id);
  }
  return ids;
}

/**
 * Enqueue one `run` job per due schedule, using the same inbox as `daemon run`.
 * Skips a schedule while it already has a queued or running job.
 */
export async function tickSchedules(home, queue, options = {}) {
  const clock = options.clock || (() => new Date());
  const { date } = iso(clock);
  const schedules = await listSchedules(home);
  const inFlight = await inFlightScheduleIds(queue);
  const fired = [];
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const due = Date.parse(schedule.nextDueAt);
    if (!Number.isFinite(due) || due > date.getTime()) continue;
    if (inFlight.has(schedule.id)) continue;
    const job = await queue.enqueueInbox({
      type: 'run',
      goal: schedule.goal,
      cwd: schedule.cwd,
      project: schedule.project,
      autonomy: schedule.autonomy,
      dryRun: schedule.dryRun,
      budgetUsd: schedule.budgetUsd,
      provider: schedule.provider,
      apply: schedule.apply,
      review: schedule.review,
      scheduleId: schedule.id,
    });
    inFlight.add(schedule.id);
    await markScheduleFired(home, schedule.id, date);
    fired.push({ scheduleId: schedule.id, jobId: job.id });
  }
  return fired;
}
