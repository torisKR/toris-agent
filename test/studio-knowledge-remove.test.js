import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { HttpError } from '../src/studio/http.js';
import { removeStudioKnowledgeNode } from '../src/studio/knowledge-write.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-know-remove-'));
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

function snapshotDomain(files, slug) {
  const prefix = `/domains/${slug}/`;
  return files.filter((file) => file.rel.startsWith(prefix));
}

function mutation(base, body = {}, extra = {}) {
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

async function seed(home) {
  const knowledge = new KnowledgeStore({ home, projectPath: home });
  await knowledge.init({ seed: true });
  return knowledge;
}

async function nodeIds(home, slug) {
  const knowledge = new KnowledgeStore({ home, projectPath: home });
  return (await knowledge.listNodes(slug)).map((node) => node.id).sort();
}

async function edgePairs(home, slug) {
  const knowledge = new KnowledgeStore({ home, projectPath: home });
  const domain = await knowledge.inspectDomain(slug);
  return domain.edges.map((edge) => `${edge.from}:${edge.kind}:${edge.to}`).sort();
}

test('GET /knowledge ships a quiet DAG Remove control and no graph library', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/knowledge`)).text();
    assert.match(html, /id="knowledge-dag"/);
    assert.match(html, /id="dag-nodes"/);
    assert.doesNotMatch(html, /vis\.js|d3|cytoscape|mermaid/i);

    const script = await (await fetch(`${base}/assets/knowledge.js`)).text();
    assert.match(script, /textContent = 'Remove'/);
    assert.match(script, /window\.confirm/);
    assert.match(
      script,
      /\/api\/knowledge\/domains\/\$\{encodeURIComponent\(state\.selected\)\}\/nodes\/\$\{encodeURIComponent\(node\.id\)\}\/remove/,
    );
    assert.match(script, /selectDomain\(state\.selected\)/);
    assert.match(script, /\/api\/knowledge\/domains\/\$\{encodeURIComponent\(slug\)\}\/dag/);
    assert.doesNotMatch(script, /vis\.js|d3\.|cytoscape|mermaid/i);
  });
});

test('GET does not write', async () => {
  await withServer(async ({ base, home }) => {
    assert.deepEqual(await snapshotKnowledge(home), []);
    assert.equal((await fetch(`${base}/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops`)).status, 404);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/dag`)).status, 404);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/nodes/receipts-not-vibes/remove`)).status, 404);
    assert.deepEqual(await snapshotKnowledge(home), []);

    await seed(home);
    const before = await snapshotKnowledge(home);
    assert.equal((await fetch(`${base}/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops`)).status, 200);
    const dag = await fetch(`${base}/api/knowledge/domains/toris-ops/dag`);
    assert.equal(dag.status, 200);
    assert.equal((await dag.json()).ok, true);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/nodes/receipts-not-vibes/remove`)).status, 404);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('remove deletes the node and touching edges', async () => {
  await withServer(async ({ base, home }) => {
    const knowledge = await seed(home);
    const node = await knowledge.addNode('toris-ops', {
      title: 'Studio remove target',
      body: 'Remove should drop this node and its edges.',
    });
    await knowledge.link('toris-ops', {
      from: 'receipts-not-vibes',
      to: node.id,
      kind: 'supports',
    });
    const beforeNodes = await nodeIds(home, 'toris-ops');
    const beforeEdges = await edgePairs(home, 'toris-ops');
    assert.ok(beforeNodes.includes(node.id));
    assert.ok(beforeEdges.includes(`receipts-not-vibes:supports:${node.id}`));

    const removed = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes/${node.id}/remove`,
      mutation(base, {}),
    );
    assert.equal(removed.status, 200);
    const body = await removed.json();
    assert.equal(body.ok, true);
    assert.equal(body.removed, true);
    assert.equal(body.id, node.id);
    assert.ok(body.droppedEdges.some((edge) => edge.from === 'receipts-not-vibes' && edge.to === node.id));
    assert.equal((await nodeIds(home, 'toris-ops')).includes(node.id), false);
    assert.equal((await edgePairs(home, 'toris-ops')).some((edge) => edge.includes(node.id)), false);

    const dag = await (await fetch(`${base}/api/knowledge/domains/toris-ops/dag`)).json();
    assert.equal(dag.nodes.some((item) => item.id === node.id), false);
    assert.equal(dag.edges.some((edge) => edge.from === node.id || edge.to === node.id), false);
    assert.equal(dag.nodeCount, beforeNodes.length - 1);
  });
});

test('unauthenticated is 403 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const denied = await fetch(`${base}/api/knowledge/domains/toris-ops/nodes/receipts-not-vibes/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotKnowledge(home), before);
    assert.ok((await nodeIds(home, 'toris-ops')).includes('receipts-not-vibes'));
  });
});

test('unknown node is 404 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const missing = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes/no-such-node/remove`,
      mutation(base, {}),
    );
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error.message, /Unknown node/);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('unknown domain is 404 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const missing = await fetch(
      `${base}/api/knowledge/domains/no-such-domain/nodes/receipts-not-vibes/remove`,
      mutation(base, {}),
    );
    const inspect = await fetch(`${base}/api/knowledge/domains/no-such-domain`);
    assert.equal(missing.status, 404);
    assert.equal(inspect.status, 404);
    assert.match((await missing.json()).error.message, /Unknown domain/);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('remove does not touch other domains', async () => {
  await withServer(async ({ base, home }) => {
    const knowledge = await seed(home);
    const node = await knowledge.addNode('toris-ops', {
      title: 'Ops only removal',
      body: 'Must not rewrite flutter-android.',
    });
    await knowledge.link('toris-ops', { from: node.id, to: 'receipts-not-vibes', kind: 'supports' });
    const before = await snapshotKnowledge(home);
    const flutterBefore = snapshotDomain(before, 'flutter-android');
    const growthBefore = snapshotDomain(before, 'product-growth');

    const removed = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes/${node.id}/remove`,
      mutation(base, {}),
    );
    assert.equal(removed.status, 200);
    const after = await snapshotKnowledge(home);
    assert.deepEqual(snapshotDomain(after, 'flutter-android'), flutterBefore);
    assert.deepEqual(snapshotDomain(after, 'product-growth'), growthBefore);
    assert.equal((await nodeIds(home, 'toris-ops')).includes(node.id), false);
    assert.ok((await nodeIds(home, 'flutter-android')).length > 0);
  });
});

test('removeStudioKnowledgeNode rejects unknown domain or node before writing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-know-remove-unit-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: home });
    await store.init({ seed: true });
    const before = await snapshotKnowledge(home);

    await assert.rejects(
      () => removeStudioKnowledgeNode(store, 'no-such-domain', 'receipts-not-vibes'),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => removeStudioKnowledgeNode(store, 'toris-ops', 'no-such-node'),
      (error) => error instanceof HttpError && error.status === 404,
    );
    assert.deepEqual(await snapshotKnowledge(home), before);

    const removed = await removeStudioKnowledgeNode(store, 'toris-ops', 'receipts-not-vibes');
    assert.equal(removed.id, 'receipts-not-vibes');
    assert.equal(removed.removed, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
