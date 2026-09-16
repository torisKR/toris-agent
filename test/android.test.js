import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  androidDoctorChecks,
  inspectAndroidTools,
  parseAdbDevices,
  runAndroidAction,
} from '../src/core/android.js';
import { createDefaultTools } from '../src/core/tools.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

test('parseAdbDevices reads serial, state, and model fields', () => {
  const devices = parseAdbDevices(`List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64
deadbeef               unauthorized
`);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].serial, 'emulator-5554');
  assert.equal(devices[0].state, 'device');
  assert.equal(devices[0].model, 'sdk_gphone64_arm64');
  assert.equal(devices[1].state, 'unauthorized');
});

test('doctor checks warn when adb and emulator are absent', () => {
  const checks = androidDoctorChecks({ detect: () => null });
  assert.deepEqual(
    checks.map((check) => check.status),
    ['WARN', 'WARN'],
  );
  assert.match(checks[0].detail, /optional/);
});

test('inspectAndroidTools reports the resolved binaries', () => {
  const tools = inspectAndroidTools({
    detect: (bin) => (bin === 'adb' ? '/usr/bin/adb' : null),
  });
  assert.equal(tools.adb, '/usr/bin/adb');
  assert.equal(tools.emulator, null);
  assert.equal(tools.ready, true);
});

test('android screenshot and logcat store artifacts under the toris home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-android-'));
  try {
    const exec = async (_bin, args, options = {}) => {
      const joined = args.join(' ');
      if (joined.includes('screencap')) {
        return { exitCode: 0, stdout: PNG, stderr: '', timedOut: false };
      }
      if (joined.includes('logcat')) {
        return { exitCode: 0, stdout: 'I toris: hello from device\n', stderr: '', timedOut: false };
      }
      if (joined.includes('devices')) {
        return { exitCode: 0, stdout: 'List of devices attached\nemulator-5554 device\n', stderr: '', timedOut: false };
      }
      if (joined.includes('version')) {
        return { exitCode: 0, stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '', timedOut: false };
      }
      return { exitCode: 1, stdout: options.encoding === 'buffer' ? Buffer.alloc(0) : '', stderr: `unexpected ${joined}`, timedOut: false };
    };
    const detect = (bin) => (bin === 'adb' ? '/mock/adb' : null);

    const status = await runAndroidAction('status', { detect, exec, home });
    assert.equal(status.ok, true);
    assert.equal(status.devices[0].serial, 'emulator-5554');

    const shot = await runAndroidAction('screenshot', { detect, exec, home, serial: 'emulator-5554' });
    assert.equal(shot.ok, true);
    assert.match(shot.path, /android\/screenshots\/scr_/);
    assert.equal(shot.bytes, PNG.length);

    const log = await runAndroidAction('logcat', { detect, exec, home, lines: 50 });
    assert.equal(log.ok, true);
    assert.match(log.path, /android\/logs\/log_/);
    assert.match(log.tail, /hello from device/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('android install refuses a missing apk and shells out when present', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-apk-'));
  try {
    await assert.rejects(
      () => runAndroidAction('install', { detect: () => '/mock/adb', home, apk: join(home, 'missing.apk') }),
      /not readable/,
    );
    const apk = join(home, 'app.apk');
    await writeFile(apk, 'apk');
    const result = await runAndroidAction('install', {
      detect: () => '/mock/adb',
      home,
      apk,
      exec: async (_bin, args) => {
        assert.deepEqual(args.slice(-3), ['install', '-r', apk]);
        return { exitCode: 0, stdout: 'Success\n', stderr: '', timedOut: false };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.apk, 'app.apk');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('adb serials cannot inject extra argv', async () => {
  await assert.rejects(
    () =>
      runAndroidAction('screenshot', {
        detect: () => '/mock/adb',
        home: '/tmp',
        serial: '; rm -rf /',
        exec: async () => ({ exitCode: 0, stdout: PNG, stderr: '', timedOut: false }),
      }),
    /Invalid device serial/,
  );
});

test('the android chat tool is read-only evidence and does not throw without adb', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-android-tool-'));
  try {
    const tools = createDefaultTools({ cwd: home, home, android: { detect: () => null } });
    const android = tools.find((tool) => tool.name === 'android');
    assert.equal(android.needsApproval, undefined);
    const missing = await android.run({ action: 'devices' });
    assert.match(missing, /adb is not on PATH|not on PATH/i);
    const blocked = await android.run({ action: 'install' });
    assert.match(blocked, /CLI-only/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
