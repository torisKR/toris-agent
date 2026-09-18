import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { EDGE_KINDS } from '../src/core/knowledge/dag.js';
import {
  acceptedKnowledgeKinds,
  addStudioKnowledgeNode,
  normalizeKnowledgeWriteKind,
} from '../src/studio/knowledge-write.js';
import { HttpError } from '../src/studio/http.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-know-write-'));
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

test('accepted kinds are the store node kind plus existing DAG edge kinds', () => {
  assert.deepEqual(acceptedKnowledgeKinds(), ['node', ...EDGE_KINDS]);
  assert.deepEqual(normalizeKnowledgeWriteKind(undefined), { nodeKind: 'node', edgeKind: 'supports' });
  assert.deepEqual(normalizeKnowledgeWriteKind('node'), { nodeKind: 'node', edgeKind: 'supports' });
  assert.deepEqual(normalizeKnowledgeWriteKind('supports'), { nodeKind: 'node', edgeKind: 'supports' });
  assert.throws(() => normalizeKnowledgeWriteKind('tacit'), (error) => error instanceof HttpError && error.status === 400);
  assert.throws(() => normalizeKnowledgeWriteKind('banana'), (error) => error instanceof HttpError && error.status === 400);
});

test('GET /knowledge ships the add-node form with store kinds and an optional target', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/knowledge`)).text();
    assert.match(html, /id="add-node-form"/);
    assert.match(html, /id="new-title"/);
    assert.match(html, /id="new-kind"/);
    assert.match(html, /id="new-body"/);
    assert.match(html, /id="new-target"/);
    assert.match(html, /id="knowledge-dag"/);
    for (const kind of acceptedKnowledgeKinds()) {
      assert.match(html, new RegExp(`<option value="${kind}">${kind}</option>`));
    }
    assert.doesNotMatch(html, /<option value="tacit">/);
    const script = await (await fetch(`${base}/assets/knowledge.js`)).text();
    assert.match(script, /\/api\/knowledge\/domains\/\$\{encodeURIComponent\(state\.selected\)\}\/nodes/);
    assert.match(script, /selectDomain\(state\.selected\)/);
  });
});

test('GET /knowledge and knowledge reads do not write', async () => {
  await withServer(async ({ base, home }) => {
    assert.deepEqual(await snapshotKnowledge(home), []);
    assert.equal((await fetch(`${base}/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops`)).status, 404);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/dag`)).status, 404);
    assert.deepEqual(await snapshotKnowledge(home), []);

    await seed(home);
    const before = await snapshotKnowledge(home);
    assert.equal((await fetch(`${base}/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops`)).status, 200);
    const dag = await fetch(`${base}/api/knowledge/domains/toris-ops/dag`);
    assert.equal(dag.status, 200);
    assert.equal((await dag.json()).ok, true);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('submit writes one node and reloads on the existing DAG GET', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const beforeNodes = await nodeIds(home, 'toris-ops');
    const beforeEdges = await edgePairs(home, 'toris-ops');

    const created = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes`,
      mutation(base, { title: 'Studio add form', kind: 'node', body: 'Submit writes this node.' }),
    );
    assert.equal(created.status, 201);
    const node = await created.json();
    assert.equal(node.id, 'studio-add-form');
    assert.equal(node.kind, 'node');
    assert.equal(node.written, true);
    assert.equal(node.edge, null);
    assert.deepEqual(await nodeIds(home, 'toris-ops'), [...beforeNodes, node.id].sort());
    assert.deepEqual(await edgePairs(home, 'toris-ops'), beforeEdges);

    const dag = await (await fetch(`${base}/api/knowledge/domains/toris-ops/dag`)).json();
    assert.ok(dag.nodes.some((item) => item.id === node.id && item.title === 'Studio add form'));
    assert.equal(dag.nodes.length, beforeNodes.length + 1);
    assert.equal(dag.edgeCount, beforeEdges.length);
  });
});

test('optional edge is written only when the target exists', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const beforeEdges = await edgePairs(home, 'toris-ops');

    const linked = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes`,
      mutation(base, {
        title: 'Linked from studio',
        kind: 'supports',
        body: 'Optional edge to an existing node.',
        target: 'receipts-not-vibes',
      }),
    );
    assert.equal(linked.status, 201);
    const node = await linked.json();
    assert.equal(node.id, 'linked-from-studio');
    assert.deepEqual(node.edge, { from: node.id, to: 'receipts-not-vibes', kind: 'supports' });
    assert.ok((await edgePairs(home, 'toris-ops')).includes(`${node.id}:supports:receipts-not-vibes`));

    const dag = await (await fetch(`${base}/api/knowledge/domains/toris-ops/dag`)).json();
    assert.ok(dag.nodes.some((item) => item.id === node.id));
    assert.ok(dag.edges.some((edge) => edge.from === node.id && edge.to === 'receipts-not-vibes' && edge.kind === 'supports'));
    assert.equal(dag.edgeCount, beforeEdges.length + 1);

    const lonely = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes`,
      mutation(base, { title: 'No link this time', kind: 'supports', body: 'Kind is accepted; no target.' }),
    );
    assert.equal(lonely.status, 201);
    assert.equal((await lonely.json()).edge, null);
    assert.equal((await edgePairs(home, 'toris-ops')).length, beforeEdges.length + 1);
  });
});

test('bad kind and unknown target are 400 and write nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);

    const badKind = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes`,
      mutation(base, { title: 'Should not land', kind: 'tacit', body: 'Not a store write kind.', target: 'receipts-not-vibes' }),
    );
    assert.equal(badKind.status, 400);
    assert.match((await badKind.json()).error.message, /Unknown kind/);
    assert.deepEqual(await snapshotKnowledge(home), before);
    assert.equal((await nodeIds(home, 'toris-ops')).includes('should-not-land'), false);

    const badTarget = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes`,
      mutation(base, { title: 'Should not land', kind: 'supports', body: 'Unknown target.', target: 'no-such-node' }),
    );
    assert.equal(badTarget.status, 400);
    assert.match((await badTarget.json()).error.message, /Unknown node/);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('unauthenticated submit is 403 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const denied = await fetch(`${base}/api/knowledge/domains/toris-ops/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Unauthed node', body: 'Must not write.' }),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('unknown domain stays 404 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const missing = await fetch(
      `${base}/api/knowledge/domains/no-such-domain/nodes`,
      mutation(base, { title: 'Ghost', body: 'Unknown domain.' }),
    );
    const inspect = await fetch(`${base}/api/knowledge/domains/no-such-domain`);
    assert.equal(missing.status, 404);
    assert.equal(inspect.status, 404);
    assert.match((await missing.json()).error.message, /Unknown domain/);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('duplicate submit is 409 and does not overwrite an existing node', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const first = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes`,
      mutation(base, { title: 'Keep this body', body: 'original body' }),
    );
    assert.equal(first.status, 201);
    const path = join(home, 'knowledge/domains/toris-ops/nodes/keep-this-body.md');
    const original = await readFile(path, 'utf8');
    const afterFirst = await snapshotKnowledge(home);

    const again = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes`,
      mutation(base, { title: 'Keep this body', body: 'overwrite attempt' }),
    );
    assert.equal(again.status, 409);
    assert.match((await again.json()).error.message, /already exists/);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.doesNotMatch(original, /overwrite attempt/);
    assert.deepEqual(await snapshotKnowledge(home), afterFirst);
  });
});

test('addStudioKnowledgeNode rejects bad input before addNode or link', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-know-write-unit-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: home });
    await store.init({ seed: true });
    const before = await snapshotKnowledge(home);

    await assert.rejects(
      () => addStudioKnowledgeNode(store, 'no-such-domain', { title: 'X', body: 'Y' }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => addStudioKnowledgeNode(store, 'toris-ops', { title: 'X', kind: 'inbox', body: 'Y' }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
      () => addStudioKnowledgeNode(store, 'toris-ops', { title: 'X', target: 'missing' }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    assert.deepEqual(await snapshotKnowledge(home), before);

    const node = await addStudioKnowledgeNode(store, 'toris-ops', {
      title: 'Helper write',
      kind: 'prerequisite',
      body: 'One node plus one edge.',
      target: 'autonomy-ladder',
    });
    assert.equal(node.id, 'helper-write');
    assert.deepEqual(node.edge, { from: 'helper-write', to: 'autonomy-ladder', kind: 'prerequisite' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
