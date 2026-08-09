import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueue } from '../src/studio/job-queue.js';

const withHome = async (fn) => {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-jobs-'));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
};

test('runs jobs with strict single concurrency and persists terminal results', async () => {
  await withHome(async (home) => {
    let active = 0;
    let maximum = 0;
    const queue = await new JobQueue(home, {
      idFactory: (() => { let n = 0; return () => `job_${++n}`; })(),
      runners: {
        work: async (job) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { value: job.value * 2 };
        },
      },
    }).init();
    const first = await queue.enqueue('work', { value: 2 });
    const second = await queue.enqueue('work', { value: 3 });
    await queue.waitForIdle();
    assert.equal(maximum, 1);
    assert.equal((await queue.get(first.id)).status, 'succeeded');
    assert.deepEqual((await queue.get(second.id)).result, { value: 6 });
    assert.equal((await queue.list()).length, 2);
  });
});

test('recovers running jobs to queued on init and supports failed jobs', async () => {
  await withHome(async (home) => {
    await writeFile(join(home, 'studio-jobs.json'), JSON.stringify([{
      id: 'old', type: 'work', value: 7, status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]));
    const queue = await new JobQueue(home, { runners: { work: async () => { throw new Error('nope'); } } }).init();
    assert.equal((await queue.get('old')).status, 'running');
    await queue.waitForIdle();
    assert.equal((await queue.get('old')).status, 'failed');
    assert.match((await queue.get('old')).error.message, /nope/);
  });
});
