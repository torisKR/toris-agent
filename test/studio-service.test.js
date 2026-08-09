import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLaunchAgent } from '../src/studio/service/launchd.js';
import { StudioServiceManager } from '../src/studio/service/manager.js';

test('LaunchAgent is a secret-free user service pinned to loopback studio arguments', () => {
  const plist = generateLaunchAgent({
    nodePath: '/opt/homebrew/bin/node',
    binPath: '/repo/bin/toris.js',
    torisHome: '/Users/me/.toris',
    workingDirectory: '/repo',
    logDirectory: '/Users/me/.toris/logs',
  });
  for (const value of ['kr.toris.agent.studio', '<key>RunAtLoad</key>', '<key>KeepAlive</key>', '<integer>63</integer>', '/opt/homebrew/bin/node', '/repo/bin/toris.js', '<string>studio</string>', '<string>--home</string>', '/Users/me/.toris']) assert.match(plist, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(plist, /token|secret|password|0\.0\.0\.0/i);
});

test('service install, status, restart, and uninstall stay in the user launch domain', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'toris-launchd-'));
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'print') return { exitCode: 0, stdout: 'state = running', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const manager = new StudioServiceManager({
    platform: 'darwin',
    uid: 501,
    userHome,
    torisHome: join(userHome, '.toris'),
    nodePath: '/opt/node',
    binPath: '/repo/bin/toris.js',
    workingDirectory: '/repo',
    runner,
  });
  try {
    const installed = await manager.install();
    assert.equal(installed.running, true);
    assert.match(await readFile(installed.plistPath, 'utf8'), /kr\.toris\.agent\.studio/);
    assert.deepEqual(calls.slice(0, 3).map((call) => call.slice(0, 3)), [
      ['launchctl', 'bootout', 'gui/501'],
      ['launchctl', 'bootstrap', 'gui/501'],
      ['launchctl', 'kickstart', '-k'],
    ]);
    assert.equal((await manager.status()).running, true);
    await manager.restart();
    const removed = await manager.uninstall();
    assert.equal(removed.installed, false);
  } finally {
    await rm(userHome, { recursive: true, force: true });
  }
});

test('service manager fails closed away from macOS', async () => {
  const manager = new StudioServiceManager({ platform: 'linux' });
  await assert.rejects(manager.install(), /macOS/);
});
