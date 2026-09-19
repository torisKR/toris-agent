import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KnowledgeStore,
  KNOWLEDGE_PACKS_DIR,
  KNOWLEDGE_PACK_SLUGS,
  listKnowledgePacks,
  installKnowledgePack,
} from '../src/core/knowledge/index.js';

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-knowledge-pack-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: home });
    await fn(store, home);
  } finally {
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

test('shipped packs live under the repo and are not fetched', async () => {
  assert.ok(KNOWLEDGE_PACKS_DIR.endsWith(join('packs', 'knowledge')));
  assert.deepEqual([...KNOWLEDGE_PACK_SLUGS].sort(), [
    'flutter-expo-android',
    'product-growth',
    'solo-revenue',
    'toris-ops',
  ]);
  for (const slug of KNOWLEDGE_PACK_SLUGS) {
    const domain = await readFile(join(KNOWLEDGE_PACKS_DIR, slug, 'DOMAIN.md'), 'utf8');
    assert.match(domain, new RegExp(`slug: ${slug}`));
    assert.doesNotMatch(domain, /https?:\/\//);
    const nodes = await readdir(join(KNOWLEDGE_PACKS_DIR, slug, 'nodes'));
    assert.ok(nodes.length >= 2, slug);
  }
});

test('list is read-only and does not write USER.md or MEMORY.md', async () => {
  await withHome(async (store, home) => {
    assert.deepEqual(await snapshotKnowledge(home), []);
    const listed = await listKnowledgePacks(store);
    assert.equal(listed.packs.length, KNOWLEDGE_PACK_SLUGS.length);
    assert.equal(
      listed.packs.every((pack) => pack.installed === false),
      true,
    );
    assert.ok(listed.root.startsWith(KNOWLEDGE_PACKS_DIR) || listed.root === KNOWLEDGE_PACKS_DIR);
    assert.deepEqual(await snapshotKnowledge(home), []);
  });
});

test('install writes the expected domain files and skips USER.md / MEMORY.md', async () => {
  await withHome(async (store, home) => {
    const result = await installKnowledgePack(store, 'flutter-expo-android');
    assert.equal(result.ok, true);
    assert.equal(result.slug, 'flutter-expo-android');
    assert.ok(result.nodeCount >= 3);
    assert.ok(result.edgeCount >= 2);
    assert.ok(result.dir.startsWith(KNOWLEDGE_PACKS_DIR));

    const dir = join(home, 'knowledge/domains/flutter-expo-android');
    const markdown = await readFile(join(dir, 'DOMAIN.md'), 'utf8');
    assert.match(markdown, /slug: flutter-expo-android/);
    assert.match(markdown, /title: Flutter and Expo on Android/);
    const dag = JSON.parse(await readFile(join(dir, 'dag.json'), 'utf8'));
    assert.ok(dag.edges.some((edge) => edge.from === 'performance-budget' && edge.to === 'device-evidence'));
    assert.ok(await store.getNode('flutter-expo-android', 'device-evidence'));
    assert.ok(await store.getNode('flutter-expo-android', 'play-release'));

    const files = await snapshotKnowledge(home);
    assert.equal(
      files.some((file) => file.rel === '/USER.md' || file.rel === '/MEMORY.md'),
      false,
    );
    assert.equal(
      files.some((file) => file.rel.startsWith('/domains/product-growth/')),
      false,
    );
  });
});

test('duplicate install without force does not overwrite', async () => {
  await withHome(async (store, home) => {
    await installKnowledgePack(store, 'solo-revenue');
    const path = join(home, 'knowledge/domains/solo-revenue/nodes/one-person-loop.md');
    const original = await readFile(path, 'utf8');
    await writeFile(path, `${original}\n<!-- operator edit -->\n`, 'utf8');
    const edited = await readFile(path, 'utf8');
    const before = await snapshotKnowledge(home);

    await assert.rejects(() => installKnowledgePack(store, 'solo-revenue'), { code: 'E_DOMAIN_EXISTS' });
    assert.equal(await readFile(path, 'utf8'), edited);
    assert.deepEqual(await snapshotKnowledge(home), before);

    const forced = await installKnowledgePack(store, 'solo-revenue', { force: true });
    assert.equal(forced.forced, true);
    const restored = await readFile(path, 'utf8');
    assert.doesNotMatch(restored, /operator edit/);
    assert.match(restored, /id: one-person-loop/);
  });
});

test('unknown pack writes nothing', async () => {
  await withHome(async (store, home) => {
    await assert.rejects(() => installKnowledgePack(store, 'not-a-real-pack'), { code: 'E_UNKNOWN_PACK' });
    assert.deepEqual(await snapshotKnowledge(home), []);
  });
});
