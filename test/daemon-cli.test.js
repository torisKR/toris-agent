import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cmdDaemon } from '../src/cli/commands/daemon.js';
import { EXIT } from '../src/core/errors.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { isPidAlive, readDaemonStatus, waitUntil } from '../src/daemon/index.js';

const BIN = fileURLToPath(new URL('../bin/toris.js', import.meta.url));

async function captureJson(fn) {
  const chunks = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await fn();
    const body = JSON.parse(chunks.join('') || 'null');
    return { code, body };
  } finally {
    process.stdout.write = write;
  }
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-daemon-cli-'));
  try {
    await writeFile(join(home, 'config.json'), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function ctx(home, extra = {}) {
  return {
    home,
    cwd: home,
    json: true,
    config: DEFAULT_CONFIG,
    configExists: true,
    store: new Store(home),
    ...extra,
  };
}

test('status is json-scriptable when the daemon is down', async () => {
  await withHome(async (home) => {
    const { code, body } = await captureJson(() => cmdDaemon(ctx(home), ['status'], {}));
    assert.equal(code, EXIT.OK);
    assert.equal(body.running, false);
    assert.equal(body.supported, true);
    assert.equal(body.home, home);
    assert.equal(body.socket, null);
  });
});

test('unknown subcommand is a usage error', async () => {
  await withHome(async (home) => {
    await assert.rejects(() => cmdDaemon(ctx(home), ['serve'], {}), /start \| stop \| status \| run/);
  });
});

test('daemon run exits 5 when the worker is not up', async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () => cmdDaemon(ctx(home), ['run', 'add a health endpoint'], { 'dry-run': true }),
      (err) => err.exitCode === EXIT.DAEMON_UNAVAILABLE && /not running/.test(err.message),
    );
  });
});

test('start refuses a second live owner without spawning', async () => {
  await withHome(async (home) => {
    const { acquireDaemonLock } = await import('../src/daemon/index.js');
    await acquireDaemonLock(home, { pid: process.pid, startedAt: new Date().toISOString() });
    await assert.rejects(
      () => cmdDaemon(ctx(home), ['start'], {}, { spawn() { throw new Error('must not spawn'); } }),
      /already running/,
    );
  });
});

test('start --foreground heartbeats and stops on SIGTERM', async () => {
  await withHome(async (home) => {
    const signals = new EventEmitter();
    const { code, body } = await captureJson(() =>
      cmdDaemon(ctx(home), ['start'], { foreground: true }, {
        signals,
        runJob: async (job) => ({ runId: 'run_fg', status: 'dry-run', goal: job.goal }),
        onReady: ({ stop }) => setImmediate(() => stop()),
      }),
    );
    assert.equal(code, EXIT.OK);
    assert.equal(body.foreground, true);
    assert.equal(body.running, true);
    assert.equal(await readDaemonStatus(home).then((s) => s.running), false);
  });
});

test('queued run is written only after a live status check', async () => {
  await withHome(async (home) => {
    const submitted = [];
    const { code, body } = await captureJson(() =>
      cmdDaemon(ctx(home), ['run', 'ship the daemon'], { 'dry-run': true }, {
        isRunning: async () => true,
        submit: async (_home, job) => {
          submitted.push(job);
          return { id: 'job_cli', ...job, status: 'queued' };
        },
      }),
    );
    assert.equal(code, EXIT.OK);
    assert.equal(body.queued, true);
    assert.equal(submitted[0].goal, 'ship the daemon');
    assert.equal(submitted[0].dryRun, true);
    assert.equal(submitted[0].type, 'run');
  });
});

test('start, queue a dry-run, stop — real child process', async () => {
  await withHome(async (home) => {
    let pid = null;
    try {
      const started = await captureJson(() =>
        cmdDaemon(ctx(home), ['start'], {}, { binPath: BIN, readyTimeoutMs: 10_000 }),
      );
      assert.equal(started.code, EXIT.OK, JSON.stringify(started.body));
      assert.equal(started.body.running, true);
      pid = started.body.pid;
      assert.equal(isPidAlive(pid), true);

      const dup = await cmdDaemon(ctx(home), ['start'], {}, { binPath: BIN }).then(
        () => ({ threw: false }),
        (err) => ({ threw: true, message: err.message }),
      );
      assert.equal(dup.threw, true);
      assert.match(dup.message, /already running/);

      const queued = await captureJson(() =>
        cmdDaemon(ctx(home), ['run', 'add a health endpoint'], { 'dry-run': true }),
      );
      assert.equal(queued.code, EXIT.OK);
      assert.equal(queued.body.queued, true);

      const finished = await waitUntil(async () => {
        const status = await readDaemonStatus(home);
        return status.jobs?.succeeded >= 1;
      }, { timeoutMs: 15_000, intervalMs: 100 });
      assert.equal(finished, true, 'queued dry-run should complete under the daemon');

      const after = await readDaemonStatus(home);
      assert.equal(after.running, true);
      assert.ok(after.uptimeMs >= 0);
      assert.equal(after.recentJobs[0]?.goal, 'add a health endpoint');
      assert.ok(after.recentJobs[0]?.runId);

      const stopped = await captureJson(() => cmdDaemon(ctx(home), ['stop'], {}));
      assert.equal(stopped.code, EXIT.OK);
      assert.equal(stopped.body.running, false);
      assert.equal(isPidAlive(pid), false);
      pid = null;

      const down = await captureJson(() => cmdDaemon(ctx(home), ['status'], {}));
      assert.equal(down.body.running, false);
    } finally {
      if (pid && isPidAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        await waitUntil(() => !isPidAlive(pid), { timeoutMs: 2000, intervalMs: 50 });
      }
    }
  });
});
