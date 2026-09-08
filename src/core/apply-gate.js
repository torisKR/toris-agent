import { gate } from './autonomy.js';

/**
 * How isolated CLI edits reach the operator's repository.
 *
 * never — L1: do not execute writers; no apply.
 * ask   — L2: writers may run in a worktree; applying still needs a human.
 * auto  — L3+: apply the worktree diff to the original checkout.
 *
 * @param {string} autonomy
 * @returns {'never'|'ask'|'auto'}
 */
export function applyDecision(autonomy) {
  if (gate(autonomy, 'apply').allowed) return 'auto';
  if (gate(autonomy, 'write').allowed) return 'ask';
  return 'never';
}

export function formatApplySummary(patch) {
  const files = patch?.files ?? [];
  const stats = patch?.stats ? `\n${patch.stats}` : '';
  if (files.length === 0) return 'no file changes';
  return `${files.length} file${files.length === 1 ? '' : 's'}${stats}`;
}
