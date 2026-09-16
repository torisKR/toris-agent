import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../src/core/git.js';
import {
  applyPatchToOrigin,
  createWorktree,
  originSnapshot,
  originTouched,
  removeWorktree,
  worktreeDiff,
} from '../src/core/worktree.js';
import { Store } from '../src/core/store.js';
import { savePatch, applySavedPatch, listPatches, refreshSavedPatchDiff, readPatchDiff } from '../src/core/patches.js';

async function gitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'toris-wt-'));
  await git(['init'], root);
  await git(['config', 'user.email', 'toris@example.test'], root);
  await git(['config', 'user.name', 'toris'], root);
  await writeFile(join(root, 'README.md'), 'hello\n');
  await git(['add', '.'], root);
  await git(['commit', '-m', 'init'], root);
  return root;
}

test('a coding CLI worktree can change files without dirtying origin', async () => {
  const origin = await gitRepo();
  const home = await mkdtemp(join(tmpdir(), 'toris-home-'));
  try {
    const before = await originSnapshot(origin);
    const session = await createWorktree({ origin, home, id: 'iso1' });
    await writeFile(join(session.path, 'NEW.md'), 'from isolation\n');
    const diff = await worktreeDiff(session);
    assert.equal(await originTouched(origin, before.porcelain), false);
    assert.ok(diff.files.includes('NEW.md'));
    assert.equal(await readFile(join(origin, 'NEW.md'), 'utf8').catch(() => ''), '');
    const applied = await applyPatchToOrigin(origin, diff.patch);
    assert.equal(applied.ok, true);
    assert.equal(await readFile(join(origin, 'NEW.md'), 'utf8'), 'from isolation\n');
    await removeWorktree(session);
  } finally {
    await rm(origin, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a saved L2 patch applies later through the patch store', async () => {
  const origin = await gitRepo();
  const home = await mkdtemp(join(tmpdir(), 'toris-home-'));
  try {
    const store = await new Store(home).init();
    const session = await createWorktree({ origin, home, id: 'iso2' });
    await writeFile(join(session.path, 'later.md'), 'pending\n');
    const diff = await worktreeDiff(session);
    const record = await savePatch(store, {
      source: 'run',
      originPath: origin,
      worktreePath: session.path,
      branch: session.branch,
      baseSha: session.baseSha,
      autonomy: 'L2',
      files: diff.files,
      stats: diff.stats,
      patch: diff.patch,
    });
    assert.equal((await listPatches(store, { status: 'pending' })).length, 1);
    await applySavedPatch(store, record.id);
    assert.equal(await readFile(join(origin, 'later.md'), 'utf8'), 'pending\n');
  } finally {
    await rm(origin, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('refreshSavedPatchDiff replaces the stored unified diff from the worktree', async () => {
  const origin = await gitRepo();
  const home = await mkdtemp(join(tmpdir(), 'toris-home-'));
  try {
    const store = await new Store(home).init();
    const session = await createWorktree({ origin, home, id: 'iso3' });
    await writeFile(join(session.path, 'first.md'), 'one\n');
    const initial = await worktreeDiff(session);
    const record = await savePatch(store, {
      source: 'run',
      originPath: origin,
      worktreePath: session.path,
      branch: session.branch,
      baseSha: session.baseSha,
      autonomy: 'L2',
      files: initial.files,
      stats: initial.stats,
      patch: initial.patch,
    });
    await writeFile(join(session.path, 'second.md'), 'two\n');
    const refreshed = await refreshSavedPatchDiff(store, record.id);
    assert.ok(refreshed.files.includes('first.md'));
    assert.ok(refreshed.files.includes('second.md'));
    const stored = await readPatchDiff(refreshed);
    assert.match(stored, /\+two/);
    await applySavedPatch(store, record.id);
    assert.equal(await readFile(join(origin, 'second.md'), 'utf8'), 'two\n');
  } finally {
    await rm(origin, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
