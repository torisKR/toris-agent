import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { presentReflect } from '../src/studio/knowledge-reflect.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-reflect-'));
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

function mutation(base, body, extra = {}) {
  return {
    method: 'POST',
    headers: {
      origin: base,
      'x-toris-studio-token': 'test-token',
      'content-type': 'application/json',
      ...extra.headers,
    },
    body: JSON.stringify(body),
  };
}

function verifiedRun(overrides = {}) {
  return {
    id: 'run_studiook1',
    goal: 'Fix Flutter jank on a mid-range Android phone',
    status: 'succeeded',
    autonomy: 'L3',
    provider: 'claude',
    costUsd: 0.12,
    createdAt: '2026-09-17T00:00:00.000Z',
    finishedAt: '2026-09-17T00:02:00.000Z',
    tasks: [{ id: 't1', title: 'Measure raster budget', status: 'succeeded', agent: 'implementer' }],
    verification: {
      passed: true,
      checks: [{ command: 'flutter test', passed: true, exitCode: 0 }],
    },
    review: { passed: true, summary: 'Opposite review passed.' },
    ...overrides,
  };
}

function failedRun() {
  return verifiedRun({
    id: 'run_studiobad',
    status: 'failed',
    goal: 'Ship the Flutter play bundle',
    verification: {
      passed: false,
      checks: [{ command: 'flutter test', passed: false, exitCode: 1 }],
    },
  });
}

async function countTacit(home) {
  const knowledge = new KnowledgeStore({ home, projectPath: home });
  if (!(await knowledge.status()).ok) return { inbox: 0, tacit: 0 };
  const inbox = await knowledge.listInbox();
  let tacit = 0;
  for (const domain of await knowledge.listDomains()) {
    tacit += (await knowledge.listTacit(domain.slug)).length;
  }
  return { inbox: inbox.length, tacit };
}

test('presentReflect hides failed or unverified receipts as success proposals', () => {
  const hidden = presentReflect({
    notable: true,
    reason: 'should not leak',
    proposals: [{ id: 'nope', title: 'Nope', goal: 'Nope', outcome: 'failed', domain: 'flutter-android' }],
    source: { kind: 'receipt', runId: 'run_studiobad', verified: false },
  });
  assert.equal(hidden.notable, false);
  assert.equal(hidden.written, false);
  assert.equal(hidden.proposal, null);
});

test('GET /knowledge includes the reflect accept panel', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/knowledge`)).text();
    assert.match(html, /id="reflect-panel"/);
    assert.match(html, /id="reflect-accept"/);
    assert.match(html, /id="reflect-dismiss"/);
    assert.match(html, /id="reflect-empty"/);
  });
});

test('GET /api/knowledge/reflect does not write and stays quiet without a verified run', async () => {
  await withServer(async ({ base, home }) => {
    const before = await countTacit(home);
    const response = await fetch(`${base}/api/knowledge/reflect`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.written, false);
    assert.equal(body.notable, false);
    assert.equal(body.proposal, null);
    assert.deepEqual(await countTacit(home), before);
  });
});

test('failed or unverified receipts do not appear as success proposals', async () => {
  await withServer(async ({ base, home, studio }) => {
    await studio.store.saveRun(failedRun());
    await studio.store.saveRun(
      verifiedRun({
        id: 'run_studiounv',
        verification: { passed: null, checks: [] },
      }),
    );
    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });
    const before = await countTacit(home);

    const latest = await (await fetch(`${base}/api/knowledge/reflect`)).json();
    assert.equal(latest.notable, false);
    assert.equal(latest.proposal, null);
    assert.doesNotMatch(JSON.stringify(latest), /success tacit note to write/i);

    const failed = await (await fetch(`${base}/api/knowledge/reflect?runId=run_studiobad`)).json();
    assert.equal(failed.notable, false);
    assert.equal(failed.proposal, null);
    assert.equal(failed.source?.verified, false);
    assert.match(failed.reason, /Verification failed/);

    const unverified = await (await fetch(`${base}/api/knowledge/reflect?runId=run_studiounv`)).json();
    assert.equal(unverified.notable, false);
    assert.equal(unverified.proposal, null);
    assert.match(unverified.reason, /Nothing was verified/);

    const denied = await fetch(`${base}/api/knowledge/reflect/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run_studiobad' }),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await countTacit(home), before);
  });
});

test('accept writes the verified-run tacit once; dismiss does not write', async () => {
  await withServer(async ({ base, home, studio }) => {
    await studio.store.saveRun(failedRun());
    await studio.store.saveRun(verifiedRun());
    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });
    const before = await countTacit(home);

    const preview = await (await fetch(`${base}/api/knowledge/reflect`)).json();
    assert.equal(preview.written, false);
    assert.equal(preview.notable, true);
    assert.equal(preview.proposal.runId, 'run_studiook1');
    assert.match(preview.proposal.goal, /Flutter jank/);
    assert.match(preview.proposal.outcome, /Opposite review passed|checks passed/i);
    assert.equal(preview.proposal.domain, 'flutter-android');
    assert.deepEqual(await countTacit(home), before);

    const dismissed = await fetch(`${base}/api/knowledge/reflect/dismiss`, mutation(base, {}));
    assert.equal(dismissed.status, 200);
    assert.equal((await dismissed.json()).written, false);
    assert.deepEqual(await countTacit(home), before);

    const accepted = await fetch(
      `${base}/api/knowledge/reflect/accept`,
      mutation(base, { runId: 'run_studiook1' }),
    );
    assert.equal(accepted.status, 201);
    const wrote = await accepted.json();
    assert.equal(wrote.written, true);
    assert.equal(wrote.note?.id, preview.proposal.id);
    assert.equal(wrote.note?.domain, 'flutter-android');
    const afterAccept = await countTacit(home);
    assert.equal(afterAccept.tacit, before.tacit + 1);
    assert.equal(afterAccept.inbox, before.inbox);

    const again = await fetch(`${base}/api/knowledge/reflect/accept`, mutation(base, { runId: 'run_studiook1' }));
    assert.equal(again.status, 409);
    assert.deepEqual(await countTacit(home), afterAccept);

    const after = await (await fetch(`${base}/api/knowledge/reflect`)).json();
    assert.equal(after.notable, false);
    assert.equal(after.proposal, null);
    assert.match(after.reason, /Already accepted/);
  });
});
