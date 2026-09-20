import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../src/studio/server.js';
import { acquireDaemonLock, daemonPaths, readDaemonStatus, releaseDaemonLock } from '../src/daemon/index.js';
import { presentDaemonSnapshot } from '../src/studio/daemon-api.js';
import {
  DAEMON_CHIP_HREF,
  DAEMON_CHIP_LABEL,
  DAEMON_CHIP_PATH,
  daemonChipFromStatus,
  loadDaemonChip,
  refreshDaemonChip,
  renderDaemonChip,
} from '../src/studio/ui/daemon-chip.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME_PAGES = ['/', '/knowledge', '/daemon', '/brief', '/android'];

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-daemon-chip-'));
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

async function snapshotDaemonStore(home) {
  const paths = daemonPaths(home);
  const files = {};
  for (const name of ['lock', 'state']) {
    try {
      files[name] = await readFile(paths[name], 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') files[name] = null;
      else throw error;
    }
  }
  try {
    files.inbox = (await readdir(paths.inbox)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') files.inbox = null;
    else throw error;
  }
  return files;
}

function chipElement() {
  const attrs = {};
  return {
    hidden: true,
    textContent: '',
    href: '/daemon',
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

test('chip data matches GET /api/daemon running flag', async () => {
  await withServer(async ({ base, home }) => {
    const downBody = await (await fetch(`${base}${DAEMON_CHIP_PATH}`)).json();
    const downStatus = await readDaemonStatus(home);
    const downSnapshot = await presentDaemonSnapshot(home);
    assert.equal(downBody.status.running, false);
    assert.equal(downStatus.running, false);
    assert.equal(downSnapshot.status.running, false);
    const downChip = daemonChipFromStatus(downBody.status);
    assert.equal(downChip.running, false);
    assert.equal(downChip.quiet, true);
    assert.equal(downChip.hidden, true);
    assert.equal(downChip.label, '');
    assert.equal(downChip.href, DAEMON_CHIP_HREF);

    await acquireDaemonLock(home, { pid: process.pid, startedAt: '2026-09-20T00:00:00.000Z', version: '0.4.0' });
    try {
      const liveBody = await (await fetch(`${base}${DAEMON_CHIP_PATH}`)).json();
      const liveStatus = await readDaemonStatus(home);
      const liveSnapshot = await presentDaemonSnapshot(home);
      assert.equal(liveBody.status.running, true);
      assert.equal(liveStatus.running, true);
      assert.equal(liveSnapshot.status.running, liveBody.status.running);
      assert.equal(liveBody.status.pid, process.pid);

      const liveChip = daemonChipFromStatus(liveBody.status);
      assert.equal(liveChip.running, true);
      assert.equal(liveChip.quiet, false);
      assert.equal(liveChip.hidden, false);
      assert.equal(liveChip.label, DAEMON_CHIP_LABEL);
      assert.equal(liveChip.href, DAEMON_CHIP_HREF);

      const loaded = await loadDaemonChip(async (url, init) => {
        assert.equal(url, DAEMON_CHIP_PATH);
        assert.ok(!init || !init.method || init.method === 'GET');
        return fetch(`${base}${DAEMON_CHIP_PATH}`);
      });
      assert.equal(loaded.running, true);
      assert.equal(loaded.label, DAEMON_CHIP_LABEL);
    } finally {
      await releaseDaemonLock(home);
    }
  });
});

test('rendering and page GET do not write daemon.lock / daemon.json / inbox', async () => {
  await withServer(async ({ base, home }) => {
    const before = await snapshotDaemonStore(home);
    const calls = [];
    const el = chipElement();
    const fetchGet = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      return fetch(`${base}${url}`, { method: 'GET' });
    };
    await refreshDaemonChip(el, fetchGet);

    for (const page of CHROME_PAGES) {
      assert.equal((await fetch(`${base}${page}`)).status, 200);
    }
    assert.equal((await fetch(`${base}/assets/daemon-chip.js`)).status, 200);
    assert.deepEqual(await snapshotDaemonStore(home), before);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.method === 'GET' && call.url === DAEMON_CHIP_PATH && call.body == null));

    const source = await readFile(join(repoRoot, 'src/studio/ui/daemon-chip.js'), 'utf8');
    assert.doesNotMatch(source, /\/api\/daemon\/(?:run|schedules|start|stop)/);
    assert.doesNotMatch(source, /method:\s*['"]POST['"]/);
    assert.doesNotMatch(source, /daemon\.lock|daemon\.json|inbox/);
  });
});

test('stopped or missing status stays quiet; running shows daemon and /daemon', () => {
  const down = daemonChipFromStatus({ running: false });
  assert.equal(down.quiet, true);
  assert.equal(down.hidden, true);
  assert.equal(down.running, false);
  assert.equal(down.label, '');
  assert.equal(down.href, DAEMON_CHIP_HREF);

  const missing = daemonChipFromStatus({});
  assert.equal(missing.quiet, true);
  assert.equal(missing.running, false);

  const absent = daemonChipFromStatus(undefined);
  assert.equal(absent.quiet, true);
  assert.equal(absent.hidden, true);

  const live = daemonChipFromStatus({ running: true, pid: 1234 });
  assert.equal(live.quiet, false);
  assert.equal(live.hidden, false);
  assert.equal(live.running, true);
  assert.equal(live.label, DAEMON_CHIP_LABEL);
  assert.equal(live.href, DAEMON_CHIP_HREF);

  const hiddenEl = chipElement();
  renderDaemonChip(hiddenEl, down);
  assert.equal(hiddenEl.hidden, true);
  assert.equal(hiddenEl.textContent, '');
  assert.equal(hiddenEl.href, '/daemon');
  assert.equal(hiddenEl.getAttribute('aria-label'), null);

  const el = chipElement();
  renderDaemonChip(el, live);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, 'daemon');
  assert.equal(el.href, '/daemon');
  assert.equal(el.getAttribute('href'), '/daemon');
  assert.equal(el.getAttribute('aria-label'), 'daemon');
});

test('shared chrome pages load the chip and never post from it', async () => {
  await withServer(async ({ base }) => {
    const script = await (await fetch(`${base}/assets/daemon-chip.js`)).text();
    assert.match(script, /\/api\/daemon/);
    assert.doesNotMatch(script, /\/api\/daemon\/(?:run|schedules|start|stop)/);
    assert.doesNotMatch(script, /method:\s*['"]POST['"]/);
    assert.match(script, /pageshow/);
    assert.doesNotMatch(script, /setInterval/);

    for (const page of CHROME_PAGES) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.match(html, /id="daemon-chip"/);
      assert.match(html, /href="\/daemon"/);
      assert.match(html, /\/assets\/daemon-chip\.js/);
    }
  });
});
