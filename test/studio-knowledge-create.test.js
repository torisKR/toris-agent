import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { HttpError } from '../src/studio/http.js';
import { createStudioKnowledgeDomain } from '../src/studio/knowledge-write.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-know-create-'));
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

test('GET /knowledge ships the create-domain form', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/knowledge`)).text();
    assert.match(html, /id="create-domain-form"/);
    assert.match(html, /id="new-domain-slug"/);
    assert.match(html, /id="new-domain-title"/);
    assert.match(html, /id="new-domain-description"/);
    assert.match(html, />Create</);
    assert.match(html, /id="add-node-form"/);

    const script = await (await fetch(`${base}/assets/knowledge.js`)).text();
    assert.match(script, /\/api\/knowledge\/domains/);
    assert.match(script, /create-domain-form/);
    assert.match(script, /state\.selected = created\.slug/);
    assert.match(script, /await refresh\(\)/);
  });
});

test('GET does not write', async () => {
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

test('create writes one domain with the expected files', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const created = await fetch(
      `${base}/api/knowledge/domains`,
      mutation(base, { slug: 'studio-created', title: 'Studio created', body: 'One new domain from Studio.' }),
    );
    assert.equal(created.status, 201);
    const domain = await created.json();
    assert.equal(domain.slug, 'studio-created');
    assert.equal(domain.title, 'Studio created');
    assert.equal(domain.nodeCount, 0);
    assert.equal(domain.edgeCount, 0);

    const dir = join(home, 'knowledge/domains/studio-created');
    assert.equal(await readFile(join(dir, 'dag.json'), 'utf8'), '{\n  "edges": []\n}\n');
    const markdown = await readFile(join(dir, 'DOMAIN.md'), 'utf8');
    assert.match(markdown, /slug: studio-created/);
    assert.match(markdown, /title: Studio created/);
    assert.match(markdown, /One new domain from Studio/);
    assert.deepEqual(await readdir(join(dir, 'nodes')), []);
    assert.deepEqual(await readdir(join(dir, 'tacit')), []);

    const overview = await (await fetch(`${base}/api/knowledge`)).json();
    assert.ok(overview.domains.some((item) => item.slug === 'studio-created'));

    const dag = await (await fetch(`${base}/api/knowledge/domains/studio-created/dag`)).json();
    assert.equal(dag.ok, true);
    assert.deepEqual(dag.nodes, []);
    assert.deepEqual(dag.edges, []);

    const node = await fetch(
      `${base}/api/knowledge/domains/studio-created/nodes`,
      mutation(base, { title: 'First note', body: 'Add-node still works.' }),
    );
    assert.equal(node.status, 201);
    assert.equal((await node.json()).id, 'first-note');
  });
});

test('duplicate slug is 409 and does not overwrite', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const first = await fetch(
      `${base}/api/knowledge/domains`,
      mutation(base, { slug: 'keep-this', title: 'Keep this', body: 'original body' }),
    );
    assert.equal(first.status, 201);
    const path = join(home, 'knowledge/domains/keep-this/DOMAIN.md');
    const original = await readFile(path, 'utf8');
    const afterFirst = await snapshotKnowledge(home);

    const again = await fetch(
      `${base}/api/knowledge/domains`,
      mutation(base, { slug: 'keep-this', title: 'Overwrite attempt', body: 'should not land' }),
    );
    assert.equal(again.status, 409);
    assert.match((await again.json()).error.message, /already exists/);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.doesNotMatch(original, /should not land/);
    assert.deepEqual(await snapshotKnowledge(home), afterFirst);
  });
});

test('invalid slug is 400 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);

    for (const slug of ['', 'Not Valid', 'has/slash', 'my_app', '---']) {
      const denied = await fetch(`${base}/api/knowledge/domains`, mutation(base, { slug, title: 'Nope' }));
      assert.equal(denied.status, 400, slug);
      assert.match((await denied.json()).error.message, /Invalid domain/);
    }

    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('unauthenticated create is 403 and writes nothing', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const denied = await fetch(`${base}/api/knowledge/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'unauthed-domain', title: 'Must not write' }),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotKnowledge(home), before);
  });
});

test('create does not seed packs or write USER.md', async () => {
  await withServer(async ({ base, home }) => {
    assert.deepEqual(await snapshotKnowledge(home), []);
    const created = await fetch(`${base}/api/knowledge/domains`, mutation(base, { slug: 'solo-app' }));
    assert.equal(created.status, 201);
    const files = await snapshotKnowledge(home);
    assert.equal(
      files.some((file) => file.rel === '/USER.md' || file.rel === '/MEMORY.md'),
      false,
    );
    assert.equal(
      files.some((file) => file.rel.startsWith('/domains/toris-ops/')),
      false,
    );
    assert.ok(files.some((file) => file.rel === '/domains/solo-app/DOMAIN.md'));
    assert.ok(files.some((file) => file.rel === '/domains/solo-app/dag.json'));

    const overview = await (await fetch(`${base}/api/knowledge`)).json();
    assert.ok(overview.domains.some((item) => item.slug === 'solo-app'));
  });
});

test('create does not touch other domains files', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotKnowledge(home);
    const beforeOps = domainFiles(before, 'toris-ops');
    const beforeGrowth = domainFiles(before, 'product-growth');
    const beforeUser = before.find((file) => file.rel === '/USER.md');
    const beforeMemory = before.find((file) => file.rel === '/MEMORY.md');

    const created = await fetch(
      `${base}/api/knowledge/domains`,
      mutation(base, { slug: 'isolated-app', title: 'Isolated' }),
    );
    assert.equal(created.status, 201);

    const after = await snapshotKnowledge(home);
    assert.deepEqual(domainFiles(after, 'toris-ops'), beforeOps);
    assert.deepEqual(domainFiles(after, 'product-growth'), beforeGrowth);
    assert.deepEqual(
      after.find((file) => file.rel === '/USER.md'),
      beforeUser,
    );
    assert.deepEqual(
      after.find((file) => file.rel === '/MEMORY.md'),
      beforeMemory,
    );
    assert.ok(domainFiles(after, 'isolated-app').some((file) => file.rel.endsWith('DOMAIN.md')));
    assert.ok(domainFiles(after, 'isolated-app').some((file) => file.rel.endsWith('dag.json')));
    assert.equal(
      after.filter((file) => file.rel.startsWith('/domains/')).length,
      before.filter((file) => file.rel.startsWith('/domains/')).length + 2,
    );
  });
});

test('createStudioKnowledgeDomain rejects bad input before addDomain', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-know-create-unit-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: home });
    await store.init({ seed: true });
    const before = await snapshotKnowledge(home);

    await assert.rejects(
      () => createStudioKnowledgeDomain(store, { slug: 'Not Valid', title: 'X' }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
      () => createStudioKnowledgeDomain(store, { slug: 'toris-ops', title: 'Overwrite' }),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.deepEqual(await snapshotKnowledge(home), before);

    const domain = await createStudioKnowledgeDomain(store, {
      slug: 'helper-domain',
      title: 'Helper',
      description: 'Unit helper write.',
    });
    assert.equal(domain.slug, 'helper-domain');
    assert.equal(domain.title, 'Helper');
    assert.equal(domain.nodeCount, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
