import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdAndroid } from '../src/cli/commands/android.js';
import { EXIT } from '../src/core/errors.js';

async function captureJson(fn) {
  const chunks = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await fn();
    return { code, body: JSON.parse(chunks.join('') || 'null') };
  } finally {
    process.stdout.write = write;
  }
}

test('android status is json-scriptable when adb is missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-android-cli-'));
  try {
    const { code, body } = await captureJson(() =>
      cmdAndroid({ home, json: true }, ['status'], {}, { detect: () => null }),
    );
    assert.equal(code, EXIT.OK);
    assert.equal(body.ok, false);
    assert.equal(body.adb, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('android screenshot writes the mocked png path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-android-cli-shot-'));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
    const { code, body } = await captureJson(() =>
      cmdAndroid({ home, json: true }, ['screenshot'], { serial: 'emulator-5554' }, {
        detect: (bin) => (bin === 'adb' ? '/mock/adb' : null),
        exec: async (_bin, args) => {
          assert.ok(args.includes('screencap'));
          assert.ok(args.includes('emulator-5554'));
          return { exitCode: 0, stdout: png, stderr: '', timedOut: false };
        },
      }),
    );
    assert.equal(code, EXIT.OK);
    assert.equal(body.ok, true);
    assert.match(body.path, /screenshots\/scr_/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('android install requires an apk path', async () => {
  await assert.rejects(
    () => cmdAndroid({ home: '/tmp', json: true }, ['install'], {}),
    /Missing required argument/,
  );
});

test('unknown android subcommand is a usage error', async () => {
  await assert.rejects(
    () => cmdAndroid({ home: '/tmp', json: true }, ['reboot'], {}),
    /Unknown android subcommand/,
  );
});
