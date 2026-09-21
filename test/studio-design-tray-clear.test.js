import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../src/studio/server.js';
import {
  DESIGN_CHIP_HREF,
  DESIGN_CHIP_PATH,
  designChipFromTray,
  loadDesignChip,
} from '../src/studio/ui/design-chip.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-design-clear-'));
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

test('GET /design ships Clear tray with a confirm step', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/design`)).text();
    assert.match(html, /id="design-clear-tray"/);
    assert.match(html, /id="design-clear-tray"[^>]*hidden/);
    assert.match(html, />Clear tray</);

    const script = await (await fetch(`${base}/assets/app.js`)).text();
    assert.match(script, /\/api\/design\/tray\/clear/);
    assert.match(script, /window\.confirm\('Clear the annotation tray\?'\)/);
    assert.match(script, /elements\['design-clear-tray'\]\.hidden = items\.length === 0/);
    assert.match(script, /await loadTray\(\)/);
    const confirmAt = script.indexOf("window.confirm('Clear the annotation tray?')");
    const clearAt = script.indexOf("'/api/design/tray/clear'");
    const loadAt = script.indexOf('await loadTray()');
    assert.ok(confirmAt !== -1 && clearAt !== -1 && confirmAt < clearAt);
    assert.ok(loadAt !== -1 && clearAt < loadAt);
    assert.doesNotMatch(script, /id="design-chip-2"|id="tray-chip"/);
  });
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
    assert.equal((await fetch(`${base}/api/design/tray/clear`)).status, 404);

    const after = await snapshotDesignStore(home);
    assert.deepEqual(after, before);
    const tray = await studio.designs.getTray();
    assert.equal(tray.items.length, 2);
    assert.equal(tray.items[0].id, first.id);
    assert.equal(tray.items[1].id, second.id);
  });
});

test('confirmed clear empties the tray and leaves capture files', async () => {
  await withServer(async ({ base, home, studio }) => {
    const first = await seed(studio);
    const second = await seed(studio, {
      selector: '.price',
      outerHTML: '<span class="price">$12</span>',
      note: 'Keep tabular numerals.',
    });
    const beforeCaptures = (await snapshotDesignStore(home)).captures;
    assert.ok(beforeCaptures[`${first.id}.json`]);
    assert.ok(beforeCaptures[`${second.id}.json`]);

    const cleared = await fetch(`${base}/api/design/tray/clear`, mutation(base, {}));
    assert.equal(cleared.status, 200);
    const body = await cleared.json();
    assert.equal(body.version, 1);
    assert.deepEqual(body.items, []);
    assert.equal(typeof body.updatedAt, 'string');

    const tray = await studio.designs.getTray();
    const presented = await studio.designs.presentTray(await studio.designs.getTray());
    assert.equal(tray.items.length, 0);
    assert.equal(presented.items.length, 0);

    const listed = await (await fetch(`${base}/api/design/tray`)).json();
    assert.equal(listed.items.length, 0);

    const onDisk = JSON.parse(await readFile(join(home, 'studio', 'design', 'tray.json'), 'utf8'));
    assert.deepEqual(onDisk.items, []);
    const afterCaptures = (await snapshotDesignStore(home)).captures;
    assert.deepEqual(afterCaptures, beforeCaptures);
    assert.ok(JSON.parse(await readFile(join(home, 'studio', 'design', `${first.id}.json`), 'utf8')).id);
    assert.ok(JSON.parse(await readFile(join(home, 'studio', 'design', `${second.id}.json`), 'utf8')).id);
  });
});

test('unauthenticated clear is 403 and writes nothing', async () => {
  await withServer(async ({ base, home, studio }) => {
    await seed(studio);
    const before = await snapshotDesignStore(home);
    const denied = await fetch(`${base}/api/design/tray/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotDesignStore(home), before);
    assert.equal((await studio.designs.getTray()).items.length, 1);
  });
});

test('chip data path sees 0 after clear', async () => {
  await withServer(async ({ base, studio }) => {
    await seed(studio);
    const before = await (await fetch(`${base}${DESIGN_CHIP_PATH}`)).json();
    assert.equal(before.items.length, 1);
    const beforeChip = designChipFromTray(before);
    assert.equal(beforeChip.itemCount, 1);
    assert.equal(beforeChip.quiet, false);
    assert.equal(beforeChip.href, DESIGN_CHIP_HREF);

    const cleared = await fetch(`${base}/api/design/tray/clear`, mutation(base, {}));
    assert.equal(cleared.status, 200);

    const tray = await (await fetch(`${base}${DESIGN_CHIP_PATH}`)).json();
    assert.equal(tray.items.length, 0);
    const chip = designChipFromTray(tray);
    assert.equal(chip.itemCount, 0);
    assert.equal(chip.quiet, true);
    assert.equal(chip.hidden, true);
    assert.equal(chip.label, '');
    assert.equal(chip.href, DESIGN_CHIP_HREF);

    const loaded = await loadDesignChip(async (url, init) => {
      assert.equal(url, DESIGN_CHIP_PATH);
      assert.ok(!init || !init.method || init.method === 'GET');
      return fetch(`${base}${DESIGN_CHIP_PATH}`);
    });
    assert.equal(loaded.itemCount, 0);
    assert.equal(loaded.quiet, true);
    assert.equal((await studio.designs.getTray()).items.length, 0);
  });
});

test('clear control stays on the Studio design page source', async () => {
  const html = await readFile(join(repoRoot, 'src/studio/ui/index.html'), 'utf8');
  const js = await readFile(join(repoRoot, 'src/studio/ui/app.js'), 'utf8');
  const chip = await readFile(join(repoRoot, 'src/studio/ui/design-chip.js'), 'utf8');
  assert.match(html, /id="design-clear-tray"/);
  assert.match(html, />Clear tray</);
  assert.match(html, /id="design-clear-tray"[^>]*hidden/);
  assert.match(js, /\/api\/design\/tray\/clear/);
  assert.match(js, /window\.confirm\('Clear the annotation tray\?'\)/);
  assert.match(js, /elements\['design-clear-tray'\]\.hidden = items\.length === 0/);
  assert.match(js, /await loadTray\(\)/);
  assert.doesNotMatch(html, /id="(?:design-chip-2|tray-chip)"/);
  assert.doesNotMatch(chip, /\/api\/design\/tray\/clear/);
  assert.doesNotMatch(chip, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
});
