import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../src/studio/server.js';
import {
  ANDROID_CHIP_HREF,
  ANDROID_CHIP_LABEL,
  ANDROID_CHIP_PATH,
  androidChipFromStatus,
  loadAndroidChip,
  refreshAndroidChip,
  renderAndroidChip,
} from '../src/studio/ui/android-chip.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME_PAGES = ['/', '/knowledge', '/daemon', '/brief', '/android'];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

function mockExec() {
  return async (_bin, args, options = {}) => {
    const joined = args.join(' ');
    if (joined.includes('devices')) {
      return { exitCode: 0, stdout: 'List of devices attached\nemulator-5554 device product:sdk model:Pixel\n', stderr: '', timedOut: false };
    }
    if (joined.includes('version')) {
      return { exitCode: 0, stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '', timedOut: false };
    }
    return {
      exitCode: 1,
      stdout: options.encoding === 'buffer' ? Buffer.alloc(0) : '',
      stderr: `unexpected ${joined}`,
      timedOut: false,
    };
  };
}

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-android-chip-'));
  const android = extra.android || extra.detect || extra.exec || extra.status
    ? (extra.android || extra)
    : { detect: () => null };
  const studio = await createStudioServer({
    home,
    cwd: home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    android,
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

async function snapshotAndroidHome(home) {
  const root = join(home, 'android');
  try {
    const names = (await readdir(root, { recursive: true })).sort();
    const files = {};
    for (const name of names) {
      try {
        files[name] = await readFile(join(root, name));
      } catch (error) {
        if (error.code === 'EISDIR') files[name] = 'dir';
        else throw error;
      }
    }
    return files;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function chipElement() {
  const attrs = {};
  return {
    hidden: true,
    textContent: '',
    href: '/android',
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

test('chip data matches GET /api/android device list', async () => {
  await withServer(async ({ base }) => {
    const body = await (await fetch(`${base}${ANDROID_CHIP_PATH}`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.devices.length, 1);
    assert.equal(body.devices[0].serial, 'emulator-5554');

    const chip = androidChipFromStatus(body);
    assert.equal(chip.deviceCount, 1);
    assert.equal(chip.quiet, false);
    assert.equal(chip.hidden, false);
    assert.equal(chip.label, ANDROID_CHIP_LABEL);
    assert.equal(chip.href, ANDROID_CHIP_HREF);

    const loaded = await loadAndroidChip(async (url, init) => {
      assert.equal(url, ANDROID_CHIP_PATH);
      assert.ok(!init || !init.method || init.method === 'GET');
      return fetch(`${base}${ANDROID_CHIP_PATH}`);
    });
    assert.equal(loaded.deviceCount, 1);
    assert.equal(loaded.label, ANDROID_CHIP_LABEL);
  }, { detect: (bin) => (bin === 'adb' ? '/mock/adb' : null), exec: mockExec() });
});

test('missing adb or failed devices stay quiet', async () => {
  await withServer(async ({ base }) => {
    const missing = await (await fetch(`${base}${ANDROID_CHIP_PATH}`)).json();
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.devices, []);
    const missingChip = androidChipFromStatus(missing);
    assert.equal(missingChip.quiet, true);
    assert.equal(missingChip.hidden, true);
    assert.equal(missingChip.deviceCount, 0);
    assert.equal(missingChip.label, '');
    assert.equal(missingChip.href, ANDROID_CHIP_HREF);
  }, { detect: () => null });

  await withServer(async ({ base }) => {
    const failed = await (await fetch(`${base}${ANDROID_CHIP_PATH}`)).json();
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.devices, []);
    assert.match(failed.error, /cannot start/);
    const failedChip = androidChipFromStatus(failed);
    assert.equal(failedChip.quiet, true);
    assert.equal(failedChip.hidden, true);
    assert.equal(failedChip.label, '');
  }, {
    detect: (bin) => (bin === 'adb' ? '/mock/adb' : null),
    exec: async (_bin, args) => {
      if (args.includes('version')) {
        return { exitCode: 0, stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '', timedOut: false };
      }
      if (args.includes('devices')) {
        return { exitCode: 1, stdout: '', stderr: 'adb: cannot start server', timedOut: false };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected', timedOut: false };
    },
  });

  await withServer(async ({ base }) => {
    const empty = await (await fetch(`${base}${ANDROID_CHIP_PATH}`)).json();
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.devices, []);
    const emptyChip = androidChipFromStatus(empty);
    assert.equal(emptyChip.quiet, true);
    assert.equal(emptyChip.hidden, true);
    assert.equal(emptyChip.deviceCount, 0);
    assert.equal(emptyChip.label, '');
  }, {
    detect: (bin) => (bin === 'adb' ? '/mock/adb' : null),
    exec: async (_bin, args) => {
      if (args.includes('version')) {
        return { exitCode: 0, stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '', timedOut: false };
      }
      if (args.includes('devices')) {
        return { exitCode: 0, stdout: 'List of devices attached\n', stderr: '', timedOut: false };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected', timedOut: false };
    },
  });
});

test('rendering and page GET do not write under ~/.toris/android/', async () => {
  await withServer(async ({ base, home }) => {
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);
    const before = await snapshotAndroidHome(home);
    const calls = [];
    const el = chipElement();
    const fetchGet = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      return fetch(`${base}${url}`, { method: 'GET' });
    };
    await refreshAndroidChip(el, fetchGet);

    for (const page of CHROME_PAGES) {
      assert.equal((await fetch(`${base}${page}`)).status, 200);
    }
    assert.equal((await fetch(`${base}/assets/android-chip.js`)).status, 200);
    assert.deepEqual(await snapshotAndroidHome(home), before);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.method === 'GET' && call.url === ANDROID_CHIP_PATH && call.body == null));

    const source = await readFile(join(repoRoot, 'src/studio/ui/android-chip.js'), 'utf8');
    assert.doesNotMatch(source, /\/api\/android\/(?:screenshot|logcat|install|media|artifacts)/);
    assert.doesNotMatch(source, /method:\s*['"]POST['"]/);
    assert.doesNotMatch(source, /androidScreenshot|androidLogcat|androidHome/);
  }, {
    detect: (bin) => (bin === 'adb' ? '/mock/adb' : null),
    exec: mockExec(),
    screenshot: async () => {
      throw new Error('screenshot must not run from the chip');
    },
    logcat: async () => {
      throw new Error('logcat must not run from the chip');
    },
  });
});

test('zero devices or adb error stay quiet; listed devices show android and /android', () => {
  const none = androidChipFromStatus({ ok: true, devices: [] });
  assert.equal(none.quiet, true);
  assert.equal(none.hidden, true);
  assert.equal(none.deviceCount, 0);
  assert.equal(none.label, '');
  assert.equal(none.href, ANDROID_CHIP_HREF);

  const missing = androidChipFromStatus({});
  assert.equal(missing.quiet, true);
  assert.equal(missing.deviceCount, 0);

  const absent = androidChipFromStatus(undefined);
  assert.equal(absent.quiet, true);
  assert.equal(absent.hidden, true);

  const failed = androidChipFromStatus({
    ok: false,
    adb: '/mock/adb',
    devices: [],
    error: 'adb: cannot start server',
  });
  assert.equal(failed.quiet, true);
  assert.equal(failed.hidden, true);
  assert.equal(failed.label, '');

  const failedWithGhost = androidChipFromStatus({
    ok: false,
    devices: [{ serial: 'emulator-5554', state: 'device' }],
    error: 'adb: cannot start server',
  });
  assert.equal(failedWithGhost.quiet, true);
  assert.equal(failedWithGhost.hidden, true);

  const live = androidChipFromStatus({
    ok: true,
    adb: '/mock/adb',
    devices: [{ serial: 'emulator-5554', state: 'device', model: 'Pixel' }],
  });
  assert.equal(live.quiet, false);
  assert.equal(live.hidden, false);
  assert.equal(live.deviceCount, 1);
  assert.equal(live.label, ANDROID_CHIP_LABEL);
  assert.equal(live.href, ANDROID_CHIP_HREF);

  const hiddenEl = chipElement();
  renderAndroidChip(hiddenEl, none);
  assert.equal(hiddenEl.hidden, true);
  assert.equal(hiddenEl.textContent, '');
  assert.equal(hiddenEl.href, '/android');
  assert.equal(hiddenEl.getAttribute('aria-label'), null);

  const el = chipElement();
  renderAndroidChip(el, live);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, 'android');
  assert.equal(el.href, '/android');
  assert.equal(el.getAttribute('href'), '/android');
  assert.equal(el.getAttribute('aria-label'), 'android');
});

test('shared chrome pages load the chip and never post from it', async () => {
  await withServer(async ({ base }) => {
    const script = await (await fetch(`${base}/assets/android-chip.js`)).text();
    assert.match(script, /\/api\/android/);
    assert.doesNotMatch(script, /\/api\/android\/(?:screenshot|logcat|install|media|artifacts)/);
    assert.doesNotMatch(script, /method:\s*['"]POST['"]/);
    assert.match(script, /pageshow/);
    assert.doesNotMatch(script, /setInterval/);

    for (const page of CHROME_PAGES) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.match(html, /id="android-chip"/);
      assert.match(html, /href="\/android"/);
      assert.match(html, /\/assets\/android-chip\.js/);
    }
  });
});
