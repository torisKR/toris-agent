import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createId } from '../core/ids.js';
import { Store } from '../core/store.js';
import { daemonPaths } from './paths.js';
import { emptyJobCounts } from './state.js';

export const DAEMON_JOB_TYPES = Object.freeze({ RUN: 'run' });
export const DAEMON_JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
});

const COLLECTION = 'daemon-jobs';

function iso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('clock must produce a valid date');
  return date.toISOString();
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

/**
 * Durable inbox + in-home job list.
 *
 * A client (another `toris` process) never writes `daemon-jobs.json` — that
 * file is the worker's. Clients drop one JSON file into `daemon/inbox/` so a
 * crash mid-write cannot corrupt the collection. The worker is the only
 * process that drains the inbox.
 */
export class DaemonQueue {
  constructor(home, options = {}) {
    this.home = home;
    this.paths = daemonPaths(home);
    this.store = options.store || new Store(home);
    this.clock = options.clock || (() => new Date());
    this.idFactory = options.idFactory || (() => createId('job'));
    this.runners = options.runners || {};
    this.jobs = [];
    this.initialized = false;
    this.busy = false;
    this.write = Promise.resolve();
  }

  async init() {
    await this.store.init();
    await mkdir(this.paths.inbox, { recursive: true });
    this.jobs = await this.store.readCollection(COLLECTION);
    let recovered = false;
    for (const job of this.jobs) {
      if (job.status === DAEMON_JOB_STATUS.RUNNING) {
        job.status = DAEMON_JOB_STATUS.QUEUED;
        job.updatedAt = iso(this.clock);
        recovered = true;
      }
    }
    if (recovered) await this.store.writeCollection(COLLECTION, this.jobs);
    this.initialized = true;
    return this;
  }

  counts() {
    const counts = emptyJobCounts();
    for (const job of this.jobs) {
      if (Object.hasOwn(counts, job.status)) counts[job.status] += 1;
    }
    return counts;
  }

  recent(limit = 10) {
    return this.jobs.slice(-limit).map(publicDaemonJob);
  }

  async enqueueInbox(input) {
    await mkdir(this.paths.inbox, { recursive: true });
    const type = String(input.type || DAEMON_JOB_TYPES.RUN).trim();
    if (type !== DAEMON_JOB_TYPES.RUN) {
      throw new Error(`Unsupported daemon job type "${type}". This release accepts "run" only.`);
    }
    const goal = String(input.goal || '').trim();
    if (!goal) throw new Error('run job requires a goal');
    const now = iso(this.clock);
    const job = {
      id: input.id || this.idFactory(),
      type,
      status: DAEMON_JOB_STATUS.QUEUED,
      goal,
      cwd: input.cwd ?? null,
      project: input.project ?? null,
      autonomy: input.autonomy ?? null,
      dryRun: Boolean(input.dryRun),
      budgetUsd: input.budgetUsd ?? null,
      provider: input.provider ?? null,
      apply: Boolean(input.apply),
      review: input.review !== false,
      scheduleId: input.scheduleId ?? null,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const target = join(this.paths.inbox, `${job.id}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, target);
    return clone(job);
  }

  async drainInbox() {
    let names = [];
    try {
      names = await readdir(this.paths.inbox);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const accepted = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const file = join(this.paths.inbox, name);
      let raw;
      try {
        raw = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        continue;
      }
      if (!raw?.id) {
        await unlink(file).catch(() => undefined);
        continue;
      }
      if (!this.jobs.some((job) => job.id === raw.id)) {
        this.jobs.push({
          ...raw,
          status: DAEMON_JOB_STATUS.QUEUED,
          updatedAt: iso(this.clock),
        });
        accepted.push(raw.id);
      }
      await unlink(file).catch(() => undefined);
    }
    if (accepted.length > 0) await this.#persist();
    return accepted;
  }

  /**
   * Start at most one job. Returns a promise for the active step so the
   * worker loop can keep heartbeating while a long `run` executes.
   */
  kick() {
    if (this.busy || !this.initialized) return null;
    const job = this.jobs.find((item) => item.status === DAEMON_JOB_STATUS.QUEUED);
    if (!job) return null;
    this.busy = true;
    const done = this.#run(job).finally(() => {
      this.busy = false;
    });
    return done;
  }

  async #run(job) {
    job.status = DAEMON_JOB_STATUS.RUNNING;
    job.updatedAt = iso(this.clock);
    await this.#persist();
    try {
      const runner = this.runners[job.type];
      if (typeof runner !== 'function') throw new Error(`No runner for job type "${job.type}"`);
      job.result = clone(await runner(clone(job)));
      job.status = DAEMON_JOB_STATUS.SUCCEEDED;
      job.error = null;
    } catch (error) {
      job.status = DAEMON_JOB_STATUS.FAILED;
      job.error = { name: error?.name || 'Error', message: error?.message || String(error) };
      job.result = null;
    }
    job.updatedAt = iso(this.clock);
    await this.#persist();
    return job;
  }

  #persist() {
    const snapshot = this.jobs.map(clone);
    const result = this.write.then(() => this.store.writeCollection(COLLECTION, snapshot));
    this.write = result.catch(() => undefined);
    return result;
  }
}

export function publicDaemonJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    goal: job.goal ?? null,
    runId: job.result?.runId ?? null,
    scheduleId: job.scheduleId ?? null,
    dryRun: Boolean(job.dryRun),
    error: typeof job.error === 'string' ? job.error : job.error?.message ?? null,
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
  };
}

/**
 * Read-only worker history. Does not drain the inbox or rewrite running jobs,
 * so Studio can list history while the daemon owns `daemon-jobs.json`.
 */
export async function listRecentDaemonJobs(home, options = {}) {
  const store = options.store || new Store(home);
  await store.init();
  const jobs = await store.readCollection(COLLECTION);
  const rawLimit = Number(options.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  return jobs.slice(-limit).reverse().map(publicDaemonJob);
}

export async function submitDaemonJob(home, input, options = {}) {
  const queue = new DaemonQueue(home, options);
  return queue.enqueueInbox(input);
}
