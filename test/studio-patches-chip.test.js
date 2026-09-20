import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../src/studio/server.js';
import { Store } from '../src/core/store.js';
import { discardSavedPatch, listPatches, savePatch } from '../src/core/patches.js';
import {
  PATCHES_CHIP_HREF,
  PATCHES_CHIP_PATH,
  loadPatchesChip,
  patchesChipFromList,
  refreshPatchesChip,
  renderPatchesChip,
} from '../src/studio/ui/patches-chip.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME_PAGES = ['/', '/knowledge', '/daemon', '/brief', '/android'];
const DIFF = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 hello
+from isolation
`;

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-patches-chip-'));
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

async function snapshotPatchesStore(home) {
  const files = {};
  try {
    files['patches.json'] = await readFile(join(home, 'patches.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') files['patches.json'] = null;
    else throw error;
  }
  const diffs = {};
  try {
    const names = (await readdir(join(home, 'patches'))).sort();
    for (const name of names) {
      diffs[name] = await readFile(join(home, 'patches', name), 'utf8');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  files.dir = diffs;
  return files;
}

function chipElement() {
  const attrs = {};
  return {
    hidden: true,
    textContent: '',
    href: '/patches',
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
      if (name === 'href') this.href = String(value);
    },
    removeAttribute(name) {
      delete attrs[name];
      if (name === 'href') this.href = '';
    },
  };
}

test('chip data matches listPatches pending count', async () => {
  await withServer(async ({ base, home, studio }) => {
    const first = await seed(home);
    const second = await seed(home);
    await discardSavedPatch(studio.store, second.id);

    const pending = await listPatches(studio.store, { status: 'pending' });
    const body = await (await fetch(`${base}${PATCHES_CHIP_PATH}`)).json();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, first.id);
    assert.equal(body.items.length, pending.length);
    assert.equal(body.items[0].id, first.id);
    assert.equal(body.items[0].status, 'pending');

    const chip = patchesChipFromList(body);
    assert.equal(chip.pendingCount, pending.length);
    assert.equal(chip.quiet, false);
    assert.equal(chip.hidden, false);
    assert.equal(chip.href, PATCHES_CHIP_HREF);
    assert.equal(chip.label, '1 pending');

    const loaded = await loadPatchesChip(async (url, init) => {
      assert.equal(url, PATCHES_CHIP_PATH);
      assert.ok(!init || !init.method || init.method === 'GET');
      return fetch(`${base}${PATCHES_CHIP_PATH}`);
    });
    assert.equal(loaded.pendingCount, pending.length);
    assert.equal(loaded.label, '1 pending');
  });
});

test('rendering and page GET do not write the patches store', async () => {
  await withServer(async ({ base, home }) => {
    await seed(home);
    const before = await snapshotPatchesStore(home);
    const calls = [];
    const el = chipElement();
    const fetchGet = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      return fetch(`${base}${url}`, { method: 'GET' });
    };
    await refreshPatchesChip(el, fetchGet);

    for (const page of CHROME_PAGES) {
      assert.equal((await fetch(`${base}${page}`)).status, 200);
    }
    assert.equal((await fetch(`${base}/assets/patches-chip.js`)).status, 200);
    assert.deepEqual(await snapshotPatchesStore(home), before);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.method === 'GET' && call.url === PATCHES_CHIP_PATH && call.body == null));

    const source = await readFile(join(repoRoot, 'src/studio/ui/patches-chip.js'), 'utf8');
    assert.doesNotMatch(source, /\/api\/patches\/[^'"\s]+\/(?:apply|discard|review)/);
    assert.doesNotMatch(source, /method:\s*['"]POST['"]/);
    assert.doesNotMatch(source, /patches\.json|\.diff/);
  });
});

test('zero pending stays quiet; nonzero shows the label and /patches', () => {
  const none = patchesChipFromList({ items: [] });
  assert.equal(none.quiet, true);
  assert.equal(none.hidden, true);
  assert.equal(none.pendingCount, 0);
  assert.equal(none.label, '');
  assert.equal(none.href, PATCHES_CHIP_HREF);

  const missing = patchesChipFromList({});
  assert.equal(missing.quiet, true);
  assert.equal(missing.pendingCount, 0);

  const one = patchesChipFromList({ items: [{ id: 'pat_1', status: 'pending' }] });
  assert.equal(one.quiet, false);
  assert.equal(one.hidden, false);
  assert.equal(one.pendingCount, 1);
  assert.equal(one.label, '1 pending');
  assert.equal(one.href, PATCHES_CHIP_HREF);

  const many = patchesChipFromList({
    items: [
      { id: 'pat_1', status: 'pending' },
      { id: 'pat_2', status: 'pending' },
    ],
  });
  assert.equal(many.label, '2 pending');
  assert.equal(many.pendingCount, 2);

  const hiddenEl = chipElement();
  renderPatchesChip(hiddenEl, none);
  assert.equal(hiddenEl.hidden, true);
  assert.equal(hiddenEl.textContent, '');
  assert.equal(hiddenEl.href, '/patches');
  assert.equal(hiddenEl.getAttribute('aria-label'), null);

  const el = chipElement();
  renderPatchesChip(el, one);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, '1 pending');
  assert.equal(el.href, '/patches');
  assert.equal(el.getAttribute('href'), '/patches');
  assert.equal(el.getAttribute('aria-label'), '1 pending');
});

test('shared chrome pages load the chip and never post from it', async () => {
  await withServer(async ({ base }) => {
    const script = await (await fetch(`${base}/assets/patches-chip.js`)).text();
    assert.match(script, /\/api\/patches\?status=pending/);
    assert.doesNotMatch(script, /\/api\/patches\/[^'"\s]+\/(?:apply|discard|review)/);
    assert.doesNotMatch(script, /method:\s*['"]POST['"]/);
    assert.match(script, /pageshow/);
    assert.doesNotMatch(script, /setInterval/);

    for (const page of CHROME_PAGES) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.match(html, /id="patches-chip"/);
      assert.match(html, /href="\/patches"/);
      assert.match(html, /\/assets\/patches-chip\.js/);
    }
  });
});
