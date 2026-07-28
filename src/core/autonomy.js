import { ApprovalDeniedError } from './errors.js';

/**
 * Autonomy ladder. Higher levels widen what may happen without a human.
 * L1 plan-only ... L5 fully autonomous including push.
 */
export const AUTONOMY_LEVELS = Object.freeze({
  L1: { level: 'L1', plans: true, writes: false, commits: false, pushes: false, label: 'plan only' },
  L2: { level: 'L2', plans: true, writes: true, commits: false, pushes: false, label: 'edit working tree, ask before commit' },
  L3: { level: 'L3', plans: true, writes: true, commits: true, pushes: false, label: 'commit locally, ask before push' },
  L4: { level: 'L4', plans: true, writes: true, commits: true, pushes: true, label: 'push to a branch' },
  L5: { level: 'L5', plans: true, writes: true, commits: true, pushes: true, label: 'fully autonomous' },
});

export function resolveAutonomy(level) {
  const found = AUTONOMY_LEVELS[String(level).toUpperCase()];
  if (!found) {
    throw new ApprovalDeniedError(`Unknown autonomy level "${level}". Use one of L1..L5.`);
  }
  return found;
}

/**
 * Decide whether an action may proceed unattended.
 * @returns {{allowed:boolean, needsApproval:boolean, reason:string}}
 */
export function gate(autonomy, action) {
  const policy = resolveAutonomy(autonomy);
  const map = { plan: 'plans', write: 'writes', commit: 'commits', push: 'pushes' };
  const key = map[action];
  if (!key) return { allowed: false, needsApproval: false, reason: `unknown action "${action}"` };
  if (policy[key]) return { allowed: true, needsApproval: false, reason: `${policy.level} permits ${action}` };
  // The next level up would permit it -> a human can unblock by approving.
  return { allowed: false, needsApproval: true, reason: `${policy.level} (${policy.label}) does not permit ${action}` };
}

/** Budget guard: refuse to start work that cannot be paid for. */
export function withinBudget(spentUsd, estimateUsd, budgetUsd) {
  if (typeof budgetUsd !== 'number' || budgetUsd <= 0) return { ok: true, remaining: Infinity };
  const remaining = budgetUsd - spentUsd;
  return { ok: estimateUsd <= remaining, remaining };
}
