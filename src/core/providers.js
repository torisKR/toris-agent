import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { ProviderError } from './errors.js';

/**
 * Adapter over a coding-agent CLI. Both supported providers accept a prompt
 * and stream a result, so one shape covers them.
 * @typedef {{name:string,bin:string,args:(prompt:string)=>string[],parse:(stdout:string)=>{text:string,costUsd:number}}} Adapter
 */

const parseClaude = (stdout) => {
  const trimmed = stdout.trim();
  try {
    const json = JSON.parse(trimmed);
    return {
      text: json.result ?? json.text ?? trimmed,
      costUsd: Number(json.total_cost_usd ?? json.cost_usd ?? 0) || 0,
    };
  } catch {
    return { text: trimmed, costUsd: 0 };
  }
};

/** @type {Record<string, Adapter>} */
export const ADAPTERS = Object.freeze({
  claude: Object.freeze({
    name: 'claude',
    bin: process.env.TORIS_CLAUDE_BIN || 'claude',
    args: (prompt) => ['-p', prompt, '--output-format', 'json'],
    parse: parseClaude,
  }),
  codex: Object.freeze({
    name: 'codex',
    bin: process.env.TORIS_CODEX_BIN || 'codex',
    args: (prompt) => ['exec', prompt],
    parse: (stdout) => ({ text: stdout.trim(), costUsd: 0 }),
  }),
});

/** The opposite provider, used for cross-provider review (reviewer != implementer). */
export function oppositeProvider(name) {
  return name === 'claude' ? 'codex' : 'claude';
}

/** Resolve a binary on PATH without executing it. */
export function detectBinary(bin, { env = process.env, platform = process.platform } = {}) {
  const pathValue = env.PATH || '';
  if (!pathValue) return null;
  const isWin = platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathValue.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = `${dir}${isWin ? '\\' : '/'}${bin}${ext}`;
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/**
 * Invoke a provider CLI. Rejects on non-zero exit or timeout; never throws
 * synchronously so callers can always rely on the promise.
 */
export function invokeProvider(adapter, prompt, { cwd, timeoutMs = 900000, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(adapter.bin, adapter.args(prompt), {
        cwd,
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new ProviderError(`Cannot start "${adapter.bin}": ${err.message}`, adapter.name));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new ProviderError(`${adapter.name} timed out after ${timeoutMs}ms`, adapter.name));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = err.code === 'ENOENT'
        ? `"${adapter.bin}" not found on PATH. Install it or set TORIS_${adapter.name.toUpperCase()}_BIN.`
        : err.message;
      reject(new ProviderError(hint, adapter.name));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ProviderError(
          `${adapter.name} exited with code ${code}: ${stderr.trim().slice(0, 500) || '(no stderr)'}`,
          adapter.name,
        ));
        return;
      }
      resolvePromise({ ...adapter.parse(stdout), raw: stdout, provider: adapter.name });
    });
  });
}
