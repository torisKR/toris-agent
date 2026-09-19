import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KnowledgeStore,
  USER_MD_LIMIT,
  STARTER_DOMAIN_SLUGS,
  compressBounded,
} from '../src/core/knowledge/index.js';

async function withStore(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-knowledge-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: join(home, 'proj') });
    await store.init({ seed: true });
    await fn(store, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('init seeds USER.md, MEMORY.md, and five starter domains', async () => {
  await withStore(async (store) => {
    const status = await store.status();
    assert.equal(status.ok, true);
    assert.equal(status.domains, STARTER_DOMAIN_SLUGS.length);
    assert.deepEqual(status.domainSlugs.sort(), [...STARTER_DOMAIN_SLUGS].sort());
    const user = await store.readUser();
    assert.match(user.text, /USER.md/);
    const memory = await store.readMemory();
    assert.match(memory.text, /MEMORY.md/);
  });
});

test('init is idempotent and does not clobber user edits', async () => {
  await withStore(async (store) => {
    await store.appendUser('- Name: Ada');
    await store.init({ seed: true });
    const user = await store.readUser();
    assert.match(user.text, /Name: Ada/);
  });
});

test('starter domains have real nodes, tacit notes, and a DAG', async () => {
  await withStore(async (store) => {
    for (const slug of STARTER_DOMAIN_SLUGS) {
      const domain = await store.inspectDomain(slug);
      assert.ok(domain.body.length > 80, slug);
      assert.ok(domain.nodeCount >= 3, slug);
      assert.ok(domain.edgeCount >= 2, slug);
      assert.ok(domain.tacitCount >= 1, slug);
      assert.equal(domain.cycles.length, 0, slug);
    }
  });
});

test('removeNode deletes the markdown file and drops edges that touch it', async () => {
  await withStore(async (store, home) => {
    const node = await store.addNode('toris-ops', {
      title: 'Temporary receipt rule',
      body: 'Delete me after the test.',
    });
    await store.link('toris-ops', {
      from: 'receipts-not-vibes',
      to: node.id,
      kind: 'supports',
    });
    const other = await store.inspectDomain('flutter-android');
    const removed = await store.removeNode('toris-ops', node.id);
    assert.equal(removed.removed, true);
    assert.equal(removed.id, node.id);
    assert.ok(removed.droppedEdges.some((edge) => edge.to === node.id));
    await assert.rejects(() => store.getNode('toris-ops', node.id), /Unknown node/);
    const dag = JSON.parse(await readFile(join(home, 'knowledge/domains/toris-ops/dag.json'), 'utf8'));
    assert.equal(dag.edges.some((edge) => edge.from === node.id || edge.to === node.id), false);
    const flutter = await store.inspectDomain('flutter-android');
    assert.equal(flutter.nodeCount, other.nodeCount);
    assert.deepEqual(flutter.edges, other.edges);
  });
});

test('removeNode unknown domain or node writes nothing', async () => {
  await withStore(async (store, home) => {
    const before = await readFile(join(home, 'knowledge/domains/toris-ops/dag.json'), 'utf8');
    await assert.rejects(() => store.removeNode('no-such-domain', 'receipts-not-vibes'), {
      code: 'E_UNKNOWN_DOMAIN',
    });
    await assert.rejects(() => store.removeNode('toris-ops', 'no-such-node'), {
      code: 'E_UNKNOWN_NODE',
    });
    assert.equal(await readFile(join(home, 'knowledge/domains/toris-ops/dag.json'), 'utf8'), before);
    assert.ok(await store.getNode('toris-ops', 'receipts-not-vibes'));
  });
});

test('adding a node and a DAG edge persists as markdown and json', async () => {
  await withStore(async (store, home) => {
    const node = await store.addNode('toris-ops', {
      title: 'Reflect after a win',
      tags: 'tacit, chat',
      body: 'Run /reflect instead of dumping the transcript.',
    });
    assert.equal(node.id, 'reflect-after-a-win');
    const linked = await store.link('toris-ops', {
      from: 'receipts-not-vibes',
      to: node.id,
      kind: 'supports',
    });
    assert.equal(linked.added.kind, 'supports');
    const dag = JSON.parse(await readFile(join(home, 'knowledge/domains/toris-ops/dag.json'), 'utf8'));
    assert.ok(dag.edges.some((edge) => edge.to === node.id));
  });
});

test('USER.md over the bound is compressed rather than rejected', async () => {
  await withStore(async (store) => {
    const bulky = `${'x'.repeat(USER_MD_LIMIT + 2000)}`;
    const written = await store.writeUser(`# USER.md\n\n${bulky}`);
    assert.equal(written.compressed, true);
    assert.ok(written.bytes <= USER_MD_LIMIT);
    assert.match(written.text, /compressed USER.md/);
  });
});

test('compressBounded keeps a head and a tail', () => {
  const result = compressBounded(`HEAD-${'m'.repeat(5000)}-TAIL`, 800, 'test');
  assert.equal(result.compressed, true);
  assert.match(result.text, /HEAD-/);
  assert.match(result.text, /-TAIL/);
});

test('tacit inbox promote moves the file into a domain', async () => {
  await withStore(async (store) => {
    const note = await store.addTacit(null, {
      title: 'We always cite the receipt path',
      body: 'How we actually close a run.',
      inbox: true,
    });
    const inbox = await store.listInbox();
    assert.equal(inbox.length, 1);
    await store.promoteTacit(note.id, { domain: 'toris-ops' });
    assert.equal((await store.listInbox()).length, 0);
    const tacit = await store.listTacit('toris-ops');
    assert.ok(tacit.some((item) => item.id === note.id));
  });
});

test('project overlay domains are listed separately from home', async () => {
  await withStore(async (store) => {
    await store.addDomain({
      slug: 'acme-app',
      title: 'Acme',
      body: 'Project-only domain.',
      source: 'project',
    });
    const domains = await store.listDomains();
    const project = domains.find((domain) => domain.slug === 'acme-app');
    assert.equal(project.source, 'project');
    assert.ok(domains.some((domain) => domain.slug === 'solo-revenue' && domain.source === 'home'));
  });
});
