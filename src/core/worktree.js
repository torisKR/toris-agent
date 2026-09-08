import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { git, isRepo, repoRoot } from './git.js';
import { TorisError } from './errors.js';

/**
 * Isolated git worktrees so a coding CLI can mutate files without touching
 * the operator's checkout. Applying the resulting diff is a separate gate.
 */

async function requireRepo(cwd) {
  if (!(await isRepo(cwd))) {
    throw new TorisError(
      `No git repository at ${cwd}, so toris cannot isolate the coding CLI. Init git or use an API chat profile.`,
      'E_NO_REPO',
    );
  }
  const root = await repoRoot(cwd);
  if (!root) {
    throw new TorisError(`Could not resolve the git root for ${cwd}.`, 'E_NO_REPO');
  }
  return root;
}

export async function originSnapshot(cwd) {
  const root = await requireRepo(cwd);
  const status = await git(['status', '--porcelain'], root);
  return { root, porcelain: status.ok ? status.stdout : '' };
}

export async function createWorktree({ origin, home, id }) {
  const root = await requireRepo(origin);
  const head = await git(['rev-parse', 'HEAD'], root);
  if (!head.ok) {
    throw new TorisError(`Cannot read HEAD in ${root}: ${head.stderr}`, 'E_GIT');
  }
  const path = join(home, 'worktrees', id);
  await mkdir(join(home, 'worktrees'), { recursive: true });
  const branch = `toris/${id}`;
  const added = await git(['worktree', 'add', '-b', branch, path, 'HEAD'], root);
  if (!added.ok) {
    throw new TorisError(`Cannot create isolated worktree: ${added.stderr}`, 'E_GIT');
  }
  return {
    id,
    origin: root,
    path,
    branch,
    baseSha: head.stdout,
  };
}

/**
 * Stage everything in the worktree (origin is untouched) and diff against the
 * SHA we branched from, including new files.
 */
export async function worktreeDiff(session) {
  const staged = await git(['add', '-A'], session.path);
  if (!staged.ok) {
    throw new TorisError(`Cannot stage isolated changes: ${staged.stderr}`, 'E_GIT');
  }
  const [stat, names, diff] = await Promise.all([
    git(['diff', '--cached', '--stat', session.baseSha], session.path),
    git(['diff', '--cached', '--name-only', session.baseSha], session.path),
    git(['diff', '--cached', '--binary', session.baseSha], session.path, { trim: false }),
  ]);
  const files = names.ok ? names.stdout.split('\n').filter(Boolean) : [];
  const patch = diff.ok ? diff.stdout : '';
  return {
    files,
    stats: stat.ok ? stat.stdout : '',
    patch,
    empty: files.length === 0 || !patch.trim(),
  };
}

export async function originTouched(origin, beforePorcelain) {
  const status = await git(['status', '--porcelain'], origin);
  const porcelain = status.ok ? status.stdout : '';
  return porcelain !== beforePorcelain;
}

export async function applyPatchToOrigin(origin, patch) {
  if (!patch || !patch.trim()) {
    return { ok: true, empty: true, stderr: '' };
  }
  const check = await git(['apply', '--check', '--whitespace=nowarn'], origin, { stdin: patch });
  if (!check.ok) {
    const threeWay = await git(['apply', '--3way', '--whitespace=nowarn'], origin, { stdin: patch });
    return { ok: threeWay.ok, empty: false, stderr: threeWay.stderr };
  }
  const applied = await git(['apply', '--whitespace=nowarn'], origin, { stdin: patch });
  return { ok: applied.ok, empty: false, stderr: applied.stderr };
}

export async function removeWorktree(session) {
  if (!session?.origin || !session?.path) return;
  await git(['worktree', 'remove', '--force', session.path], session.origin);
  if (session.branch) await git(['branch', '-D', session.branch], session.origin);
}
