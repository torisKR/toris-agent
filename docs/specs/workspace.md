## `@toris/workspace` — git, worktrees, path ownership

```ts
export interface GitInfo { root: string; branch: string; head: string; isDirty: boolean; dirtyFiles: string[] }
export function isGitRepo(dir: string): Promise<boolean>;
export function gitInfo(dir: string): Promise<GitInfo>;

export interface Worktree { path: string; branch: string; baseCommit: string; taskId: string }
export interface WorktreeManager {
  create(opts: { repo: string; taskId: string; runId: string; baseCommit: string }): Promise<Worktree>;
  commitAll(wt: Worktree, message: string): Promise<string | null>;  // sha or null if nothing to commit
  changedFiles(wt: Worktree): Promise<string[]>;
  diff(wt: Worktree): Promise<string>;
  remove(wt: Worktree): Promise<void>;
  list(repo: string): Promise<Worktree[]>;
}
export function worktreeManager(): WorktreeManager;

// path ownership / overlap detection (the parallel-safety core)
export function normalizeGlobs(globs: string[]): string[];
export function pathsOverlap(a: string[], b: string[]): boolean;
export function detectConflicts(tasks: Array<{ id: string; ownedPaths: string[]; dependsOn: string[] }>): Array<{ a: string; b: string; paths: string[] }>;
export function isProtected(file: string, protectedPaths: string[]): boolean;
```
