import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import {
  composeAndroidTurnMessage,
  listAndroidArtifacts,
  loadAndroidEvidence,
  resolveAndroidArtifact,
  resolveAndroidImage,
} from '../src/studio/android-api.js';
import { HttpError } from '../src/studio/http.js';

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

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-android-'));
  const androidShaped = extra.detect || extra.exec || extra.status || extra.screenshot || extra.logcat || extra.listArtifacts;
  const options = androidShaped && extra.android == null && extra.runAgentTurn == null
    ? { android: extra }
    : extra;
  const studio = await createStudioServer({
    home,
    cwd: home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    ...options,
    android: options.android || { detect: () => null },
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
    assert.match(html, /id="android-agent-form"/);
    assert.match(html, /id="android-note"/);
    assert.match(html, /id="android-send"/);
    const script = await (await fetch(`${base}/assets/android.js`)).text();
    assert.match(script, /\/api\/agent\/turn/);
    assert.match(script, /android:\s*\{\s*artifacts/);
    assert.equal((await fetch(`${base}/assets/android.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/android.css`)).status, 200);
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

test('android artifacts and media follow a symlinked toris home', async () => {
  const realHome = await mkdtemp(join(tmpdir(), 'toris-android-real-'));
  const parent = await mkdtemp(join(tmpdir(), 'toris-android-link-'));
  const home = join(parent, 'home-link');
  try {
    await symlink(realHome, home);
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);
    const listed = await listAndroidArtifacts(home);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].rel, 'screenshots/ok.png');
    const ok = await resolveAndroidImage(home, 'screenshots/ok.png');
    const androidRoot = await realpath(join(home, 'android'));
    assert.ok(ok.path === androidRoot || ok.path.startsWith(`${androidRoot}${sep}`));
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(realHome, { recursive: true, force: true });
  }
});

test('composeAndroidTurnMessage attaches a screenshot path and a log excerpt', async () => {
  const composed = composeAndroidTurnMessage('CTA is clipped on Pixel 5.', [
    {
      rel: 'screenshots/scr_pixel.png',
      path: '/tmp/home/android/screenshots/scr_pixel.png',
      image: true,
    },
    {
      rel: 'logs/log_crash.log',
      path: '/tmp/home/android/logs/log_crash.log',
      image: false,
      excerpt: 'E AndroidRuntime: FATAL EXCEPTION: main',
    },
  ]);
  assert.match(composed, /CTA is clipped on Pixel 5/);
  assert.match(composed, /Android evidence \(2\)/);
  assert.match(composed, /screenshots\/scr_pixel\.png/);
  assert.match(composed, /Screenshot: \/tmp\/home\/android\/screenshots\/scr_pixel\.png/);
  assert.match(composed, /FATAL EXCEPTION: main/);
});

test('POST /api/agent/turn with android artifacts requires Origin and session token', async () => {
  await withServer(async ({ base, home }) => {
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);

    const denied = await fetch(`${base}/api/agent/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'look at this shot',
        android: { artifacts: ['screenshots/ok.png'] },
      }),
    });
    assert.equal(denied.status, 403);

    const badToken = await fetch(`${base}/api/agent/turn`, {
      method: 'POST',
      headers: {
        origin: base,
        'x-toris-studio-token': 'wrong',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: 'look at this shot',
        android: { artifacts: ['screenshots/ok.png'] },
      }),
    });
    assert.equal(badToken.status, 403);
  }, {
    runAgentTurn: async () => {
      throw new Error('runner must not be called without studio auth');
    },
  });
});

test('POST /api/agent/turn references the selected android artifact on the turn', async () => {
  let received;
  await withServer(async ({ base, home }) => {
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await mkdir(join(home, 'android', 'logs'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);
    await writeFile(join(home, 'android', 'logs', 'note.log'), 'I toris: hello from device\n');

    const response = await fetch(
      `${base}/api/agent/turn`,
      mutation(base, {
        agent: 'implementer',
        message: 'CTA is clipped on this screenshot.',
        android: { artifacts: ['screenshots/ok.png', 'logs/note.log'] },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(received.message, 'CTA is clipped on this screenshot.');
    assert.equal(received.androidEvidence.length, 2);
    assert.equal(received.androidEvidence[0].rel, 'screenshots/ok.png');
    assert.equal(received.androidEvidence[0].image, true);
    assert.match(received.androidEvidence[0].path, /screenshots\/ok\.png$/);
    assert.equal(received.androidEvidence[1].rel, 'logs/note.log');
    assert.match(received.androidEvidence[1].excerpt, /hello from device/);
    const composed = composeAndroidTurnMessage(received.message, received.androidEvidence);
    assert.match(composed, /CTA is clipped on this screenshot/);
    assert.match(composed, /screenshots\/ok\.png/);
    assert.match(composed, /Screenshot:/);
    assert.match(composed, /hello from device/);
  }, {
    runAgentTurn: async (input) => {
      received = input;
      return { ok: true, text: 'will inspect the shot', agent: { id: 'implementer', title: 'Implementer' } };
    },
  });
});

test('POST /api/agent/turn rejects android artifact traversal', async () => {
  await withServer(async ({ base, home }) => {
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);
    await writeFile(join(home, 'secret.png'), PNG);

    const traversal = await fetch(
      `${base}/api/agent/turn`,
      mutation(base, {
        agent: 'implementer',
        message: 'exfiltrate',
        android: { artifacts: ['../secret.png'] },
      }),
    );
    assert.equal(traversal.status, 400);

    const encoded = await fetch(
      `${base}/api/agent/turn`,
      mutation(base, {
        agent: 'implementer',
        message: 'exfiltrate',
        android: { artifacts: ['%2e%2e/secret.png'] },
      }),
    );
    assert.equal(encoded.status, 400);

    await assert.rejects(
      () => loadAndroidEvidence(home, ['../secret.png']),
      (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
      () => resolveAndroidArtifact(home, '../secret.png'),
      (error) => error instanceof HttpError && error.status === 400,
    );
  }, {
    runAgentTurn: async () => {
      throw new Error('runner must not be called for a traversal path');
    },
  });
});

test('android evidence follows a symlinked toris home via realpath', async () => {
  const realHome = await mkdtemp(join(tmpdir(), 'toris-android-turn-real-'));
  const parent = await mkdtemp(join(tmpdir(), 'toris-android-turn-link-'));
  const home = join(parent, 'home-link');
  try {
    await symlink(realHome, home);
    await mkdir(join(home, 'android', 'screenshots'), { recursive: true });
    await writeFile(join(home, 'android', 'screenshots', 'ok.png'), PNG);
    const evidence = await loadAndroidEvidence(home, ['screenshots/ok.png']);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].rel, 'screenshots/ok.png');
    const androidRoot = await realpath(join(home, 'android'));
    assert.ok(evidence[0].path === join(androidRoot, 'screenshots', 'ok.png') || evidence[0].path.startsWith(`${androidRoot}${sep}`));
    const composed = composeAndroidTurnMessage('fix the CTA', evidence);
    assert.match(composed, /screenshots\/ok\.png/);
    assert.match(composed, /Screenshot:/);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(realHome, { recursive: true, force: true });
  }
});

test('Studio does not expose android install', async () => {
  await withServer(async ({ base }) => {
    const posted = await fetch(`${base}/api/android/install`, mutation(base, { apk: '/tmp/app.apk' }));
    assert.equal(posted.status, 404);
    const get = await fetch(`${base}/api/android/install`);
    assert.equal(get.status, 404);
  });
});
