import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { HttpError } from '../src/studio/http.js';
import { createStudioServer } from '../src/studio/server.js';
import {
  DesignStore,
  consumeDesignTrayAfterAccept,
} from '../src/studio/design-store.js';
import {
  DESIGN_CHIP_HREF,
  DESIGN_CHIP_PATH,
  designChipFromTray,
  loadDesignChip,
} from '../src/studio/ui/design-chip.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-design-consume-'));
  const studio = await createStudioServer({
    home,
    cwd: home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    ...extra,
  });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    await fn({ base, home, studio });
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
}

function mutation(base, body = {}, method = 'POST') {
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

async function seed(studio, extra = {}) {
  const record = await studio.designs.save({
    url: extra.url || 'http://127.0.0.1:3000/checkout',
    selector: extra.selector || '#buy',
    tagName: extra.tagName || 'button',
    outerHTML: extra.outerHTML || '<button id="buy">Buy</button>',
    text: extra.text || 'Buy',
    note: extra.note || '',
  });
  await studio.designs.addToTray(record.id, extra.note);
  return record;
}

async function snapshotDesignStore(home) {
  const dir = join(home, 'studio', 'design');
  const files = {};
  try {
    files['tray.json'] = await readFile(join(dir, 'tray.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') files['tray.json'] = null;
    else throw error;
  }
  const captures = {};
  try {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      if (name === 'tray.json') continue;
      captures[name] = await readFile(join(dir, name));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  files.captures = captures;
  return files;
}

test('consumeDesignTrayAfterAccept clears only when a tray was attached', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-design-consume-unit-'));
  try {
    const store = await new DesignStore(home).init();
    const capture = await store.save({
      url: 'http://127.0.0.1:3000/',
      selector: '#buy',
      outerHTML: '<button id="buy">Buy</button>',
    });
    await store.addToTray(capture.id);

    const skipped = await consumeDesignTrayAfterAccept(store, false);
    assert.equal(skipped, null);
    assert.equal((await store.getTray()).items.length, 1);

    const emptied = await consumeDesignTrayAfterAccept(store, true);
    assert.deepEqual(emptied.items, []);
    assert.equal((await store.getTray()).items.length, 0);
    assert.ok(JSON.parse(await readFile(join(home, 'studio', 'design', `${capture.id}.json`), 'utf8')).id);

    const emptyAgain = await consumeDesignTrayAfterAccept(store, true);
    assert.deepEqual(emptyAgain.items, []);
    const trayPath = join(home, 'studio', 'design', 'tray.json');
    const before = await readFile(trayPath, 'utf8');
    const stillEmpty = await consumeDesignTrayAfterAccept(store, false);
    assert.equal(stillEmpty, null);
    assert.equal(await readFile(trayPath, 'utf8'), before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('GET /design ships tray send that refreshes after accept, not a second Clear', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/design`)).text();
    assert.match(html, /id="design-clear-tray"/);
    assert.match(html, />Clear tray</);
    assert.doesNotMatch(html, /id="design-chip-2"|id="tray-chip"/);

    const script = await (await fetch(`${base}/assets/app.js`)).text();
    assert.match(script, /tray: true/);
    assert.match(script, /streamAgentTurn\(/);
    assert.match(script, /window\.confirm\('Clear the annotation tray\?'\)/);
    assert.match(script, /\/api\/design\/tray\/clear/);
    const formAt = script.indexOf("elements['design-agent-form'].addEventListener");
    const streamAt = script.indexOf('streamAgentTurn({', formAt);
    const loadAt = script.indexOf('await loadTray()', formAt);
    const clearAfterForm = script.indexOf("'/api/design/tray/clear'", formAt);
    assert.ok(formAt !== -1 && streamAt !== -1 && loadAt !== -1);
    assert.ok(streamAt < loadAt);
    assert.equal(clearAfterForm, -1);
    assert.equal(script.split('/api/design/tray/clear').length - 1, 1);
  });
});

test('successful turn-with-tray clears and leaves capture files', async () => {
  let received;
  await withServer(
    async ({ base, home, studio }) => {
      const first = await seed(studio);
      const second = await seed(studio, {
        selector: '.price',
        outerHTML: '<span class="price">$12</span>',
        note: 'Keep tabular numerals.',
      });
      const beforeCaptures = (await snapshotDesignStore(home)).captures;
      assert.equal((await studio.designs.getTray()).items.length, 2);

      const sent = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, { agent: 'implementer', message: 'Align these two.', tray: true }),
      );
      assert.equal(sent.status, 200);
      assert.equal(received.tray, true);
      assert.equal((await sent.json()).ok, true);

      const tray = await studio.designs.getTray();
      assert.equal(tray.items.length, 0);
      const listed = await (await fetch(`${base}/api/design/tray`)).json();
      assert.equal(listed.items.length, 0);
      const onDisk = JSON.parse(await readFile(join(home, 'studio', 'design', 'tray.json'), 'utf8'));
      assert.deepEqual(onDisk.items, []);
      const afterCaptures = (await snapshotDesignStore(home)).captures;
      assert.deepEqual(afterCaptures, beforeCaptures);
      assert.ok(JSON.parse(await readFile(join(home, 'studio', 'design', `${first.id}.json`), 'utf8')).id);
      assert.ok(JSON.parse(await readFile(join(home, 'studio', 'design', `${second.id}.json`), 'utf8')).id);

      const chipBody = await (await fetch(`${base}${DESIGN_CHIP_PATH}`)).json();
      const chip = designChipFromTray(chipBody);
      assert.equal(chip.itemCount, 0);
      assert.equal(chip.quiet, true);
      assert.equal(chip.hidden, true);
      assert.equal(chip.href, DESIGN_CHIP_HREF);
      const loaded = await loadDesignChip(async (url, init) => {
        assert.equal(url, DESIGN_CHIP_PATH);
        assert.ok(!init || !init.method || init.method === 'GET');
        return fetch(`${base}${DESIGN_CHIP_PATH}`);
      });
      assert.equal(loaded.itemCount, 0);
      assert.equal(loaded.quiet, true);
    },
    {
      runAgentTurn: async (input) => {
        received = input;
        return { ok: true, text: 'will edit both', agent: { id: 'implementer', title: 'Implementer' } };
      },
    },
  );
});

test('successful SSE turn-with-tray clears after accept', async () => {
  await withServer(
    async ({ base, home, studio }) => {
      await seed(studio);
      const response = await fetch(`${base}/api/agent/turn`, {
        ...mutation(base, { agent: 'implementer', message: 'Match the CTA.', tray: true }),
        headers: {
          origin: base,
          'x-toris-studio-token': 'test-token',
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
      const body = await response.text();
      assert.match(body, /event: done/);
      assert.equal((await studio.designs.getTray()).items.length, 0);
      const onDisk = JSON.parse(await readFile(join(home, 'studio', 'design', 'tray.json'), 'utf8'));
      assert.deepEqual(onDisk.items, []);
    },
    {
      runAgentTurn: async () => ({
        ok: true,
        text: 'will edit',
        agent: { id: 'implementer', title: 'Implementer' },
      }),
    },
  );
});

test('failed and unauthenticated turns do not clear the tray', async () => {
  await withServer(
    async ({ base, home, studio }) => {
      const first = await seed(studio);
      const before = await snapshotDesignStore(home);
      assert.ok(before['tray.json']);

      const denied = await fetch(`${base}/api/agent/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'implementer', message: 'Align these two.', tray: true }),
      });
      assert.equal(denied.status, 403);
      assert.deepEqual(await snapshotDesignStore(home), before);

      const badToken = await fetch(`${base}/api/agent/turn`, {
        method: 'POST',
        headers: {
          origin: base,
          'x-toris-studio-token': 'wrong-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ agent: 'implementer', message: 'Align these two.', tray: true }),
      });
      assert.equal(badToken.status, 403);
      assert.deepEqual(await snapshotDesignStore(home), before);

      const unknown = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, { agent: 'not-a-real-agent', message: 'Align these two.', tray: true }),
      );
      assert.equal(unknown.status, 400);
      assert.deepEqual(await snapshotDesignStore(home), before);

      const failed = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, { agent: 'implementer', message: 'Align these two.', tray: true }),
      );
      assert.equal(failed.status, 409);
      assert.deepEqual(await snapshotDesignStore(home), before);

      const sseFail = await fetch(`${base}/api/agent/turn`, {
        ...mutation(base, { agent: 'implementer', message: 'Align these two.', tray: true }),
        headers: {
          origin: base,
          'x-toris-studio-token': 'test-token',
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
      });
      assert.equal(sseFail.status, 200);
      const sseBody = await sseFail.text();
      assert.match(sseBody, /event: error/);
      assert.deepEqual(await snapshotDesignStore(home), before);

      const tray = await studio.designs.getTray();
      assert.equal(tray.items.length, 1);
      assert.equal(tray.items[0].id, first.id);
    },
    {
      runAgentTurn: async () => {
        throw new HttpError(409, 'agent runtime is not ready');
      },
    },
  );
});

test('turn without tray does not clear', async () => {
  let received;
  await withServer(
    async ({ base, home, studio }) => {
      const first = await seed(studio);
      const before = await snapshotDesignStore(home);

      const plain = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, { agent: 'implementer', message: 'Just a note.' }),
      );
      assert.equal(plain.status, 200);
      assert.equal(received.tray, undefined);
      assert.deepEqual(await snapshotDesignStore(home), before);

      const byId = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, { agent: 'implementer', message: 'Match this button.', designId: first.id }),
      );
      assert.equal(byId.status, 200);
      assert.equal(received.designId, first.id);
      assert.equal(received.tray, undefined);
      assert.deepEqual(await snapshotDesignStore(home), before);

      const tray = await studio.designs.getTray();
      assert.equal(tray.items.length, 1);
      assert.equal(tray.items[0].id, first.id);
    },
    {
      runAgentTurn: async (input) => {
        received = input;
        return { ok: true, text: 'ok', agent: { id: 'implementer', title: 'Implementer' } };
      },
    },
  );
});

test('GET never clears the tray', async () => {
  await withServer(async ({ base, home, studio }) => {
    const first = await seed(studio);
    const second = await seed(studio, { selector: '.price', outerHTML: '<span class="price">$12</span>' });
    const before = await snapshotDesignStore(home);
    assert.ok(before['tray.json']);

    assert.equal((await fetch(`${base}/design`)).status, 200);
    assert.equal((await fetch(`${base}/api/design/tray`)).status, 200);
    assert.equal((await fetch(`${base}/api/design/captures`)).status, 200);
    assert.equal((await fetch(`${base}/api/design/captures/${first.id}`)).status, 200);
    assert.equal((await fetch(`${base}${DESIGN_CHIP_PATH}`)).status, 200);
    assert.equal((await fetch(`${base}/api/agent/turn`)).status, 404);
    assert.equal((await fetch(`${base}/api/design/tray/clear`)).status, 404);

    const after = await snapshotDesignStore(home);
    assert.deepEqual(after, before);
    const tray = await studio.designs.getTray();
    assert.equal(tray.items.length, 2);
    assert.equal(tray.items[0].id, first.id);
    assert.equal(tray.items[1].id, second.id);
  });
});

test('manual Clear tray and chip stay as-is on the design page source', async () => {
  const html = await readFile(join(repoRoot, 'src/studio/ui/index.html'), 'utf8');
  const js = await readFile(join(repoRoot, 'src/studio/ui/app.js'), 'utf8');
  const chip = await readFile(join(repoRoot, 'src/studio/ui/design-chip.js'), 'utf8');
  assert.match(html, /id="design-clear-tray"/);
  assert.match(html, />Clear tray</);
  assert.match(js, /window\.confirm\('Clear the annotation tray\?'\)/);
  assert.match(js, /\/api\/design\/tray\/clear/);
  assert.match(js, /consumeKnowledgePinAfterAccept\(knowledge\)/);
  assert.match(js, /tray: true/);
  assert.doesNotMatch(html, /id="(?:design-chip-2|tray-chip)"/);
  assert.doesNotMatch(chip, /\/api\/design\/tray\/clear/);
  assert.doesNotMatch(chip, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
  assert.doesNotMatch(chip, /\/api\/agent\/turn/);
});
