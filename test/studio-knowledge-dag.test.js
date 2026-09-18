import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { excerptBody, presentKnowledgeDag } from '../src/studio/knowledge-dag.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-dag-'));
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

function mutation(base, body) {
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

test('presentKnowledgeDag is empty when a domain has no nodes', () => {
  const graph = presentKnowledgeDag({
    slug: 'empty-pack',
    title: 'Empty',
    source: 'home',
    nodes: [],
    edges: [{ from: 'ghost', to: 'also-ghost', kind: 'supports' }],
  });
  assert.equal(graph.ok, true);
  assert.equal(graph.slug, 'empty-pack');
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.equal(graph.nodeCount, 0);
  assert.equal(graph.edgeCount, 0);
});

test('presentKnowledgeDag keeps title, kind, short body, and edges', () => {
  const longBody = `A run is not done because an agent said so. ${'x'.repeat(200)}`;
  const graph = presentKnowledgeDag({
    slug: 'toris-ops',
    title: 'Toris ops',
    source: 'home',
    nodes: [
      { id: 'receipts-not-vibes', title: 'Receipts, not vibes', kind: 'node', body: longBody },
      { id: 'autonomy-ladder', title: 'Autonomy ladder', kind: 'node', body: 'Default is L3.' },
    ],
    edges: [{ from: 'autonomy-ladder', to: 'receipts-not-vibes', kind: 'supports' }],
  });
  assert.equal(graph.nodeCount, 2);
  assert.equal(graph.edgeCount, 1);
  assert.deepEqual(graph.nodes[0], {
    id: 'receipts-not-vibes',
    title: 'Receipts, not vibes',
    kind: 'node',
    excerpt: excerptBody(longBody),
  });
  assert.ok(graph.nodes[0].excerpt.endsWith('…'));
  assert.ok(graph.nodes[0].excerpt.length <= 180);
  assert.deepEqual(graph.edges, [{ from: 'autonomy-ladder', to: 'receipts-not-vibes', kind: 'supports' }]);
});

test('GET /knowledge ships a plain DAG panel and no graph library', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/knowledge`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="knowledge-dag"/);
    assert.match(html, /id="dag-nodes"/);
    assert.match(html, /id="dag-excerpt"/);
    assert.match(html, /id="reflect-panel"/);
    assert.doesNotMatch(html, /vis\.js|d3|cytoscape|mermaid/i);

    const script = await (await fetch(`${base}/assets/knowledge.js`)).text();
    const css = await (await fetch(`${base}/assets/knowledge.css`)).text();
    assert.match(script, /\/api\/knowledge\/domains\/\$\{encodeURIComponent\(slug\)\}\/dag/);
    assert.match(script, /knowledge-dag-edges/);
    assert.doesNotMatch(`${script}\n${css}`, /vis\.js|d3\.|cytoscape|mermaid/i);
  });
});

test('GET /api/knowledge/domains/:slug/dag is an empty graph for a domain with no nodes', async () => {
  await withServer(async ({ base, home }) => {
    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: false });
    await knowledge.addDomain({ slug: 'blank-domain', title: 'Blank', body: 'No nodes yet.' });

    const response = await fetch(`${base}/api/knowledge/domains/blank-domain/dag`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.slug, 'blank-domain');
    assert.deepEqual(body.nodes, []);
    assert.deepEqual(body.edges, []);
    assert.equal(body.nodeCount, 0);
    assert.equal(body.edgeCount, 0);
  });
});

test('GET /api/knowledge/domains/:slug/dag returns nodes and edges from the existing store', async () => {
  await withServer(async ({ base, home }) => {
    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });
    const inspected = await knowledge.inspectDomain('toris-ops');

    const response = await fetch(`${base}/api/knowledge/domains/toris-ops/dag`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.slug, 'toris-ops');
    assert.equal(body.source, 'home');
    assert.ok(body.nodes.length >= 3);
    assert.ok(body.edges.length >= 2);
    assert.equal(body.nodeCount, body.nodes.length);
    assert.equal(body.edgeCount, body.edges.length);
    assert.ok(body.nodes.every((node) => node.id && node.title && node.kind === 'node' && typeof node.excerpt === 'string'));
    assert.ok(body.edges.every((edge) => edge.from && edge.to && edge.kind));
    assert.ok(body.nodes.some((node) => node.id === 'receipts-not-vibes'));
    assert.ok(body.edges.some((edge) => edge.from === 'autonomy-ladder' && edge.to === 'receipts-not-vibes'));
    assert.equal(body.nodes.length, inspected.nodes.length);
    assert.equal(body.edges.length, inspected.edges.length);
    assert.equal(Object.hasOwn(body.nodes[0], 'body'), false);
    assert.equal(Object.hasOwn(body, 'tacit'), false);
  });
});

test('GET /api/knowledge/domains/:slug/dag does not write the knowledge store', async () => {
  await withServer(async ({ base, home }) => {
    const missing = await fetch(`${base}/api/knowledge/domains/toris-ops/dag`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await snapshotKnowledge(home), []);

    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });
    const before = await snapshotKnowledge(home);

    const seeded = await fetch(`${base}/api/knowledge/domains/toris-ops/dag`);
    assert.equal(seeded.status, 200);
    assert.equal((await seeded.json()).ok, true);
    assert.deepEqual(await snapshotKnowledge(home), before);

    const posted = await fetch(`${base}/api/knowledge/domains/toris-ops/dag`, mutation(base, {}));
    assert.equal(posted.status, 404);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('GET /api/knowledge/domains/:slug/dag uses the same 404 as domain inspect', async () => {
  await withServer(async ({ base, home }) => {
    const unknownDag = await fetch(`${base}/api/knowledge/domains/no-such-domain/dag`);
    const unknownInspect = await fetch(`${base}/api/knowledge/domains/no-such-domain`);
    assert.equal(unknownDag.status, 404);
    assert.equal(unknownInspect.status, 404);
    assert.match((await unknownDag.json()).error.message, /Unknown domain/);

    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });
    const stillMissing = await fetch(`${base}/api/knowledge/domains/no-such-domain/dag`);
    const stillInspect = await fetch(`${base}/api/knowledge/domains/no-such-domain`);
    assert.equal(stillMissing.status, 404);
    assert.equal(stillInspect.status, 404);
  });
});
