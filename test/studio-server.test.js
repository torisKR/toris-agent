import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-server-'));
  const studio = await createStudioServer({
    home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    jobRunners: { noop: async ({ contentId }) => ({ contentId, done: true }) },
  });
  await studio.listen();
  const address = studio.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try { await fn({ studio, home, base }); } finally { await studio.close(); await rm(home, { recursive: true, force: true }); }
}

function mutation(base, body, headers = {}) {
  return {
    method: 'POST',
    headers: {
      origin: base,
      'x-toris-studio-token': 'test-token',
      ...headers,
    },
    body,
  };
}

test('health and session are local-only and emit no CORS headers', async () => {
  await withServer(async ({ base }) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.has('access-control-allow-origin'), false);
    assert.deepEqual(await health.json(), { ok: true, name: 'Toris Studio', localOnly: true, status: 'ready' });

    const session = await fetch(`${base}/api/session`);
    assert.deepEqual(await session.json(), { token: 'test-token', origin: base });
  });
});

test('content creation requires the current origin and token and persists awaiting_review', async () => {
  await withServer(async ({ base, home }) => {
    const denied = await fetch(`${base}/api/contents`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403);

    const createdResponse = await fetch(`${base}/api/contents`, mutation(base, JSON.stringify({
      kind: 'post',
      title: 'diff부터 본다',
      brief: { headline: '검토 가능한 변경', channels: ['threads', 'x'] },
    }), { 'content-type': 'application/json' }));
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.status, 'awaiting_review');

    const list = await (await fetch(`${base}/api/contents`)).json();
    assert.equal(list.items.length, 1);
    assert.equal(JSON.parse(await readFile(join(home, 'studio-contents.json'), 'utf8')).length, 1);
  });
});

test('content patch cannot overwrite internal media, quality, status, or publication evidence', async () => {
  await withServer(async ({ base }) => {
    const created = await (await fetch(`${base}/api/contents`, mutation(base, JSON.stringify({ kind: 'post', title: 'safe', channels: ['threads'] }), { 'content-type': 'application/json' }))).json();
    const response = await fetch(`${base}/api/contents/${created.id}`, {
      method: 'PATCH',
      headers: { origin: base, 'x-toris-studio-token': 'test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'edited', status: 'submitted', media: { path: '/tmp/forged.mp4' }, quality: { passed: true }, publication: { liveVerified: true } }),
    });
    assert.equal(response.status, 200);
    const content = await response.json();
    assert.equal(content.title, 'edited');
    assert.equal(content.status, 'awaiting_review');
    assert.equal(content.media, null);
    assert.equal(content.quality, null);
    assert.equal(content.publication, null);
  });
});

test('unknown job types are rejected before persistence', async () => {
  await withServer(async ({ base, studio }) => {
    const response = await fetch(`${base}/api/jobs`, mutation(base, JSON.stringify({ type: 'publish' }), { 'content-type': 'application/json' }));
    assert.equal(response.status, 400);
    assert.equal((await studio.jobs.list()).length, 0);
  });
});

test('raw MP4 upload checks magic bytes and supports byte ranges', async () => {
  await withServer(async ({ base }) => {
    const created = await (await fetch(`${base}/api/contents`, mutation(base, JSON.stringify({ kind: 'video', title: 'short' }), { 'content-type': 'application/json' }))).json();

    const invalid = await fetch(`${base}/api/contents/${created.id}/upload`, mutation(base, Buffer.from('not-an-mp4'), { 'content-type': 'video/mp4', 'x-file-name': 'bad.mp4' }));
    assert.equal(invalid.status, 400);
    assert.equal((await (await fetch(`${base}/api/contents/${created.id}`)).json()).media, null);

    const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
    const uploaded = await fetch(`${base}/api/contents/${created.id}/upload`, mutation(base, mp4, { 'content-type': 'video/mp4', 'x-file-name': '../short.mp4' }));
    assert.equal(uploaded.status, 200);
    const record = await uploaded.json();
    assert.equal(record.media.name, 'short.mp4');
    assert.equal(record.media.size, mp4.length);

    const range = await fetch(`${base}/api/contents/${created.id}/media`, { headers: { range: 'bytes=0-7' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-7/${mp4.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), mp4.subarray(0, 8));
  });
});

test('jobs run one at a time and persist their terminal result', async () => {
  await withServer(async ({ base, home }) => {
    const response = await fetch(`${base}/api/jobs`, mutation(base, JSON.stringify({ type: 'noop', contentId: 'cnt_1' }), { 'content-type': 'application/json' }));
    assert.equal(response.status, 202);
    const job = await response.json();

    let current;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      current = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
      if (current.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(current.status, 'succeeded');
    assert.deepEqual(current.result, { contentId: 'cnt_1', done: true });
    assert.equal(JSON.parse(await readFile(join(home, 'studio-jobs.json'), 'utf8'))[0].status, 'succeeded');
  });
});
