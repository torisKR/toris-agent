import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { HttpError } from '../src/studio/http.js';
import { updateStudioKnowledgeNode } from '../src/studio/knowledge-write.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-know-edit-'));
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

test('GET /knowledge ships editable title + body and no graph library', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/knowledge`)).text();
    assert.match(html, /id="knowledge-dag"/);
    assert.match(html, /id="edit-node-form"/);
    assert.match(html, /id="edit-title"/);
    assert.match(html, /id="edit-body"/);
    assert.match(html, /id="edit-kind"/);
    assert.match(html, /id="edit-save"/);
    assert.match(html, />Save</);
    assert.doesNotMatch(html, /vis\.js|d3|cytoscape|mermaid/i);

    const script = await (await fetch(`${base}/assets/knowledge.js`)).text();
    assert.match(script, /id="edit-node-form"|edit-node-form/);
    assert.match(
      script,
      /\/api\/knowledge\/domains\/\$\{encodeURIComponent\(state\.selected\)\}\/nodes\/\$\{encodeURIComponent\(state\.nodeId\)\}\/update/,
    );
    assert.match(script, /\/api\/knowledge\/domains\/\$\{encodeURIComponent\(slug\)\}\/dag/);
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
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/nodes/receipts-not-vibes/update`)).status, 404);
    assert.deepEqual(await snapshotKnowledge(home), []);

    await seed(home);
    const before = await snapshotKnowledge(home);
    assert.equal((await fetch(`${base}/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge`)).status, 200);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops`)).status, 200);
    const dag = await fetch(`${base}/api/knowledge/domains/toris-ops/dag`);
    assert.equal(dag.status, 200);
    assert.equal((await dag.json()).ok, true);
    assert.equal((await fetch(`${base}/api/knowledge/domains/toris-ops/nodes/receipts-not-vibes/update`)).status, 404);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('save updates title/body', async () => {
  await withServer(async ({ base, home }) => {
    const knowledge = await seed(home);
    const node = await knowledge.addNode('toris-ops', {
      title: 'Studio edit target',
      body: 'Original studio body.',
    });
    await knowledge.link('toris-ops', {
      from: 'receipts-not-vibes',
      to: node.id,
      kind: 'supports',
    });
    const beforeIds = await nodeIds(home, 'toris-ops');
    const beforeEdges = await edgePairs(home, 'toris-ops');

    const saved = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes/${node.id}/update`,
      mutation(base, { title: 'Edited studio title', body: 'Edited studio body.' }),
    );
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.id, node.id);
    assert.equal(body.title, 'Edited studio title');
    assert.equal(body.body, 'Edited studio body.');
    assert.equal(body.written, true);
    assert.equal(body.kind, 'node');

    const stored = await new KnowledgeStore({ home, projectPath: home }).getNode('toris-ops', node.id);
    assert.equal(stored.title, 'Edited studio title');
    assert.equal(stored.body, 'Edited studio body.');
    assert.deepEqual(await nodeIds(home, 'toris-ops'), beforeIds);
    assert.deepEqual(await edgePairs(home, 'toris-ops'), beforeEdges);

    const dag = await (await fetch(`${base}/api/knowledge/domains/toris-ops/dag`)).json();
    const presented = dag.nodes.find((item) => item.id === node.id);
    assert.equal(presented.title, 'Edited studio title');
    assert.match(presented.excerpt, /Edited studio body/);
    assert.equal(dag.edges.some((edge) => edge.from === 'receipts-not-vibes' && edge.to === node.id), true);
  });
});

test('unauthenticated is 403 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const denied = await fetch(`${base}/api/knowledge/domains/toris-ops/nodes/receipts-not-vibes/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Should not write', body: 'Denied.' }),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotKnowledge(home), before);
    const stored = await new KnowledgeStore({ home, projectPath: home }).getNode('toris-ops', 'receipts-not-vibes');
    assert.notEqual(stored.title, 'Should not write');
  });
});

test('unknown node is 404 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const missing = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes/no-such-node/update`,
      mutation(base, { title: 'Missing', body: 'No write.' }),
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
      `${base}/api/knowledge/domains/no-such-domain/nodes/receipts-not-vibes/update`,
      mutation(base, { title: 'Missing', body: 'No write.' }),
    );
    const inspect = await fetch(`${base}/api/knowledge/domains/no-such-domain`);
    assert.equal(missing.status, 404);
    assert.equal(inspect.status, 404);
    assert.match((await missing.json()).error.message, /Unknown domain/);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('empty title is 400 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const empty = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes/receipts-not-vibes/update`,
      mutation(base, { title: '   ', body: 'Should not land.' }),
    );
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error.message, /Title is required/);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('edit does not create a duplicate node id', async () => {
  await withServer(async ({ base, home }) => {
    const knowledge = await seed(home);
    const node = await knowledge.addNode('toris-ops', {
      title: 'Keep this id',
      body: 'Before rename.',
    });
    const beforeIds = await nodeIds(home, 'toris-ops');
    const saved = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes/${node.id}/update`,
      mutation(base, { title: 'A completely different title', body: 'After rename.' }),
    );
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.id, node.id);
    assert.notEqual(body.id, 'a-completely-different-title');
    const afterIds = await nodeIds(home, 'toris-ops');
    assert.deepEqual(afterIds, beforeIds);
    assert.equal(afterIds.filter((id) => id === node.id).length, 1);
    await assert.rejects(
      () => new KnowledgeStore({ home, projectPath: home }).getNode('toris-ops', 'a-completely-different-title'),
      /Unknown node/,
    );
  });
});

test('updateStudioKnowledgeNode rejects empty title and unknown ids before writing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-know-edit-unit-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: home });
    await store.init({ seed: true });
    const before = await snapshotKnowledge(home);

    await assert.rejects(
      () => updateStudioKnowledgeNode(store, 'no-such-domain', 'receipts-not-vibes', { title: 'Nope' }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => updateStudioKnowledgeNode(store, 'toris-ops', 'no-such-node', { title: 'Nope' }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => updateStudioKnowledgeNode(store, 'toris-ops', 'receipts-not-vibes', { title: '' }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    assert.deepEqual(await snapshotKnowledge(home), before);

    const updated = await updateStudioKnowledgeNode(store, 'toris-ops', 'receipts-not-vibes', {
      title: 'Receipts still not vibes',
      body: 'Edited from the helper.',
    });
    assert.equal(updated.id, 'receipts-not-vibes');
    assert.equal(updated.title, 'Receipts still not vibes');
    assert.equal(updated.written, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
