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
  refreshDesignChip,
  renderDesignChip,
  startDesignChip,
} from '../src/studio/ui/design-chip.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME_PAGES = ['/', '/knowledge', '/daemon', '/brief', '/android'];

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-design-chip-'));
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

function chipElement() {
  const attrs = {};
  return {
    hidden: true,
    textContent: '',
    href: '/design',
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

test('chip data matches getTray / presentTray item count', async () => {
  await withServer(async ({ base, studio }) => {
    const first = await seed(studio);
    const second = await seed(studio, { selector: '.price', outerHTML: '<span class="price">$12</span>' });
    await studio.designs.removeFromTray(second.id);

    const tray = await studio.designs.getTray();
    const presented = await studio.designs.presentTray({ items: [{ id: first.id, note: '' }] });
    const body = await (await fetch(`${base}${DESIGN_CHIP_PATH}`)).json();
    assert.equal(tray.items.length, 1);
    assert.equal(tray.items[0].id, first.id);
    assert.equal(presented.items.length, tray.items.length);
    assert.equal(presented.items[0].id, first.id);
    assert.equal(body.items.length, tray.items.length);
    assert.equal(body.items[0].id, first.id);

    const chip = designChipFromTray(body);
    assert.equal(chip.itemCount, tray.items.length);
    assert.equal(chip.quiet, false);
    assert.equal(chip.hidden, false);
    assert.equal(chip.href, DESIGN_CHIP_HREF);
    assert.equal(chip.label, '1 design');

    const loaded = await loadDesignChip(async (url, init) => {
      assert.equal(url, DESIGN_CHIP_PATH);
      assert.ok(!init || !init.method || init.method === 'GET');
      return fetch(`${base}${DESIGN_CHIP_PATH}`);
    });
    assert.equal(loaded.itemCount, tray.items.length);
    assert.equal(loaded.label, '1 design');
  });
});

test('rendering and page GET do not write tray.json or design captures', async () => {
  await withServer(async ({ base, home, studio }) => {
    await seed(studio);
    const before = await snapshotDesignStore(home);
    const calls = [];
    const el = chipElement();
    const fetchGet = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      return fetch(`${base}${url}`, { method: 'GET' });
    };
    await refreshDesignChip(el, fetchGet);

    for (const page of CHROME_PAGES) {
      assert.equal((await fetch(`${base}${page}`)).status, 200);
    }
    assert.equal((await fetch(`${base}/assets/design-chip.js`)).status, 200);
    assert.deepEqual(await snapshotDesignStore(home), before);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.method === 'GET' && call.url === DESIGN_CHIP_PATH && call.body == null));

    const source = await readFile(join(repoRoot, 'src/studio/ui/design-chip.js'), 'utf8');
    assert.doesNotMatch(source, /\/api\/design\/tray\/(?:items|clear)/);
    assert.doesNotMatch(source, /\/api\/design\/captures/);
    assert.doesNotMatch(source, /\/api\/agent\/turn/);
    assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    assert.doesNotMatch(source, /tray\.json|clearTray|saveTray|addToTray|removeFromTray/);
  });
});

test('zero tray items stay quiet; nonzero shows the label and /design', () => {
  const none = designChipFromTray({ items: [] });
  assert.equal(none.quiet, true);
  assert.equal(none.hidden, true);
  assert.equal(none.itemCount, 0);
  assert.equal(none.label, '');
  assert.equal(none.href, DESIGN_CHIP_HREF);

  const missing = designChipFromTray({});
  assert.equal(missing.quiet, true);
  assert.equal(missing.itemCount, 0);

  const one = designChipFromTray({ items: [{ id: 'des_1', selector: '#buy' }] });
  assert.equal(one.quiet, false);
  assert.equal(one.hidden, false);
  assert.equal(one.itemCount, 1);
  assert.equal(one.label, '1 design');
  assert.equal(one.href, DESIGN_CHIP_HREF);

  const many = designChipFromTray({
    items: [
      { id: 'des_1', selector: '#buy' },
      { id: 'des_2', selector: '.price' },
    ],
  });
  assert.equal(many.label, '2 design');
  assert.equal(many.itemCount, 2);

  const hiddenEl = chipElement();
  renderDesignChip(hiddenEl, none);
  assert.equal(hiddenEl.hidden, true);
  assert.equal(hiddenEl.textContent, '');
  assert.equal(hiddenEl.href, '/design');
  assert.equal(hiddenEl.getAttribute('aria-label'), null);

  const el = chipElement();
  renderDesignChip(el, one);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, '1 design');
  assert.equal(el.href, '/design');
  assert.equal(el.getAttribute('href'), '/design');
  assert.equal(el.getAttribute('aria-label'), '1 design');

  const dumpQuiet = `<a id="design-chip" class="design-chip" href="${hiddenEl.href}"${hiddenEl.hidden ? ' hidden' : ''}>${hiddenEl.textContent}</a>`;
  const dumpVisible = `<a id="design-chip" class="design-chip" href="${el.href}"${el.hidden ? ' hidden' : ''} aria-label="${el.getAttribute('aria-label')}">${el.textContent}</a>`;
  assert.equal(dumpQuiet, '<a id="design-chip" class="design-chip" href="/design" hidden></a>');
  assert.equal(dumpVisible, '<a id="design-chip" class="design-chip" href="/design" aria-label="1 design">1 design</a>');
});

test('shared chrome pages load the chip and never post from it', async () => {
  await withServer(async ({ base, home }) => {
    const before = await snapshotDesignStore(home);
    const script = await (await fetch(`${base}/assets/design-chip.js`)).text();
    assert.match(script, /\/api\/design\/tray/);
    assert.doesNotMatch(script, /\/api\/design\/tray\/(?:items|clear)/);
    assert.doesNotMatch(script, /\/api\/design\/captures/);
    assert.doesNotMatch(script, /\/api\/agent\/turn/);
    assert.doesNotMatch(script, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    assert.match(script, /pageshow/);
    assert.doesNotMatch(script, /setInterval/);

    for (const page of CHROME_PAGES) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.match(html, /id="design-chip"/);
      assert.match(html, /href="\/design"/);
      assert.match(html, /\/assets\/design-chip\.js/);
    }
    assert.equal((await fetch(`${base}${DESIGN_CHIP_PATH}`)).status, 200);
    const afterPages = await snapshotDesignStore(home);
    assert.equal(afterPages['tray.json'], null);
    assert.deepEqual(afterPages.captures, before.captures);

    const el = chipElement();
    const root = { getElementById: (id) => (id === 'design-chip' ? el : null) };
    const target = { addEventListener() {}, removeEventListener() {} };
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      return { ok: true, json: async () => ({ items: [{ id: 'des_1' }, { id: 'des_2' }] }) };
    };
    const stop = startDesignChip({ root, fetchImpl, target });
    await refreshDesignChip(el, fetchImpl);
    const dump = `<a id="design-chip" class="design-chip" href="${el.href}"${el.hidden ? ' hidden' : ''} aria-label="${el.getAttribute('aria-label')}">${el.textContent}</a>`;
    assert.equal(dump, '<a id="design-chip" class="design-chip" href="/design" aria-label="2 design">2 design</a>');
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.method === 'GET' && call.url === DESIGN_CHIP_PATH && call.body == null));
    stop();
  });
});
