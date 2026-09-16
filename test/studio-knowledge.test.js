import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-knowledge-'));
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

test('GET /knowledge is a standalone page that does not reuse app.js', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/knowledge`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="knowledge-title"/);
    assert.match(html, /\/assets\/knowledge\.js/);
    assert.doesNotMatch(html, /\/assets\/app\.js/);
    assert.equal((await fetch(`${base}/assets/knowledge.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/knowledge.css`)).status, 200);
  });
});

test('knowledge API can init, add a node, link a DAG edge, and search', async () => {
  await withServer(async ({ base }) => {
    const denied = await fetch(`${base}/api/knowledge/init`, { method: 'POST' });
    assert.equal(denied.status, 403);

    const seeded = await fetch(`${base}/api/knowledge/init`, {
      method: 'POST',
      headers: { origin: base, 'x-toris-studio-token': 'test-token' },
    });
    assert.equal(seeded.status, 200);
    const status = await seeded.json();
    assert.equal(status.domains, 5);

    const created = await fetch(
      `${base}/api/knowledge/domains/toris-ops/nodes`,
      mutation(base, { title: 'Studio knowledge page', body: 'Browse domains without the review room.' }),
    );
    assert.equal(created.status, 201);
    const node = await created.json();

    const linked = await fetch(
      `${base}/api/knowledge/domains/toris-ops/edges`,
      mutation(base, { from: 'design-mode-evidence', to: node.id, kind: 'supports' }),
    );
    assert.equal(linked.status, 201);

    const cycle = await fetch(
      `${base}/api/knowledge/domains/toris-ops/edges`,
      mutation(base, { from: node.id, to: 'design-mode-evidence', kind: 'supports' }),
    );
    assert.equal(cycle.status, 400);

    const search = await (await fetch(`${base}/api/knowledge/search?q=Studio%20knowledge`)).json();
    assert.ok(search.hits.some((hit) => hit.id === node.id));
  });
});
