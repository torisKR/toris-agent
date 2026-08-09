import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentStore } from '../src/studio/content-store.js';
import { CONTENT_STATUS, createContent, updateContent } from '../src/studio/content.js';

const withStore = async (fn) => {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-content-'));
  const store = await new ContentStore(home).init();
  try { await fn(store, home); } finally { await rm(home, { recursive: true, force: true }); }
};

test('createContent normalises a reviewable Korean post without inventing publication state', () => {
  const content = createContent({
    kind: 'post',
    title: '에이전트 변경은 diff부터 본다',
    brief: { headline: '로컬 에이전트 검토 습관', channels: ['threads', 'x'] },
  }, {
    id: 'cnt_1',
    now: () => new Date('2026-08-09T10:00:00.000Z'),
  });

  assert.equal(content.id, 'cnt_1');
  assert.equal(content.status, CONTENT_STATUS.AWAITING_REVIEW);
  assert.deepEqual(content.channels, ['threads', 'x']);
  assert.equal(content.createdAt, '2026-08-09T10:00:00.000Z');
  assert.equal(content.publication, null);
});

test('createContent rejects unsupported kinds and empty titles', () => {
  assert.throws(() => createContent({ kind: 'stream', title: 'x' }), /kind/);
  assert.throws(() => createContent({ kind: 'post', title: '  ' }), /title/);
  assert.throws(() => createContent({ kind: 'post', title: 'x', channels: 'threads' }), /channels/);
  const content = createContent({ kind: 'post', title: 'x', channels: ['threads'] }, { id: 'cnt_channels' });
  assert.throws(() => updateContent(content, { channels: 'x' }), /channels/);
});

test('twenty concurrent creates survive the atomic collection queue', async () => {
  await withStore(async (store, home) => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.create({
      kind: 'post',
      title: `draft ${index}`,
      brief: { headline: `headline ${index}`, channels: ['threads'] },
    })));

    const items = await store.list();
    assert.equal(items.length, 20);
    assert.equal(new Set(items.map((item) => item.id)).size, 20);
    assert.equal(JSON.parse(await readFile(join(home, 'studio-contents.json'), 'utf8')).length, 20);
  });
});

test('content updates refresh updatedAt without mutating the input record', async () => {
  await withStore(async (store) => {
    const created = await store.create({ kind: 'video', title: 'short', media: { name: 'short.mp4' } });
    const updated = await store.update(created.id, { status: CONTENT_STATUS.QUALITY_FAILED });
    assert.equal(created.status, CONTENT_STATUS.AWAITING_REVIEW);
    assert.equal(updated.status, CONTENT_STATUS.QUALITY_FAILED);
    assert.notEqual(updated.updatedAt, created.updatedAt);
  });
});
