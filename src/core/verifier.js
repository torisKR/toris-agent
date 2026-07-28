import { spawn } from 'node:child_process';

/** Run one shell check and capture evidence. Never throws — a failure is data. */
export function runCheck(command, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (exitCode, note) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({
        command,
        exitCode,
        passed: exitCode === 0,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
        ...(note ? { note } : {}),
      });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (err) => finish(127, err.message));
    child.on('close', (code) => finish(code ?? 1));
  });
}

/**
 * Run every configured check in order. Stops at the first failure so a broken
 * build does not burn the rest of the budget.
 */
export async function verify(commands, { cwd, timeoutMs } = {}) {
  const checks = [];
  for (const command of commands) {
    const result = await runCheck(command, { cwd, timeoutMs });
    checks.push(result);
    if (!result.passed) break;
  }
  // No checks is vacuously passing; callers distinguish "nothing to prove"
  // from "proved" by inspecting checks.length.
  return { checks, passed: checks.every((c) => c.passed) };
}

/** Infer sensible checks from a project's manifest. */
export function inferChecks(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') return [];
  const scripts = packageJson.scripts ?? {};
  const ordered = ['typecheck', 'lint', 'test', 'build'];
  return ordered
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => `npm run ${name}`);
}
