import { ApprovalDeniedError } from './errors.js';

/**
 * Autonomy ladder. Higher levels widen what may happen without a human.
 * L1 plan-only ... L5 fully autonomous including push to the default branch.
 *
 * Each rung carries:
 *   rank         numeric order, so callers compare levels without parsing "L3"
 *   <capability> booleans consumed by `gate()`
 *   autoApproves whether mutating chat tools run without an approval prompt
 *   label        short phrase for tables
 *   detail       what it costs the operator if the agent gets it wrong
 *
 * Written for one developer reviewing their own agent: the question at every
 * rung is "how much do I have to undo by hand?", not "who signs off?".
 */
export const AUTONOMY_LEVELS = Object.freeze({
  L1: Object.freeze({
    level: 'L1',
    rank: 1,
    plans: true,
    writes: false,
    commits: false,
    pushes: false,
    pushesDefaultBranch: false,
    autoApproves: false,
    label: 'plan only',
    detail:
      'Nothing on disk changes. Use it to see the plan and the cost before spending anything.',
  }),
  L2: Object.freeze({
    level: 'L2',
    rank: 2,
    plans: true,
    writes: true,
    commits: false,
    pushes: false,
    pushesDefaultBranch: false,
    autoApproves: false,
    label: 'edit working tree, ask before commit',
    detail:
      'Edits land unstaged, so `git checkout -- .` undoes the whole run. Every mutating tool still asks.',
  }),
  L3: Object.freeze({
    level: 'L3',
    rank: 3,
    plans: true,
    writes: true,
    commits: true,
    pushes: false,
    pushesDefaultBranch: false,
    autoApproves: true,
    label: 'commit locally, ask before push',
    detail:
      'The recommended solo default: commits are local, so `git reset` undoes them and nothing reaches a remote.',
  }),
  L4: Object.freeze({
    level: 'L4',
    rank: 4,
    plans: true,
    writes: true,
    commits: true,
    pushes: true,
    pushesDefaultBranch: false,
    autoApproves: true,
    label: 'push to a side branch',
    detail: 'Work can reach the remote on its own branch. Your default branch is still untouched.',
  }),
  L5: Object.freeze({
    level: 'L5',
    rank: 5,
    plans: true,
    writes: true,
    commits: true,
    pushes: true,
    pushesDefaultBranch: true,
    autoApproves: true,
    label: 'fully autonomous, including the default branch',
    detail:
      'Nothing is held back, including pushing to main. Undoing this means rewriting published history.',
  }),
});

/**
 * The level a solo developer should normally sit at. Git is the undo button for
 * one person, so pausing before every local commit is ceremony, not safety —
 * but pushing is the first irreversible step, so that is where the ladder stops.
 */
export const RECOMMENDED_AUTONOMY = 'L3';

export function resolveAutonomy(level) {
  const found = AUTONOMY_LEVELS[String(level).toUpperCase()];
  if (!found) {
    throw new ApprovalDeniedError(`Unknown autonomy level "${level}". Use one of L1..L5.`);
  }
  return found;
}

/** Action name -> capability flag. The only place the mapping is spelled out. */
const ACTION_CAPABILITY = Object.freeze({
  plan: 'plans',
  write: 'writes',
  commit: 'commits',
  push: 'pushes',
  'push-default': 'pushesDefaultBranch',
});

export const GATED_ACTIONS = Object.freeze(Object.keys(ACTION_CAPABILITY));

/**
 * Decide whether an action may proceed unattended.
 * @returns {{allowed:boolean, needsApproval:boolean, reason:string}}
 */
export function gate(autonomy, action) {
  const policy = resolveAutonomy(autonomy);
  const key = ACTION_CAPABILITY[action];
  if (!key) return { allowed: false, needsApproval: false, reason: `unknown action "${action}"` };
  if (policy[key])
    return { allowed: true, needsApproval: false, reason: `${policy.level} permits ${action}` };
  // The next level up would permit it -> a human can unblock by approving.
  return {
    allowed: false,
    needsApproval: true,
    reason: `${policy.level} (${policy.label}) does not permit ${action}`,
  };
}

/** Numeric position on the ladder, so callers never regex a level string. */
export function autonomyRank(level) {
  return resolveAutonomy(level).rank;
}

/**
 * Whether mutating chat tools run without prompting at this level.
 * Single source of truth: the run path and the chat path must agree, otherwise
 * `toris run --autonomy L3` and `toris chat --autonomy L3` mean different things.
 */
export function autoApprovesTools(level) {
  return resolveAutonomy(level).autoApproves;
}

/** The lowest level that runs mutating tools unattended. */
export const AUTO_APPROVE_FROM = Object.values(AUTONOMY_LEVELS).find((l) => l.autoApproves).rank;

/** Budget guard: refuse to start work that cannot be paid for. */
export function withinBudget(spentUsd, estimateUsd, budgetUsd) {
  if (typeof budgetUsd !== 'number' || budgetUsd <= 0) return { ok: true, remaining: Infinity };
  const remaining = budgetUsd - spentUsd;
  return { ok: estimateUsd <= remaining, remaining };
}
