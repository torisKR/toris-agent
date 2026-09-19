import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { HttpError } from '../src/studio/http.js';
import { unlinkStudioKnowledgeEdge } from '../src/studio/knowledge-write.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-know-unlink-'));
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

function domainFiles(snapshot, slug) {
  const prefix = `/domains/${slug}/`;
  return snapshot.filter((file) => file.rel.startsWith(prefix));
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

const EDGE = {
  from: 'android-verify-optional',
  to: 'receipts-not-vibes',
  kind: 'supports',
};

test('GET /knowledge ships a quiet DAG Unlink control and no graph library', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/knowledge`)).text();
    assert.match(html, /id="knowledge-dag"/);
    assert.match(html, /id="dag-nodes"/);
    assert.doesNotMatch(html, /vis\.js|d3|cytoscape|mermaid/i);

    const script = await (await fetch(`${base}/assets/knowledge.js`)).text();
    assert.match(script, /textContent = 'Unlink'/);
    assert.match(script, /window\.confirm/);
    assert.match(script, /\/api\/knowledge\/domains\/\$\{encodeURIComponent\(state\.selected\)\}\/edges\/unlink/);
    assert.match(script, /loadDag\(state\.selected\)/);
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
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/edges/unlink`)).status, 404);
    assert.deepEqual(await snapshotKnowledge(home), []);

    await seed(home);
    const before = await snapshotKnowledge(home);
    assert.equal((await fetch(`${base}/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops`)).status, 200);
    const dag = await fetch(`${base}/api/knowledge/domains/toris-ops/dag`);
    assert.equal(dag.status, 200);
    assert.equal((await dag.json()).ok, true);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/edges/unlink`)).status, 404);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('unlink removes one edge and keeps both nodes', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const beforeNodes = await nodeIds(home, 'toris-ops');
    const beforeEdges = await edgePairs(home, 'toris-ops');
    assert.ok(beforeEdges.includes(`${EDGE.from}:${EDGE.kind}:${EDGE.to}`));

    const unlinked = await fetch(
      `${base}/api/knowledge/domains/toris-ops/edges/unlink`,
      mutation(base, EDGE),
    );
    assert.equal(unlinked.status, 200);
    const body = await unlinked.json();
    assert.equal(body.written, true);
    assert.deepEqual(body.removed, EDGE);
    assert.deepEqual(await nodeIds(home, 'toris-ops'), beforeNodes);
    assert.deepEqual(
      await edgePairs(home, 'toris-ops'),
      beforeEdges.filter((edge) => edge !== `${EDGE.from}:${EDGE.kind}:${EDGE.to}`),
    );

    const dag = await (await fetch(`${base}/api/knowledge/domains/toris-ops/dag`)).json();
    assert.equal(
      dag.edges.some((edge) => edge.from === EDGE.from && edge.to === EDGE.to && edge.kind === EDGE.kind),
      false,
    );
    assert.equal(dag.edgeCount, beforeEdges.length - 1);
    assert.equal(dag.nodeCount, beforeNodes.length);
    assert.ok(dag.nodes.some((node) => node.id === EDGE.from));
    assert.ok(dag.nodes.some((node) => node.id === EDGE.to));
  });
});

test('unlink does not delete node files', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const beforeNodes = (await snapshotKnowledge(home)).filter((file) => file.rel.startsWith('/domains/toris-ops/nodes/'));

    const unlinked = await fetch(
      `${base}/api/knowledge/domains/toris-ops/edges/unlink`,
      mutation(base, EDGE),
    );
    assert.equal(unlinked.status, 200);
    assert.ok((await nodeIds(home, 'toris-ops')).includes(EDGE.from));
    assert.ok((await nodeIds(home, 'toris-ops')).includes(EDGE.to));
    assert.deepEqual(
      (await snapshotKnowledge(home)).filter((file) => file.rel.startsWith('/domains/toris-ops/nodes/')),
      beforeNodes,
    );
  });
});

test('unauthenticated is 403 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const denied = await fetch(`${base}/api/knowledge/domains/toris-ops/edges/unlink`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(EDGE),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotKnowledge(home), before);
    assert.ok((await nodeIds(home, 'toris-ops')).includes(EDGE.from));
    assert.ok((await nodeIds(home, 'toris-ops')).includes(EDGE.to));
  });
});

test('unknown edge is 404 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const missing = await fetch(
      `${base}/api/knowledge/domains/toris-ops/edges/unlink`,
      mutation(base, { from: 'receipts-not-vibes', to: 'autonomy-ladder', kind: 'supports' }),
    );
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error.message, /Unknown edge/);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('unknown domain is 404 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const missing = await fetch(
      `${base}/api/knowledge/domains/no-such-domain/edges/unlink`,
      mutation(base, EDGE),
    );
    const inspect = await fetch(`${base}/api/knowledge/domains/no-such-domain`);
    assert.equal(missing.status, 404);
    assert.equal(inspect.status, 404);
    assert.match((await missing.json()).error.message, /Unknown domain/);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('unlink does not touch other domains', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const beforeFlutter = domainFiles(before, 'flutter-android');
    const beforeGrowth = domainFiles(before, 'product-growth');
    const beforeUser = before.find((file) => file.rel === '/USER.md');
    const beforeMemory = before.find((file) => file.rel === '/MEMORY.md');

    const unlinked = await fetch(
      `${base}/api/knowledge/domains/toris-ops/edges/unlink`,
      mutation(base, EDGE),
    );
    assert.equal(unlinked.status, 200);

    const after = await snapshotKnowledge(home);
    assert.deepEqual(domainFiles(after, 'flutter-android'), beforeFlutter);
    assert.deepEqual(domainFiles(after, 'product-growth'), beforeGrowth);
    assert.deepEqual(
      after.find((file) => file.rel === '/USER.md'),
      beforeUser,
    );
    assert.deepEqual(
      after.find((file) => file.rel === '/MEMORY.md'),
      beforeMemory,
    );
    assert.deepEqual(
      after.filter((file) => file.rel.startsWith('/domains/toris-ops/nodes/')),
      before.filter((file) => file.rel.startsWith('/domains/toris-ops/nodes/')),
    );
    assert.notEqual(
      after.find((file) => file.rel === '/domains/toris-ops/dag.json')?.text,
      before.find((file) => file.rel === '/domains/toris-ops/dag.json')?.text,
    );
  });
});

test('unlinkStudioKnowledgeEdge rejects unknown domain or edge before writing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-know-unlink-unit-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: home });
    await store.init({ seed: true });
    const before = await snapshotKnowledge(home);

    await assert.rejects(
      () => unlinkStudioKnowledgeEdge(store, 'no-such-domain', EDGE),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => unlinkStudioKnowledgeEdge(store, 'toris-ops', {
        from: 'receipts-not-vibes',
        to: 'autonomy-ladder',
        kind: 'supports',
      }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => unlinkStudioKnowledgeEdge(store, 'toris-ops', { from: EDGE.from, to: EDGE.to, kind: 'inbox' }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    assert.deepEqual(await snapshotKnowledge(home), before);

    const unlinked = await unlinkStudioKnowledgeEdge(store, 'toris-ops', EDGE);
    assert.equal(unlinked.written, true);
    assert.deepEqual(unlinked.removed, EDGE);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
