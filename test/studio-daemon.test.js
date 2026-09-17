import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { acquireDaemonLock, addSchedule, releaseDaemonLock } from '../src/daemon/index.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-daemon-'));
  const studio = await createStudioServer({
    home,
    cwd: home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
  });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    await fn({ base, home });
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
}

function mutation(base, body = {}) {
  return {
    method: 'POST',
    headers: {
      origin: base,
      'x-toris-studio-token': 'test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

test('GET /daemon is a standalone page that does not reuse app.js', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/daemon`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="daemon-title"/);
    assert.match(html, /\/assets\/daemon\.js/);
    assert.doesNotMatch(html, /\/assets\/app\.js/);
    assert.equal((await fetch(`${base}/assets/daemon.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/daemon.css`)).status, 200);
  });
});

test('GET /api/daemon reports stopped status and empty lists by default', async () => {
  await withServer(async ({ base, home }) => {
    const response = await fetch(`${base}/api/daemon`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.status.running, false);
    assert.equal(body.status.pid, null);
    assert.equal(body.status.uptimeMs, 0);
    assert.equal(body.status.home, home);
    assert.equal(body.status.socket, null);
    assert.deepEqual(body.status.jobs, { queued: 0, running: 0, succeeded: 0, failed: 0 });
    assert.equal(body.status.schedules.count, 0);
    assert.equal(body.status.schedules.nextDueAt, null);
    assert.deepEqual(body.schedules, []);
    assert.deepEqual(body.recentJobs, []);
  });
});

test('GET /api/daemon reflects a live lock and worker job history', async () => {
  await withServer(async ({ base, home }) => {
    const startedAt = '2026-09-17T00:00:00.000Z';
    await acquireDaemonLock(home, { pid: process.pid, startedAt, version: '0.4.0' });
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'daemon-jobs.json'), `${JSON.stringify([
      {
        id: 'job_old',
        type: 'run',
        status: 'succeeded',
        goal: 'older job',
        dryRun: true,
        result: { runId: 'run_old' },
        scheduleId: null,
        createdAt: '2026-09-17T00:00:01.000Z',
        updatedAt: '2026-09-17T00:00:02.000Z',
      },
      {
        id: 'job_new',
        type: 'run',
        status: 'failed',
        goal: 'newer job',
        dryRun: false,
        result: null,
        error: { message: 'boom' },
        scheduleId: 'sch_1',
        createdAt: '2026-09-17T00:00:03.000Z',
        updatedAt: '2026-09-17T00:00:04.000Z',
      },
    ], null, 2)}\n`);
    try {
      const body = await (await fetch(`${base}/api/daemon`)).json();
      assert.equal(body.status.running, true);
      assert.equal(body.status.pid, process.pid);
      assert.equal(body.status.startedAt, startedAt);
      assert.ok(body.status.uptimeMs >= 0);
      assert.equal(body.recentJobs.length, 2);
      assert.equal(body.recentJobs[0].id, 'job_new');
      assert.equal(body.recentJobs[0].runId, null);
      assert.equal(body.recentJobs[0].error, 'boom');
      assert.equal(body.recentJobs[1].runId, 'run_old');
      assert.equal(body.recentJobs[1].dryRun, true);
    } finally {
      await releaseDaemonLock(home);
    }
  });
});

test('schedule mutations require Origin + session token and reuse the store', async () => {
  await withServer(async ({ base }) => {
    const denied = await fetch(`${base}/api/daemon/schedules`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403);

    const badOrigin = await fetch(`${base}/api/daemon/schedules`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5824',
        'x-toris-studio-token': 'test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expr: '@daily', goal: 'lint' }),
    });
    assert.equal(badOrigin.status, 403);

    const missing = await fetch(`${base}/api/daemon/schedules`, mutation(base, { expr: '@daily' }));
    assert.equal(missing.status, 400);

    const invalid = await fetch(`${base}/api/daemon/schedules`, mutation(base, { expr: '@reboot', goal: 'nope' }));
    assert.equal(invalid.status, 400);

    const created = await fetch(`${base}/api/daemon/schedules`, mutation(base, {
      expr: '@every 30m',
      goal: 'lint the repo',
      dryRun: true,
    }));
    assert.equal(created.status, 201);
    const added = await created.json();
    assert.equal(added.ok, true);
    assert.equal(added.schedule.expr, '@every 30m');
    assert.equal(added.schedule.goal, 'lint the repo');
    assert.equal(added.schedule.enabled, true);
    assert.equal(added.schedule.dryRun, true);
    assert.ok(added.schedule.nextDueAt);
    const id = added.schedule.id;

    const listed = await (await fetch(`${base}/api/daemon/schedules`)).json();
    assert.equal(listed.count, 1);
    assert.equal(listed.enabled, 1);
    assert.equal(listed.items[0].id, id);
    assert.equal(listed.nextId, id);

    const snapshot = await (await fetch(`${base}/api/daemon`)).json();
    assert.equal(snapshot.status.schedules.count, 1);
    assert.equal(snapshot.status.schedules.nextId, id);

    const disabled = await fetch(`${base}/api/daemon/schedules/${id}/disable`, mutation(base, {}));
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).schedule.enabled, false);
    assert.equal((await (await fetch(`${base}/api/daemon/schedules`)).json()).enabled, 0);

    const enabled = await fetch(`${base}/api/daemon/schedules/${id}/enable`, mutation(base, {}));
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).schedule.enabled, true);

    assert.equal((await fetch(`${base}/api/daemon/schedules/missing/remove`, mutation(base, {}))).status, 404);

    const removed = await fetch(`${base}/api/daemon/schedules/${id}/remove`, mutation(base, {}));
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).removed, true);
    assert.equal((await (await fetch(`${base}/api/daemon/schedules`)).json()).count, 0);
  });
});

test('Studio schedule add writes the same files as the CLI helper', async () => {
  await withServer(async ({ base, home }) => {
    const viaHelper = await addSchedule(home, { expr: '@daily', goal: 'from helper', dryRun: true });
    const viaApi = await (await fetch(`${base}/api/daemon/schedules`, mutation(base, {
      expr: '09:00 mon-fri',
      goal: 'from studio',
    }))).json();
    const listed = await (await fetch(`${base}/api/daemon/schedules`)).json();
    const ids = listed.items.map((item) => item.id).sort();
    assert.deepEqual(ids, [viaApi.schedule.id, viaHelper.id].sort());
    assert.ok(listed.items.every((item) => item.nextDueAt && item.expr && item.goal));
  });
});
