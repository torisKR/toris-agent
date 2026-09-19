import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { HttpError } from '../src/studio/http.js';
import { installStudioKnowledgePack } from '../src/studio/knowledge-write.js';
import { KNOWLEDGE_PACKS_DIR, KNOWLEDGE_PACK_SLUGS } from '../src/core/knowledge/index.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-know-pack-'));
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

async function snapshotKnowledge(home) {
  const root = join(home, 'knowledge');
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const info = await stat(path);
      files.push({ rel: path.slice(root.length), size: info.size, text: await readFile(path, 'utf8') });
    }
  }
  await walk(root);
  return files;
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

test('GET /knowledge ships the install-starter-pack list', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/knowledge`)).text();
    assert.match(html, /id="pack-panel"/);
    assert.match(html, /id="pack-list"/);
    assert.match(html, /Install starter pack/);

    const script = await (await fetch(`${base}/assets/knowledge.js`)).text();
    assert.match(script, /\/api\/knowledge\/packs/);
    assert.match(script, /packs\/\$\{encodeURIComponent\(pack\.slug\)\}\/install/);
    assert.match(script, /availablePacks/);
    assert.doesNotMatch(script, /force:\s*true/);
  });
});

test('GET /api/knowledge/packs is read-only', async () => {
  await withServer(async ({ base, home }) => {
    assert.deepEqual(await snapshotKnowledge(home), []);
    const listed = await fetch(`${base}/api/knowledge/packs`);
    assert.equal(listed.status, 200);
    const body = await listed.json();
    assert.equal(body.ok, true);
    assert.equal(body.packs.length, KNOWLEDGE_PACK_SLUGS.length);
    assert.ok(body.root === KNOWLEDGE_PACKS_DIR || body.root.startsWith(KNOWLEDGE_PACKS_DIR));
    assert.equal(
      body.packs.every((pack) => pack.installed === false),
      true,
    );
    assert.deepEqual(await snapshotKnowledge(home), []);
  });
});

test('Studio install writes one pack and skips USER.md / MEMORY.md', async () => {
  await withServer(async ({ base, home }) => {
    const created = await fetch(
      `${base}/api/knowledge/packs/flutter-expo-android/install`,
      mutation(base),
    );
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.slug, 'flutter-expo-android');
    assert.ok(body.nodeCount >= 3);

    const dir = join(home, 'knowledge/domains/flutter-expo-android');
    assert.match(await readFile(join(dir, 'DOMAIN.md'), 'utf8'), /slug: flutter-expo-android/);
    const dag = JSON.parse(await readFile(join(dir, 'dag.json'), 'utf8'));
    assert.ok(dag.edges.length >= 2);
    assert.ok((await readdir(join(dir, 'nodes'))).includes('device-evidence.md'));

    const files = await snapshotKnowledge(home);
    assert.equal(
      files.some((file) => file.rel === '/USER.md' || file.rel === '/MEMORY.md'),
      false,
    );

    const listed = await (await fetch(`${base}/api/knowledge/packs`)).json();
    assert.equal(listed.packs.find((pack) => pack.slug === 'flutter-expo-android')?.installed, true);
  });
});

test('duplicate Studio install is 409 and does not overwrite', async () => {
  await withServer(async ({ base, home }) => {
    const first = await fetch(`${base}/api/knowledge/packs/toris-ops/install`, mutation(base));
    assert.equal(first.status, 201);
    const path = join(home, 'knowledge/domains/toris-ops/DOMAIN.md');
    const original = await readFile(path, 'utf8');
    const before = await snapshotKnowledge(home);

    const again = await fetch(`${base}/api/knowledge/packs/toris-ops/install`, mutation(base));
    assert.equal(again.status, 409);
    assert.match((await again.json()).error.message, /already exists/);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('unauthenticated Studio install is 403 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    const denied = await fetch(`${base}/api/knowledge/packs/product-growth/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotKnowledge(home), []);
  });
});

test('installStudioKnowledgePack rejects unknown and duplicate slugs before write', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-know-pack-unit-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: home });
    await assert.rejects(
      () => installStudioKnowledgePack(store, 'no-such-pack'),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await installStudioKnowledgePack(store, 'product-growth');
    const before = await snapshotKnowledge(home);
    await assert.rejects(
      () => installStudioKnowledgePack(store, 'product-growth'),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.deepEqual(await snapshotKnowledge(home), before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
