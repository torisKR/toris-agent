import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { Store } from '../src/core/store.js';
import { savePatch } from '../src/core/patches.js';

const DIFF = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 hello
+from isolation
`;

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-patches-'));
  const studio = await createStudioServer({
    home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    applyPatchFn: extra.applyPatchFn || (async () => ({ ok: true, stderr: '' })),
    ...extra,
  });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    await fn({ studio, home, base });
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
}

function mutation(base, body, method = 'POST') {
  return {
    method,
    headers: {
      origin: base,
      'x-toris-studio-token': 'test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

async function seed(home, extra = {}) {
  const store = await new Store(home).init();
  return savePatch(store, {
    source: 'run',
    originPath: '/tmp/app',
    worktreePath: join(home, 'wt'),
    branch: 'toris/iso',
    baseSha: 'abc123',
    autonomy: 'L2',
    files: ['README.md'],
    stats: '1 file changed, 1 insertion(+)',
    patch: DIFF,
    ...extra,
  });
}

test('GET /patches serves the Studio shell', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/patches`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="patches-shell"/);
  });
});

test('GET /api/patches lists the same store the CLI uses and hides worktree paths', async () => {
  await withServer(async ({ base, home }) => {
    const record = await seed(home);
    const listed = await (await fetch(`${base}/api/patches`)).json();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, record.id);
    assert.equal(listed.items[0].status, 'pending');
    assert.equal(listed.items[0].diff, undefined);
    assert.equal(listed.items[0].worktreePath, undefined);
    const pending = await (await fetch(`${base}/api/patches?status=pending`)).json();
    assert.equal(pending.items.length, 1);
  });
});

test('GET /api/patches/:id returns a bounded unified diff', async () => {
  await withServer(async ({ base, home }) => {
    const record = await seed(home);
    const detail = await (await fetch(`${base}/api/patches/${record.id}`)).json();
    assert.match(detail.diff, /\+from isolation/);
    assert.equal(detail.truncated, false);
    assert.equal((await fetch(`${base}/api/patches/missing`)).status, 404);
  });
});

test('apply and discard require Origin plus session token and reuse core patch APIs', async () => {
  await withServer(async ({ base, home }) => {
    const record = await seed(home);
    const denied = await fetch(`${base}/api/patches/${record.id}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);

    const applied = await fetch(`${base}/api/patches/${record.id}/apply`, mutation(base, {}));
    assert.equal(applied.status, 200);
    assert.equal((await applied.json()).status, 'applied');

    const again = await fetch(`${base}/api/patches/${record.id}/apply`, mutation(base, {}));
    assert.equal(again.status, 409);
  });
});

test('discard drops a pending patch without applying it', async () => {
  await withServer(async ({ base, home }) => {
    const record = await seed(home);
    const discarded = await fetch(`${base}/api/patches/${record.id}/discard`, mutation(base, {}));
    assert.equal(discarded.status, 200);
    assert.equal((await discarded.json()).status, 'discarded');
    const listed = await (await fetch(`${base}/api/patches?status=pending`)).json();
    assert.equal(listed.items.length, 0);
  });
});

test('POST /api/patches/:id/review sends operator intent as an agent turn', async () => {
  let received;
  await withServer(
    async ({ base, home }) => {
      const record = await seed(home);
      const denied = await fetch(`${base}/api/patches/${record.id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'fix spacing' }),
      });
      assert.equal(denied.status, 403);

      const empty = await fetch(`${base}/api/patches/${record.id}/review`, mutation(base, {}));
      assert.equal(empty.status, 400);

      const response = await fetch(
        `${base}/api/patches/${record.id}/review`,
        mutation(base, { note: 'Keep the CTA at 44px.', hunk: '@@ -1 +1,2 @@', agent: 'implementer' }),
      );
      assert.equal(response.status, 200);
      assert.match(received.message, /Keep the CTA at 44px/);
      assert.match(received.message, /Patch review/);
      assert.equal(received.agent, 'implementer');
    },
    {
      runAgentTurn: async (input) => {
        received = input;
        return { ok: true, text: 'will edit', agent: { id: 'implementer', title: 'Implementer' } };
      },
    },
  );
});
