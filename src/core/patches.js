import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { newPatchId } from './ids.js';
import { applyPatchToOrigin, removeWorktree } from './worktree.js';
import { TorisError } from './errors.js';

const COLLECTION = 'patches';

function nowIso() {
  return new Date().toISOString();
}

export function patchesDir(home) {
  return join(home, 'patches');
}

function diffPath(home, id) {
  return join(patchesDir(home), `${id}.diff`);
}

export async function savePatch(store, {
  source,
  originPath,
  worktreePath,
  branch,
  baseSha,
  autonomy,
  files,
  stats,
  patch,
  runId = null,
  originTouched = false,
  now = Date.now,
}) {
  const id = newPatchId(now);
  await mkdir(patchesDir(store.home), { recursive: true });
  const file = diffPath(store.home, id);
  await writeFile(file, patch ?? '', 'utf8');
  const record = {
    id,
    status: 'pending',
    source,
    runId,
    originPath,
    worktreePath,
    branch: branch ?? null,
    baseSha,
    autonomy,
    files: files ?? [],
    stats: stats ?? '',
    diffPath: file,
    originTouched: Boolean(originTouched),
    createdAt: nowIso(),
    decidedAt: null,
    applyError: null,
  };
  await store.updateCollection(COLLECTION, (items) => [...items, record]);
  return record;
}

export async function listPatches(store, { status } = {}) {
  const items = await store.readCollection(COLLECTION);
  const filtered = status ? items.filter((item) => item.status === status) : items;
  return filtered.slice().reverse();
}

export async function getPatch(store, id) {
  if (!id) return null;
  const items = await store.readCollection(COLLECTION);
  return items.find((item) => item.id === id || item.id.startsWith(id)) ?? null;
}

export async function readPatchDiff(record) {
  try {
    return await readFile(record.diffPath, 'utf8');
  } catch {
    return '';
  }
}

async function updatePatch(store, id, patch) {
  await store.updateCollection(COLLECTION, (items) =>
    items.map((item) => (item.id === id ? patch : item)),
  );
  return patch;
}

export async function applySavedPatch(store, id, { applyFn = applyPatchToOrigin } = {}) {
  const record = await getPatch(store, id);
  if (!record) throw new TorisError(`No patch matching "${id}".`, 'E_UNKNOWN_PATCH');
  if (record.status !== 'pending') {
    throw new TorisError(`Patch ${record.id} is already ${record.status}.`, 'E_PATCH_STATE');
  }
  const diff = await readPatchDiff(record);
  const result = await applyFn(record.originPath, diff);
  if (!result.ok) {
    const failed = {
      ...record,
      status: 'failed',
      decidedAt: nowIso(),
      applyError: result.stderr || 'git apply failed',
    };
    await updatePatch(store, record.id, failed);
    throw new TorisError(
      `Could not apply ${record.id} to ${record.originPath}: ${failed.applyError}`,
      'E_PATCH_APPLY',
    );
  }
  const applied = { ...record, status: 'applied', decidedAt: nowIso(), applyError: null };
  await updatePatch(store, record.id, applied);
  await removeWorktree({
    origin: record.originPath,
    path: record.worktreePath,
    branch: record.branch,
  }).catch(() => undefined);
  return applied;
}

export async function discardSavedPatch(store, id) {
  const record = await getPatch(store, id);
  if (!record) throw new TorisError(`No patch matching "${id}".`, 'E_UNKNOWN_PATCH');
  if (record.status !== 'pending') {
    throw new TorisError(`Patch ${record.id} is already ${record.status}.`, 'E_PATCH_STATE');
  }
  await removeWorktree({
    origin: record.originPath,
    path: record.worktreePath,
    branch: record.branch,
  }).catch(() => undefined);
  await rm(record.diffPath, { force: true }).catch(() => undefined);
  const discarded = { ...record, status: 'discarded', decidedAt: nowIso() };
  await updatePatch(store, record.id, discarded);
  return discarded;
}
