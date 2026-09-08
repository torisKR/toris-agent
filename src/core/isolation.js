import { applyDecision, formatApplySummary } from './apply-gate.js';
import { applySavedPatch, savePatch } from './patches.js';
import {
  createWorktree,
  originSnapshot,
  originTouched,
  removeWorktree,
  worktreeDiff,
} from './worktree.js';

/**
 * Open an isolated worktree for a coding CLI, then fold the result through
 * the apply gate. Callers never point claude/codex at the original checkout.
 */
export async function openIsolation({ origin, home, id }) {
  const before = await originSnapshot(origin);
  const session = await createWorktree({ origin: before.root, home, id });
  return { session, before };
}

/** Drop a live worktree without saving or applying a patch. */
export async function abandonIsolation(session) {
  if (!session) return;
  await removeWorktree(session).catch(() => undefined);
}

export async function settleIsolation({
  store,
  session,
  before,
  source,
  autonomy,
  runId = null,
  forceApply = false,
  holdApply = false,
}) {
  const leaked = await originTouched(session.origin, before.porcelain);
  const diff = await worktreeDiff(session);
  if (diff.empty) {
    await removeWorktree(session).catch(() => undefined);
    return { empty: true, leaked, patch: null, applied: false, decision: applyDecision(autonomy) };
  }

  const record = await savePatch(store, {
    source,
    originPath: session.origin,
    worktreePath: session.path,
    branch: session.branch,
    baseSha: session.baseSha,
    autonomy,
    files: diff.files,
    stats: diff.stats,
    patch: diff.patch,
    runId,
    originTouched: leaked,
  });

  const decision = forceApply ? 'auto' : holdApply ? 'ask' : applyDecision(autonomy);
  if (decision === 'auto' && !leaked) {
    const applied = await applySavedPatch(store, record.id);
    return {
      empty: false,
      leaked,
      patch: applied,
      applied: true,
      decision,
      summary: formatApplySummary(diff),
    };
  }

  return {
    empty: false,
    leaked,
    patch: record,
    applied: false,
    decision,
    summary: formatApplySummary(diff),
  };
}
