import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../src/studio/server.js';
import { buildBrief } from '../src/core/brief.js';
import { loadConfig } from '../src/core/config.js';
import { dayKey } from '../src/core/cost.js';
import {
  SPEND_CHIP_HREF,
  loadSpendChip,
  refreshSpendChip,
  renderSpendChip,
  spendChipFromBrief,
} from '../src/studio/ui/spend-chip.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME_PAGES = ['/', '/knowledge', '/daemon', '/brief', '/android'];

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-spend-chip-'));
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

async function snapshotBudgetFiles(home) {
  const files = {};
  for (const name of ['cost.json', 'config.json']) {
    try {
      files[name] = await readFile(join(home, name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') files[name] = null;
      else throw error;
    }
  }
  return files;
}

function chipElement() {
  const attrs = {};
  return {
    hidden: true,
    textContent: '',
    href: '/brief',
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

test('chip data matches brief spend', async () => {
  await withServer(async ({ base, home, studio }) => {
    const today = dayKey(new Date());
    await studio.store.saveRun({
      id: 'run_chip',
      goal: 'track spend',
      status: 'succeeded',
      costUsd: 2.25,
      createdAt: `${today}T10:00:00.000`,
      finishedAt: `${today}T10:01:00.000`,
    });
    const set = await fetch(`${base}/api/brief/budget`, {
      method: 'POST',
      headers: {
        origin: base,
        'x-toris-studio-token': 'test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ maxDailyCostUsd: 10 }),
    });
    assert.equal(set.status, 200);

    const body = await (await fetch(`${base}/api/brief`)).json();
    const { config } = await loadConfig(home);
    const expected = await buildBrief({
      home,
      store: studio.store,
      config,
      cwd: home,
    });
    assert.deepEqual(body.spend, expected.spend);

    const chip = spendChipFromBrief(body.spend);
    assert.equal(chip.spentUsd, expected.spend.spentUsd);
    assert.equal(chip.capUsd, expected.spend.capUsd);
    assert.equal(chip.remainingUsd, expected.spend.remainingUsd);
    assert.equal(chip.spentUsd, 2.25);
    assert.equal(chip.capUsd, 10);
    assert.equal(chip.remainingUsd, 7.75);
    assert.equal(chip.quiet, false);
    assert.equal(chip.href, SPEND_CHIP_HREF);
    assert.match(chip.label, /\$2\.25 \/ \$10\.00/);
    assert.match(chip.remainingLabel, /\$7\.75 left/);

    const loaded = await loadSpendChip(async (url, init) => {
      assert.equal(url, '/api/brief');
      assert.ok(!init || !init.method || init.method === 'GET');
      return fetch(`${base}/api/brief`);
    });
    assert.equal(loaded.spentUsd, expected.spend.spentUsd);
    assert.equal(loaded.capUsd, expected.spend.capUsd);
    assert.equal(loaded.remainingUsd, expected.spend.remainingUsd);
  });
});

test('rendering does not write', async () => {
  await withServer(async ({ base, home }) => {
    const before = await snapshotBudgetFiles(home);
    const calls = [];
    const el = chipElement();
    const fetchGet = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      return fetch(`${base}${url}`, { method: 'GET' });
    };
    await refreshSpendChip(el, fetchGet);

    for (const page of CHROME_PAGES) {
      assert.equal((await fetch(`${base}${page}`)).status, 200);
    }
    assert.equal((await fetch(`${base}/assets/spend-chip.js`)).status, 200);
    assert.deepEqual(await snapshotBudgetFiles(home), before);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.method === 'GET' && call.url === '/api/brief' && call.body == null));

    const source = await readFile(join(repoRoot, 'src/studio/ui/spend-chip.js'), 'utf8');
    assert.doesNotMatch(source, /\/api\/brief\/budget/);
    assert.doesNotMatch(source, /method:\s*['"]POST['"]/);
    assert.doesNotMatch(source, /setDailyBudget|cost\.json|config\.json/);
  });
});

test('missing budget stays quiet on remaining', () => {
  const none = spendChipFromBrief({ spentUsd: 0, capUsd: null, remainingUsd: null });
  assert.equal(none.quiet, true);
  assert.equal(none.hidden, true);
  assert.equal(none.remainingUsd, null);
  assert.equal(none.remainingLabel, '');
  assert.equal(none.label, '');

  const spentOnly = spendChipFromBrief({ spentUsd: 1.5, capUsd: 0, remainingUsd: null });
  assert.equal(spentOnly.quiet, false);
  assert.equal(spentOnly.capUsd, null);
  assert.equal(spentOnly.remainingUsd, null);
  assert.equal(spentOnly.remainingLabel, '');
  assert.equal(spentOnly.label, '$1.50');

  const el = chipElement();
  renderSpendChip(el, spentOnly);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, '$1.50');
  assert.equal(el.getAttribute('title'), null);
  assert.match(el.getAttribute('aria-label'), /Today's spend \$1\.50/);
  assert.doesNotMatch(el.getAttribute('aria-label'), /left/);
});

test('shared chrome pages load the chip and never post from it', async () => {
  await withServer(async ({ base }) => {
    const script = await (await fetch(`${base}/assets/spend-chip.js`)).text();
    assert.match(script, /\/api\/brief/);
    assert.doesNotMatch(script, /\/api\/brief\/budget/);
    assert.match(script, /pageshow/);
    assert.doesNotMatch(script, /setInterval/);

    for (const page of CHROME_PAGES) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.match(html, /id="spend-chip"/);
      assert.match(html, /href="\/brief"/);
      assert.match(html, /\/assets\/spend-chip\.js/);
    }
  });
});
