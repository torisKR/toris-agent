import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { EDGE_KINDS } from '../src/core/knowledge/dag.js';
import { HttpError } from '../src/studio/http.js';
import { linkStudioKnowledgeNodes } from '../src/studio/knowledge-write.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-know-link-'));
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

const LINK = {
  from: 'android-verify-optional',
  to: 'design-mode-evidence',
  kind: 'supports',
};

test('GET /knowledge ships the link form with store edge kinds', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/knowledge`)).text();
    assert.match(html, /id="add-edge-form"/);
    assert.match(html, /id="edge-from"/);
    assert.match(html, /id="edge-to"/);
    assert.match(html, /id="edge-kind"/);
    assert.match(html, />Link</);
    assert.doesNotMatch(html, /vis\.js|d3|cytoscape|mermaid/i);
    for (const kind of EDGE_KINDS) {
      assert.match(html, new RegExp(`<option value="${kind}">${kind}</option>`));
    }

    const script = await (await fetch(`${base}/assets/knowledge.js`)).text();
    assert.match(script, /\/api\/knowledge\/domains\/\$\{encodeURIComponent\(state\.selected\)\}\/edges/);
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
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/edges`)).status, 404);
    assert.deepEqual(await snapshotKnowledge(home), []);

    await seed(home);
    const before = await snapshotKnowledge(home);
    assert.equal((await fetch(`${base}/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops`)).status, 200);
    const dag = await fetch(`${base}/api/knowledge/domains/toris-ops/dag`);
    assert.equal(dag.status, 200);
    assert.equal((await dag.json()).ok, true);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/edges`)).status, 404);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('link writes one edge and reloads on the existing DAG GET', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const beforeNodes = await nodeIds(home, 'toris-ops');
    const beforeEdges = await edgePairs(home, 'toris-ops');

    const linked = await fetch(`${base}/api/knowledge/domains/toris-ops/edges`, mutation(base, LINK));
    assert.equal(linked.status, 201);
    const body = await linked.json();
    assert.equal(body.written, true);
    assert.deepEqual(body.added, LINK);
    assert.deepEqual(await nodeIds(home, 'toris-ops'), beforeNodes);
    assert.deepEqual(await edgePairs(home, 'toris-ops'), [...beforeEdges, `${LINK.from}:${LINK.kind}:${LINK.to}`].sort());

    const dag = await (await fetch(`${base}/api/knowledge/domains/toris-ops/dag`)).json();
    assert.ok(dag.edges.some((edge) => edge.from === LINK.from && edge.to === LINK.to && edge.kind === LINK.kind));
    assert.equal(dag.edgeCount, beforeEdges.length + 1);
    assert.equal(dag.nodeCount, beforeNodes.length);
  });
});

test('link does not create nodes', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const beforeNodes = await nodeIds(home, 'toris-ops');
    const beforeFiles = (await snapshotKnowledge(home)).filter((file) => file.rel.startsWith('/domains/toris-ops/nodes/'));

    const linked = await fetch(`${base}/api/knowledge/domains/toris-ops/edges`, mutation(base, LINK));
    assert.equal(linked.status, 201);
    assert.deepEqual(await nodeIds(home, 'toris-ops'), beforeNodes);
    assert.deepEqual(
      (await snapshotKnowledge(home)).filter((file) => file.rel.startsWith('/domains/toris-ops/nodes/')),
      beforeFiles,
    );
    assert.equal((await nodeIds(home, 'toris-ops')).includes('no-such-node'), false);
  });
});

test('bad ids write nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);

    const unknownFrom = await fetch(
      `${base}/api/knowledge/domains/toris-ops/edges`,
      mutation(base, { from: 'no-such-from', to: 'receipts-not-vibes', kind: 'supports' }),
    );
    assert.equal(unknownFrom.status, 404);
    assert.match((await unknownFrom.json()).error.message, /Unknown node/);

    const unknownTo = await fetch(
      `${base}/api/knowledge/domains/toris-ops/edges`,
      mutation(base, { from: 'receipts-not-vibes', to: 'no-such-to', kind: 'supports' }),
    );
    assert.equal(unknownTo.status, 404);
    assert.match((await unknownTo.json()).error.message, /Unknown node/);

    const unknownDomain = await fetch(`${base}/api/knowledge/domains/no-such-domain/edges`, mutation(base, LINK));
    const inspect = await fetch(`${base}/api/knowledge/domains/no-such-domain`);
    assert.equal(unknownDomain.status, 404);
    assert.equal(inspect.status, 404);
    assert.match((await unknownDomain.json()).error.message, /Unknown domain/);

    const badKind = await fetch(
      `${base}/api/knowledge/domains/toris-ops/edges`,
      mutation(base, { from: LINK.from, to: LINK.to, kind: 'banana' }),
    );
    assert.equal(badKind.status, 400);
    assert.match((await badKind.json()).error.message, /Unknown DAG edge kind/);

    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('duplicate edge is 409 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const first = await fetch(`${base}/api/knowledge/domains/toris-ops/edges`, mutation(base, LINK));
    assert.equal(first.status, 201);
    const afterFirst = await snapshotKnowledge(home);

    const again = await fetch(`${base}/api/knowledge/domains/toris-ops/edges`, mutation(base, LINK));
    assert.equal(again.status, 409);
    assert.match((await again.json()).error.message, /already exists/);
    assert.deepEqual(await snapshotKnowledge(home), afterFirst);
  });
});

test('unauthenticated link is 403 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const denied = await fetch(`${base}/api/knowledge/domains/toris-ops/edges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(LINK),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('link does not touch other domains', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const beforeFlutter = domainFiles(before, 'flutter-android');
    const beforeGrowth = domainFiles(before, 'product-growth');
    const beforeUser = before.find((file) => file.rel === '/USER.md');
    const beforeMemory = before.find((file) => file.rel === '/MEMORY.md');

    const linked = await fetch(`${base}/api/knowledge/domains/toris-ops/edges`, mutation(base, LINK));
    assert.equal(linked.status, 201);

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

test('linkStudioKnowledgeNodes rejects bad input before link', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-know-link-unit-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: home });
    await store.init({ seed: true });
    const before = await snapshotKnowledge(home);

    await assert.rejects(
      () => linkStudioKnowledgeNodes(store, 'no-such-domain', LINK),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => linkStudioKnowledgeNodes(store, 'toris-ops', { from: 'missing', to: 'receipts-not-vibes', kind: 'supports' }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => linkStudioKnowledgeNodes(store, 'toris-ops', { from: LINK.from, to: LINK.to, kind: 'inbox' }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    assert.deepEqual(await snapshotKnowledge(home), before);

    const linked = await linkStudioKnowledgeNodes(store, 'toris-ops', LINK);
    assert.equal(linked.written, true);
    assert.deepEqual(linked.added, LINK);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
