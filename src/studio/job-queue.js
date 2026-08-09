import { createId } from '../core/ids.js';
import { Store } from '../core/store.js';

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded',
  FAILED: 'failed', CANCELLED: 'cancelled',
});

const TERMINAL = new Set([JOB_STATUS.SUCCEEDED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED]);
const COLLECTION = 'studio-jobs';

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('clock must produce a valid date');
  return date.toISOString();
}

function clone(value) { return value == null ? value : structuredClone(value); }

export class JobQueue {
  constructor(home, options = {}) {
    this.store = new Store(home);
    this.runners = options.runners || options.jobRunners || {};
    this.clock = options.clock || options.now || (() => new Date());
    this.idFactory = options.idFactory || (() => createId('job'));
    this.jobs = [];
    this.initialized = false;
    this.running = false;
    this.write = Promise.resolve();
    this.idleWaiters = [];
  }

  async init() {
    await this.store.init();
    this.jobs = await this.store.readCollection(COLLECTION);
    let recovered = false;
    for (const job of this.jobs) {
      if (job.status === JOB_STATUS.RUNNING) {
        job.status = JOB_STATUS.QUEUED;
        job.updatedAt = timestamp(this.clock);
        recovered = true;
      }
    }
    if (recovered) await this.store.writeCollection(COLLECTION, this.jobs);
    this.initialized = true;
    this.#pump();
    return this;
  }

  async list() {
    await this.write;
    return this.jobs.map(clone);
  }

  async get(id) {
    await this.write;
    const job = this.jobs.find((item) => item.id === id);
    return job ? clone(job) : null;
  }

  enqueue(typeOrInput, payload) {
    if (!this.initialized) return Promise.reject(new Error('JobQueue must be initialized'));
    const input = typeof typeOrInput === 'string'
      ? { ...(payload && typeof payload === 'object' ? payload : {}), type: typeOrInput }
      : { ...(typeOrInput || {}) };
    const type = String(input.type || '').trim();
    if (!type) return Promise.reject(new Error('job type is required'));
    const now = timestamp(this.clock);
    const job = {
      ...clone(input), id: input.id || this.idFactory(), type,
      status: JOB_STATUS.QUEUED, result: null, error: null,
      createdAt: now, updatedAt: now,
    };
    this.jobs.push(job);
    const result = this.#persist();
    result.then(() => this.#pump());
    return result.then(() => clone(job));
  }

  waitForIdle() {
    if (!this.running && !this.jobs.some((job) => job.status === JOB_STATUS.QUEUED)) {
      return this.write.then(() => undefined);
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  #persist() {
    const snapshot = this.jobs.map(clone);
    const result = this.write.then(() => this.store.writeCollection(COLLECTION, snapshot));
    this.write = result.catch(() => undefined);
    return result;
  }

  #pump() {
    if (!this.initialized || this.running) return;
    const job = this.jobs.find((item) => item.status === JOB_STATUS.QUEUED);
    if (!job) { this.#resolveIdle(); return; }
    this.running = true;
    job.status = JOB_STATUS.RUNNING;
    job.updatedAt = timestamp(this.clock);
    this.#persist().then(async () => {
      try {
        const runner = typeof this.runners === 'function' ? this.runners : this.runners[job.type];
        if (typeof runner !== 'function') throw new Error(`Unknown job type: ${job.type}`);
        job.result = clone(await runner(clone(job)));
        job.status = JOB_STATUS.SUCCEEDED;
        job.error = null;
      } catch (error) {
        job.status = JOB_STATUS.FAILED;
        job.error = { name: error?.name || 'Error', message: error?.message || String(error) };
        job.result = null;
      }
      job.updatedAt = timestamp(this.clock);
      await this.#persist();
    }).finally(() => {
      this.running = false;
      this.#pump();
    });
  }

  #resolveIdle() {
    if (this.running || this.jobs.some((job) => !TERMINAL.has(job.status))) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

