import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareVersions,
  detectInstall,
  fetchLatestVersion,
  planUpdate,
  PACKAGE_NAME,
} from '../src/core/update.js';

const scratch = () => mkdtemp(join(tmpdir(), 'toris-update-'));

test('compareVersions orders by numeric component, not string', () => {
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});

test('a release beats a prerelease at the same numbers', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
});

test('missing components are treated as zero', () => {
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(compareVersions('1.1', '1.0.9'), 1);
});

test('a git checkout is detected as source and never upgraded via npm', async () => {
  const root = await scratch();
  await mkdir(join(root, '.git'));

  const install = detectInstall({ root });

  assert.equal(install.kind, 'source');
  assert.deepEqual(install.command, ['git', 'pull']);
});

test('an npm global install is upgraded with npm install -g', async () => {
  const prefix = await scratch();
  const root = join(prefix, 'lib', 'node_modules', PACKAGE_NAME);
  const execPath = join(prefix, 'bin', 'node');

  const install = detectInstall({ root, execPath });

  assert.equal(install.kind, 'global');
  assert.deepEqual(install.command, ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`]);
});

test('a pnpm install is upgraded with pnpm, not npm', async () => {
  const prefix = await scratch();
  const root = join(prefix, 'node_modules', '.pnpm', `${PACKAGE_NAME}@0.1.0`, 'node_modules');

  const install = detectInstall({ root, execPath: join(prefix, 'bin', 'node') });

  assert.equal(install.manager, 'pnpm');
  assert.deepEqual(install.command, ['pnpm', 'add', '-g', `${PACKAGE_NAME}@latest`]);
});

test('a project dependency is reported as local, without the -g flag', async () => {
  const prefix = await scratch();
  const root = join(prefix, 'my-app', 'node_modules', PACKAGE_NAME);

  const install = detectInstall({ root, execPath: join(prefix, 'bin', 'node') });

  assert.equal(install.kind, 'local');
  assert.ok(!install.command.includes('-g'), 'a local dependency must not be upgraded globally');
});

test('a path with no node_modules at all is unknown rather than guessed', async () => {
  const root = await scratch();

  const install = detectInstall({ root, execPath: '/usr/bin/node' });

  assert.equal(install.kind, 'unknown');
  assert.equal(install.command, null);
});

test('fetchLatestVersion returns the version the registry reports', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, json: async () => ({ version: '9.9.9' }) };
  };

  const latest = await fetchLatestVersion({ fetchImpl, registry: 'https://example.test/' });

  assert.equal(latest, '9.9.9');
  assert.equal(seen[0], `https://example.test/${PACKAGE_NAME}/latest`);
});

test('an unreachable registry fails with a readable message', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };

  await assert.rejects(() => fetchLatestVersion({ fetchImpl }), /Could not reach the npm registry/);
});

test('a non-200 registry response is an error, not a silent no-op', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });

  await assert.rejects(() => fetchLatestVersion({ fetchImpl }), /HTTP 503/);
});

test('a response without a version is rejected', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({}) });

  await assert.rejects(() => fetchLatestVersion({ fetchImpl }), /no version/);
});

test('planUpdate does nothing when already current', () => {
  const plan = planUpdate({
    current: '1.0.0',
    latest: '1.0.0',
    install: { kind: 'global', command: ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`] },
  });

  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /already the latest/);
});

test('planUpdate does nothing when ahead of the registry', () => {
  const plan = planUpdate({
    current: '2.0.0',
    latest: '1.0.0',
    install: { kind: 'global', command: ['npm', 'install', '-g'] },
  });

  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /ahead of the registry/);
});

test('planUpdate runs the install command for a global install', () => {
  const command = ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`];

  const plan = planUpdate({
    current: '0.1.0',
    latest: '0.2.0',
    install: { kind: 'global', command },
  });

  assert.equal(plan.action, 'run');
  assert.deepEqual(plan.command, command);
});

test('planUpdate refuses to auto-run over a git checkout', () => {
  const plan = planUpdate({
    current: '0.1.0',
    latest: '0.2.0',
    install: { kind: 'source', command: ['git', 'pull'] },
  });

  assert.equal(plan.action, 'manual');
  assert.deepEqual(plan.command, ['git', 'pull']);
});

test('planUpdate refuses to auto-run over a project dependency', () => {
  const plan = planUpdate({
    current: '0.1.0',
    latest: '0.2.0',
    install: { kind: 'local', command: ['npm', 'install', `${PACKAGE_NAME}@latest`] },
  });

  assert.equal(plan.action, 'manual');
  assert.ok(!plan.command.includes('-g'));
});

test('an unknown install still tells the user what to type', () => {
  const plan = planUpdate({
    current: '0.1.0',
    latest: '0.2.0',
    install: { kind: 'unknown', command: null },
  });

  assert.equal(plan.action, 'manual');
  assert.deepEqual(plan.command, ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`]);
});
