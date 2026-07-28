import { spawn } from 'node:child_process';

export function git(args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => resolvePromise({ ok: false, stdout: '', stderr: err.message, code: 127 }));
    child.on('close', (code) => resolvePromise({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
  });
}

export async function isRepo(cwd) {
  return (await git(['rev-parse', '--is-inside-work-tree'], cwd)).ok;
}

export async function repoRoot(cwd) {
  const res = await git(['rev-parse', '--show-toplevel'], cwd);
  return res.ok ? res.stdout : null;
}

export async function currentBranch(cwd) {
  const res = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return res.ok ? res.stdout : null;
}

export async function isDirty(cwd) {
  const res = await git(['status', '--porcelain'], cwd);
  return res.ok && res.stdout.length > 0;
}

/** Files changed vs HEAD — the evidence that a run actually did something. */
export async function changedFiles(cwd) {
  const res = await git(['status', '--porcelain'], cwd);
  if (!res.ok) return [];
  return res.stdout.split('\n').filter(Boolean).map((line) => line.slice(3).trim());
}
