import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { buildBrief } from '../src/core/brief.js';
import { loadConfig } from '../src/core/config.js';
import { dayKey } from '../src/core/cost.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { addSchedule } from '../src/daemon/index.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-brief-'));
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
    await fn({ base, home, studio });
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
}

function publicBrief(body) {
  const { generatedAt, ...rest } = body;
  return rest;
}

test('GET /brief is a standalone page that does not reuse app.js', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/brief`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="brief-title"/);
    assert.match(html, /\/assets\/brief\.js/);
    assert.doesNotMatch(html, /\/assets\/app\.js/);
    assert.match(html, /href="\/brief"/);
    assert.equal((await fetch(`${base}/assets/brief.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/brief.css`)).status, 200);
  });
});

test('GET /api/brief is a same-origin read of buildBrief', async () => {
  await withServer(async ({ base, home, studio }) => {
    const response = await fetch(`${base}/api/brief`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.period, 'today');
    assert.equal(body.timezone, 'local');
    assert.match(body.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(body.generatedAt);
    assert.equal(body.spend.spentUsd, 0);
    assert.equal(body.spend.capUsd, 20);
    assert.deepEqual(body.runs, []);
    assert.equal(body.daemon.running, false);
    assert.equal(body.daemon.nextDueAt, null);
    assert.equal(body.knowledge.available, false);
    assert.deepEqual(body.knowledge.headlines, []);

    const { config } = await loadConfig(home);
    const expected = await buildBrief({
      home,
      store: studio.store,
      config,
      cwd: home,
    });
    assert.deepEqual(publicBrief(body), { ok: true, ...publicBrief(expected) });
  });
});

test('GET /api/brief stays readable without a session token and has no mutations', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/brief`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);

    const posted = await fetch(`${base}/api/brief`, {
      method: 'POST',
      headers: {
        origin: base,
        'x-toris-studio-token': 'test-token',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(posted.status, 404);

    const unknown = await fetch(`${base}/api/brief?period=week`);
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error.message, /Unknown brief period/);
  });
});

test('GET /api/brief surfaces spend, today runs, daemon next due, and knowledge headlines', async () => {
  await withServer(async ({ base, home, studio }) => {
    const today = dayKey(new Date());
    await studio.store.saveRun({
      id: 'run_briefok',
      goal: 'add a health endpoint for the flutter play release',
      status: 'succeeded',
      costUsd: 1.25,
      createdAt: `${today}T09:00:00.000`,
      finishedAt: `${today}T09:01:00.000`,
      verification: { passed: true, checks: [{ command: 'npm test', passed: true, exitCode: 0 }] },
    });
    await studio.store.saveRun({
      id: 'run_yest',
      goal: 'old work',
      status: 'succeeded',
      costUsd: 9,
      createdAt: '2020-01-01T09:00:00.000',
      finishedAt: '2020-01-01T09:01:00.000',
      verification: { passed: true, checks: [] },
    });
    await addSchedule(home, { expr: '@daily', goal: 'lint the repo', dryRun: true });
    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });

    const body = await (await fetch(`${base}/api/brief`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.spend.spentUsd, 1.25);
    assert.equal(body.spend.runCount, 1);
    assert.deepEqual(body.runs.map((run) => run.id), ['run_briefok']);
    assert.equal(body.runs[0].verify, 'pass');
    assert.equal(body.runs[0].status, 'succeeded');
    assert.ok(body.runs[0].goal);
    assert.ok(!body.runs.some((run) => run.id === 'run_yest'));
    assert.equal(body.daemon.running, false);
    assert.equal(body.daemon.scheduleCount, 1);
    assert.ok(body.daemon.nextDueAt);
    assert.equal(body.knowledge.available, true);
    assert.ok(body.knowledge.headlines.length >= 1);
    assert.ok(body.knowledge.headlines.length <= 5);
    assert.ok(body.knowledge.headlines.every((item) => item.kind && item.id && item.title));

    const { config } = await loadConfig(home);
    const expected = await buildBrief({
      home,
      store: studio.store,
      config,
      cwd: home,
    });
    assert.deepEqual(publicBrief(body), { ok: true, ...publicBrief(expected) });
  });
});
