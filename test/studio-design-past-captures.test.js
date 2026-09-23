import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../src/studio/server.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-design-past-'));
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
  if (extra.onTray !== false) await studio.designs.addToTray(record.id, extra.note);
  return record;
}

test('GET /design ships Past captures rail wired to captures list + tray re-queue', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/design`)).text();
    assert.match(html, /id="design-past-section"/);
    assert.match(html, /id="design-past-captures"/);
    assert.match(html, /id="design-past-title"/);
    assert.match(html, />Past captures</);
    assert.match(html, /id="design-past-section"[^>]*hidden/);

    const script = await (await fetch(`${base}/assets/app.js`)).text();
    assert.match(script, /\/api\/design\/captures/);
    assert.match(script, /\/api\/design\/tray\/items/);
    assert.match(script, /method:\s*['"]POST['"]/);
    assert.match(script, /function renderPastCaptures\(/);
    assert.match(script, /function requeuePastCapture\(/);
    assert.match(script, /async function loadCaptures\(/);
    assert.match(script, /renderPastCaptures\(\)/);
    const requeueAt = script.indexOf('async function requeuePastCapture');
    const postPathAt = script.indexOf("'/api/design/tray/items'", requeueAt);
    assert.ok(requeueAt !== -1 && postPathAt !== -1 && postPathAt > requeueAt);
    const requeueBody = script.slice(requeueAt, requeueAt + 400);
    assert.match(requeueBody, /method:\s*['"]POST['"]/);
    assert.match(requeueBody, /\/api\/design\/tray\/items/);
    assert.doesNotMatch(script, /id="design-chip-2"|id="past-chip"|id="captures-chip"/);
  });
});

test('POST /api/design/tray/items re-queues a past capture after clear', async () => {
  await withServer(async ({ base, home, studio }) => {
    const first = await seed(studio, { note: '44px target.' });
    const second = await seed(studio, {
      selector: '.price',
      outerHTML: '<span class="price">$12</span>',
      note: 'Keep tabular numerals.',
    });
    assert.equal((await studio.designs.getTray()).items.length, 2);

    const cleared = await fetch(`${base}/api/design/tray/clear`, mutation(base, {}));
    assert.equal(cleared.status, 200);
    assert.equal((await studio.designs.getTray()).items.length, 0);

    const listed = await (await fetch(`${base}/api/design/captures`)).json();
    assert.equal(listed.items.length, 2);
    assert.ok(listed.items.some((item) => item.id === first.id));
    assert.ok(listed.items.some((item) => item.id === second.id));

    const requeued = await fetch(
      `${base}/api/design/tray/items`,
      mutation(base, { id: first.id, note: '44px target.' }),
    );
    assert.equal(requeued.status, 200);
    const tray = await requeued.json();
    assert.equal(tray.items.length, 1);
    assert.equal(tray.items[0].id, first.id);
    assert.equal(tray.items[0].note, '44px target.');

    const onDisk = JSON.parse(await readFile(join(home, 'studio', 'design', 'tray.json'), 'utf8'));
    assert.equal(onDisk.items.length, 1);
    assert.equal(onDisk.items[0].id, first.id);
    assert.ok(JSON.parse(await readFile(join(home, 'studio', 'design', `${first.id}.json`), 'utf8')).id);
    assert.ok(JSON.parse(await readFile(join(home, 'studio', 'design', `${second.id}.json`), 'utf8')).id);

    const again = await fetch(`${base}/api/design/tray/items`, mutation(base, { id: second.id }));
    assert.equal(again.status, 200);
    assert.equal((await again.json()).items.length, 2);
  });
});

test('unauthenticated tray/items re-queue is 403 and writes nothing', async () => {
  await withServer(async ({ base, home, studio }) => {
    const capture = await seed(studio);
    await studio.designs.clearTray();
    const before = await readFile(join(home, 'studio', 'design', 'tray.json'), 'utf8');
    const denied = await fetch(`${base}/api/design/tray/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: capture.id }),
    });
    assert.equal(denied.status, 403);
    assert.equal(await readFile(join(home, 'studio', 'design', 'tray.json'), 'utf8'), before);
    assert.equal((await studio.designs.getTray()).items.length, 0);
  });
});

test('unknown capture id on tray/items is 404', async () => {
  await withServer(async ({ base }) => {
    const missing = await fetch(
      `${base}/api/design/tray/items`,
      mutation(base, { id: 'des_missing' }),
    );
    assert.equal(missing.status, 404);
  });
});

test('Past captures control stays on the Studio design page source', async () => {
  const html = await readFile(join(repoRoot, 'src/studio/ui/index.html'), 'utf8');
  const js = await readFile(join(repoRoot, 'src/studio/ui/app.js'), 'utf8');
  const chip = await readFile(join(repoRoot, 'src/studio/ui/design-chip.js'), 'utf8');
  assert.match(html, /id="design-past-section"/);
  assert.match(html, /id="design-past-captures"/);
  assert.match(html, />Past captures</);
  assert.match(js, /\/api\/design\/captures/);
  assert.match(js, /\/api\/design\/tray\/items/);
  assert.match(js, /function requeuePastCapture\(/);
  assert.match(js, /function renderPastCaptures\(/);
  assert.doesNotMatch(html, /id="(?:design-chip-2|past-chip|captures-chip)"/);
  assert.doesNotMatch(chip, /\/api\/design\/tray\/items/);
  assert.doesNotMatch(chip, /Past captures/);
});
