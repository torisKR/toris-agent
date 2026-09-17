import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT, TorisError } from '../src/core/errors.js';
import {
  acquireDaemonLock,
  DaemonQueue,
  daemonPaths,
  isDaemonRunning,
  isPidAlive,
  readDaemonStatus,
  reclaimStale,
  startDaemon,
  stopDaemon,
  submitDaemonJob,
  runDaemonWorker,
  waitUntil,
} from '../src/daemon/index.js';

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-daemon-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('isPidAlive treats this process as live and a bogus pid as dead', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(2_147_483_647), false);
  assert.equal(isPidAlive(9, (pid, signal) => {
    assert.equal(pid, 9);
    assert.equal(signal, 0);
    const err = new Error('denied');
    err.code = 'EPERM';
    throw err;
  }), true);
});

test('status is stopped when no lock exists', async () => {
  await withHome(async (home) => {
    const status = await readDaemonStatus(home);
    assert.equal(status.running, false);
    assert.equal(status.supported, true);
    assert.equal(status.pid, null);
    assert.equal(status.uptimeMs, 0);
    assert.equal(status.home, home);
    assert.equal(status.socket, null);
  });
});

test('acquire lock refuses a live owner and reclaims a stale pid', async () => {
  await withHome(async (home) => {
    const startedAt = '2026-09-17T00:00:00.000Z';
    await acquireDaemonLock(home, { pid: process.pid, startedAt, version: '0.4.0' });
    await assert.rejects(() => acquireDaemonLock(home, { pid: process.pid + 1, startedAt }), {
      code: 'E_DAEMON_RUNNING',
    });
    const live = await readDaemonStatus(home, () => Date.parse('2026-09-17T00:01:30.000Z'));
    assert.equal(live.running, true);
    assert.equal(live.pid, process.pid);
    assert.equal(live.uptimeMs, 90_000);

    await writeFile(daemonPaths(home).state, JSON.stringify({
      pid: 2_147_483_647,
      startedAt,
      heartbeatAt: startedAt,
      version: '0.4.0',
      home,
    }));
    assert.equal(await isDaemonRunning(home), false);
    assert.equal(await reclaimStale(home), true);
    await acquireDaemonLock(home, { pid: process.pid, startedAt, version: '0.4.0' });
    assert.equal((await readDaemonStatus(home)).running, true);
  });
});

test('inbox submit is durable and the worker heartbeats while running a job', async () => {
  await withHome(async (home) => {
    const jobs = [];
    const signals = new EventEmitter();
    const queue = new DaemonQueue(home, {
      idFactory: () => 'job_test1',
      runners: {
        run: async (job) => {
          jobs.push(job.goal);
          return { runId: 'run_1', status: 'dry-run' };
        },
      },
    });
    await queue.init();
    await submitDaemonJob(home, { id: 'job_test1', type: 'run', goal: 'add a health endpoint', dryRun: true });
    const inbox = await readFile(join(daemonPaths(home).inbox, 'job_test1.json'), 'utf8');
    assert.match(inbox, /add a health endpoint/);

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

    assert.deepEqual(jobs, ['add a health endpoint']);
    assert.equal(await isDaemonRunning(home), false);
    assert.equal(queue.jobs.find((job) => job.id === 'job_test1').status, 'succeeded');
    const persisted = JSON.parse(await readFile(join(home, 'daemon-jobs.json'), 'utf8'));
    assert.equal(persisted[0].result.runId, 'run_1');
  });
});

test('stop is a no-op when the daemon is already down', async () => {
  await withHome(async (home) => {
    const result = await stopDaemon(home);
    assert.equal(result.running, false);
    assert.equal(result.stopped, false);
    assert.match(result.reason, /not running/);
  });
});

test('start refuses a live daemon and reclaims a stale pid before spawn', async () => {
  await withHome(async (home) => {
    await acquireDaemonLock(home, { pid: process.pid, startedAt: new Date().toISOString() });
    await assert.rejects(() => startDaemon(home, { spawn() { throw new Error('must not spawn'); } }), TorisError);

    await writeFile(daemonPaths(home).state, JSON.stringify({
      pid: 2_147_483_647,
      startedAt: new Date().toISOString(),
      home,
    }));
    const spawned = [];
    const status = await startDaemon(home, {
      spawn: (_node, args) => {
        spawned.push(args);
        setImmediate(() => {
          acquireDaemonLock(home, { pid: process.pid, startedAt: new Date().toISOString() }).catch(() => undefined);
        });
        return { pid: process.pid, unref() {} };
      },
      readyTimeoutMs: 1000,
      pollMs: 10,
    });
    assert.equal(status.running, true);
    assert.match(spawned[0].join(' '), /daemon start --foreground/);
  });
});

test('stop signals the lock pid and does not leave a live status document', async () => {
  await withHome(async (home) => {
    await acquireDaemonLock(home, { pid: process.pid, startedAt: new Date().toISOString() });
    const { unlinkSync } = await import('node:fs');
    const signals = [];
    const result = await stopDaemon(home, {
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 'SIGTERM') {
          unlinkSync(daemonPaths(home).lock);
          unlinkSync(daemonPaths(home).state);
        }
      },
      stopTimeoutMs: 500,
      pollMs: 10,
    });
    assert.deepEqual(signals, [[process.pid, 'SIGTERM']]);
    assert.equal(result.stopped, true);
    assert.equal(result.running, false);
    assert.equal(await isDaemonRunning(home), false);
  });
});

test('waitUntil becomes true before the timeout', async () => {
  let n = 0;
  assert.equal(await waitUntil(() => (++n) >= 3, { timeoutMs: 200, intervalMs: 5 }), true);
  assert.equal(await waitUntil(() => false, { timeoutMs: 20, intervalMs: 5 }), false);
});

test('unsupported inbox types are rejected before they hit disk', async () => {
  await withHome(async (home) => {
    const queue = new DaemonQueue(home);
    await assert.rejects(() => queue.enqueueInbox({ type: 'cron', goal: 'tick' }), /run/);
    await mkdir(daemonPaths(home).inbox, { recursive: true });
    const names = await import('node:fs/promises').then((fs) => fs.readdir(daemonPaths(home).inbox));
    assert.deepEqual(names, []);
  });
});

test('EXIT.DAEMON_UNAVAILABLE stays 5', () => {
  assert.equal(EXIT.DAEMON_UNAVAILABLE, 5);
});
