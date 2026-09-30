import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/core/store.js';
import { openIsolation, settleIsolation } from '../src/core/isolation.js';
import { removeWorktree } from '../src/core/worktree.js';

test('a failed QA hold prevails over forceApply and keeps the origin unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'toris-held-isolation-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');git('config', 'user.email', 'test@example.invalid');git('config', 'user.name', 'Test');
  await writeFile(join(root, 'file.txt'), 'before\n');git('add', '.');git('commit', '-qm', 'initial');
  const home = await mkdtemp(join(tmpdir(), 'toris-held-home-'));
  const store = new Store(home);await store.init();
  const isolation = await openIsolation({ origin: root, home: store.home, id: 'qa-hold' });
  t.after(async () => { await removeWorktree(isolation.session); await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  await writeFile(join(isolation.session.path, 'file.txt'), 'failed change\n');
  const result = await settleIsolation({ store, session: isolation.session, before: isolation.before, source: 'run', autonomy: 'L3', forceApply: true, holdApply: true });
  assert.equal(result.applied, false);
  assert.equal(result.leaked, false);
  assert.equal(result.patch.status, 'pending');
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'before\n');
});
