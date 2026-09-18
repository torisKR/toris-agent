import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../src/studio/server.js';
import { listAndroidArtifacts, resolveAndroidImage } from '../src/studio/android-api.js';
import { HttpError } from '../src/studio/http.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

function mockExec() {
  return async (_bin, args, options = {}) => {
    const joined = args.join(' ');
    if (joined.includes('screencap')) {
      return { exitCode: 0, stdout: PNG, stderr: '', timedOut: false };
    }
    if (joined.includes('logcat')) {
      return { exitCode: 0, stdout: 'I toris: hello from device\n', stderr: '', timedOut: false };
    }
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

async function withServer(fn, android = { detect: () => null }) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-android-'));
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

function mutation(base, body = {}) {
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

test('GET /android is a standalone page that does not reuse app.js', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/android`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="android-title"/);
    assert.match(html, /\/assets\/android\.js/);
    assert.doesNotMatch(html, /\/assets\/app\.js/);
    assert.match(html, /href="\/android"/);
    assert.equal((await fetch(`${base}/assets/android.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/android.css`)).status, 200);
    const js = await readFile(join(root, 'src/studio/ui/android.js'), 'utf8');
    assert.match(js, /Promise\.allSettled/);
    assert.match(js, /refresh\(\)\.catch/);
  });
});

test('GET /api/android is 200 when adb is missing', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/android`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.adb, null);
    assert.equal(body.ready, false);
    assert.equal(body.version, null);
    assert.deepEqual(body.devices, []);
  });
});

test('GET /api/android stays 200 when adb devices fails', async () => {
  await withServer(async ({ base, home }) => {
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);
    const response = await fetch(`${base}/api/android`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.adb, '/mock/adb');
    assert.equal(body.ready, false);
    assert.deepEqual(body.devices, []);
    assert.match(body.error, /cannot start/);
    const artifacts = await (await fetch(`${base}/api/android/artifacts`)).json();
    assert.equal(artifacts.ok, true);
    assert.equal(artifacts.items.length, 1);
    assert.equal(artifacts.items[0].name, 'ok.png');
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
});

test('GET /api/android returns the mocked androidStatus shape', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/android`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.adb, '/mock/adb');
    assert.equal(body.emulator, null);
    assert.equal(body.ready, true);
    assert.match(body.version, /Android Debug Bridge/);
    assert.equal(body.devices.length, 1);
    assert.equal(body.devices[0].serial, 'emulator-5554');
    assert.equal(body.devices[0].state, 'device');
    assert.equal(body.devices[0].model, 'Pixel');
  }, { detect: (bin) => (bin === 'adb' ? '/mock/adb' : null), exec: mockExec() });
});

test('GET /api/android/artifacts lists newest files under the toris home', async () => {
  await withServer(async ({ base, home }) => {
    const root = join(home, 'android');
    await mkdir(join(root, 'screenshots'), { recursive: true });
    await mkdir(join(root, 'logs'), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 'toris-android-outside-'));
    try {
      await writeFile(join(outside, 'secret.png'), PNG);
      await symlink(join(outside, 'secret.png'), join(root, 'screenshots', 'escaped.png'));
      const names = [];
      for (let i = 0; i < 25; i += 1) {
        const name = `scr_${String(i).padStart(2, '0')}.png`;
        const file = join(root, 'screenshots', name);
        await writeFile(file, PNG);
        const at = new Date(Date.UTC(2026, 8, 18, 0, 0, i));
        await utimes(file, at, at);
        names.push(name);
      }
      await writeFile(join(root, 'logs', 'log_old.log'), 'old log\n');
      await utimes(join(root, 'logs', 'log_old.log'), new Date('2020-01-01'), new Date('2020-01-01'));

      const listed = await (await fetch(`${base}/api/android/artifacts`)).json();
      assert.equal(listed.ok, true);
      assert.equal(listed.items.length, 20);
      assert.equal(listed.items[0].name, 'scr_24.png');
      assert.equal(listed.items[0].bytes, PNG.length);
      assert.equal(listed.items[0].rel, 'screenshots/scr_24.png');
      assert.equal(listed.items[0].image, true);
      assert.ok(listed.items.every((item) => item.rel && !item.rel.includes('..')));
      assert.ok(!listed.items.some((item) => item.name === 'escaped.png'));
      assert.ok(!listed.items.some((item) => String(item.rel).includes(outside)));
      assert.equal(listed.items.at(-1).name, 'scr_05.png');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('artifacts and media follow a symlinked toris home', async () => {
  const realHome = await mkdtemp(join(tmpdir(), 'toris-android-real-'));
  const parent = await mkdtemp(join(tmpdir(), 'toris-android-links-'));
  const home = join(parent, 'home-link');
  await symlink(realHome, home);
  const studio = await createStudioServer({
    home,
    cwd: home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    android: { detect: () => null },
  });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);
    const listed = await listAndroidArtifacts(home);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].rel, 'screenshots/ok.png');
    const file = await resolveAndroidImage(home, 'screenshots/ok.png');
    assert.equal(file.mime, 'image/png');
    const androidRoot = await realpath(join(home, 'android'));
    assert.ok(file.path === androidRoot || file.path.startsWith(`${androidRoot}${sep}`));

    const viaApi = await (await fetch(`${base}/api/android/artifacts`)).json();
    assert.equal(viaApi.items.length, 1);
    const media = await fetch(`${base}/api/android/media?path=${encodeURIComponent('screenshots/ok.png')}`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
  } finally {
    await studio.close();
    await rm(parent, { recursive: true, force: true });
    await rm(realHome, { recursive: true, force: true });
  }
});

test('listAndroidArtifacts never reports a path outside home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-android-list-'));
  try {
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);
    const listed = await listAndroidArtifacts(home);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].rel, 'screenshots/ok.png');
    const androidRoot = await realpath(join(home, 'android'));
    const abs = resolve(androidRoot, listed.items[0].rel);
    assert.ok(abs === androidRoot || abs.startsWith(`${androidRoot}${sep}`));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('POST /api/android/screenshot requires Origin and session token', async () => {
  await withServer(async ({ base }) => {
    const denied = await fetch(`${base}/api/android/screenshot`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403);

    const badOrigin = await fetch(`${base}/api/android/screenshot`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5824',
        'x-toris-studio-token': 'test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(badOrigin.status, 403);

    const badToken = await fetch(`${base}/api/android/screenshot`, {
      method: 'POST',
      headers: {
        origin: base,
        'x-toris-studio-token': 'wrong',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(badToken.status, 403);
  }, { detect: (bin) => (bin === 'adb' ? '/mock/adb' : null), exec: mockExec() });
});

test('POST /api/android/screenshot writes a PNG under the toris home', async () => {
  await withServer(async ({ base, home }) => {
    const response = await fetch(`${base}/api/android/screenshot`, mutation(base, { serial: 'emulator-5554' }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.bytes, PNG.length);
    assert.equal(body.serial, 'emulator-5554');
    assert.ok(resolve(body.path).startsWith(resolve(home, 'android')));
    assert.match(body.path, /android\/screenshots\/scr_/);

    const artifacts = await (await fetch(`${base}/api/android/artifacts`)).json();
    assert.equal(artifacts.items.length, 1);
    assert.equal(artifacts.items[0].image, true);

    const media = await fetch(`${base}/api/android/media?path=${encodeURIComponent(artifacts.items[0].rel)}`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await media.arrayBuffer()).subarray(0, 4).equals(PNG.subarray(0, 4)), true);
  }, { detect: (bin) => (bin === 'adb' ? '/mock/adb' : null), exec: mockExec() });
});

test('POST /api/android/logcat requires Origin + token and returns a short tail', async () => {
  await withServer(async ({ base, home }) => {
    const denied = await fetch(`${base}/api/android/logcat`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403);

    const response = await fetch(`${base}/api/android/logcat`, mutation(base, { serial: 'emulator-5554', lines: 50 }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.serial, 'emulator-5554');
    assert.equal(body.lines, 50);
    assert.match(body.tail, /hello from device/);
    assert.ok(resolve(body.path).startsWith(resolve(home, 'android')));
    assert.match(body.path, /android\/logs\/log_/);
  }, { detect: (bin) => (bin === 'adb' ? '/mock/adb' : null), exec: mockExec() });
});

test('POST /api/android/screenshot rejects an invalid serial without shelling out', async () => {
  let called = 0;
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/android/screenshot`, mutation(base, { serial: '$(whoami)' }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /Invalid device serial/);
    assert.equal(called, 0);
  }, {
    detect: (bin) => (bin === 'adb' ? '/mock/adb' : null),
    exec: async () => {
      called += 1;
      return { exitCode: 0, stdout: PNG, stderr: '', timedOut: false };
    },
  });
});

test('android media rejects path traversal and non-image files', async () => {
  await withServer(async ({ base, home }) => {
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await mkdir(join(home, 'android', 'logs'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);
    await writeFile(join(home, 'android', 'logs', 'note.log'), 'not an image\n');
    await writeFile(join(home, 'secret.png'), PNG);

    const traversal = await fetch(`${base}/api/android/media?path=${encodeURIComponent('../secret.png')}`);
    assert.equal(traversal.status, 400);

    const encoded = await fetch(`${base}/api/android/media?path=%2e%2e/secret.png`);
    assert.equal(encoded.status, 400);

    const log = await fetch(`${base}/api/android/media?path=${encodeURIComponent('logs/note.log')}`);
    assert.equal(log.status, 400);

    const missing = await fetch(`${base}/api/android/media?path=${encodeURIComponent('screenshots/missing.png')}`);
    assert.equal(missing.status, 404);

    await assert.rejects(
      () => resolveAndroidImage(home, '../secret.png'),
      (error) => error instanceof HttpError && error.status === 400,
    );
    const ok = await resolveAndroidImage(home, 'screenshots/ok.png');
    const androidRoot = await realpath(join(home, 'android'));
    assert.ok(ok.path === androidRoot || ok.path.startsWith(`${androidRoot}${sep}`));
  });
});

test('Studio does not expose android install', async () => {
  await withServer(async ({ base }) => {
    const posted = await fetch(`${base}/api/android/install`, mutation(base, { apk: '/tmp/app.apk' }));
    assert.equal(posted.status, 404);
    const get = await fetch(`${base}/api/android/install`);
    assert.equal(get.status, 404);
  });
});
