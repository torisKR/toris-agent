/**
 * Loader for the native process-control binding, with a pure-JS fallback.
 *
 * The fallback is not a degraded stub: it fixes the same orphan bug the native
 * module fixes. `child_process.exec(cmd, { timeout })` signals only the direct
 * child, which for a compound command is the shell — the real work becomes a
 * grandchild, survives, and is reparented to init. Both paths here put the child
 * in its own process group and signal the whole group on timeout.
 *
 * The native module is still worth having: `detached` + `process.kill(-pid)` is
 * correct on POSIX, but Windows has no process groups in that sense and
 * `taskkill /T` races against fast-forking children. The Rust path uses the
 * platform primitive directly.
 *
 * Set TORIS_DISABLE_NATIVE=1 to force the fallback (the test suite exercises
 * both paths this way).
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Grace period between SIGTERM and SIGKILL in the fallback path. */
const TERM_GRACE_MS = 200;

/**
 * Platform triple used for both the prebuilt package name and the local file.
 * Mirrors the napi-rs convention so prebuilds are interchangeable.
 * @returns {string}
 */
export function platformTriple() {
  const { platform, arch } = process;
  if (platform === 'linux') {
    // musl and glibc builds are not interchangeable.
    let isGlibc = false;
    try {
      isGlibc = Boolean(process.report?.getReport()?.header?.glibcVersionRuntime);
    } catch {
      isGlibc = false;
    }
    return isGlibc ? `linux-${arch}-gnu` : `linux-${arch}-musl`;
  }
  if (platform === 'win32') return `win32-${arch}-msvc`;
  return `${platform}-${arch}`;
}

/**
 * Try the prebuilt package first, then a locally built binary.
 * @returns {{ spawnCaptured: Function, nativeInfo: Function } | null}
 */
function loadBinding() {
  if (process.env.TORIS_DISABLE_NATIVE === '1') return null;
  const triple = platformTriple();
  const candidates = [
    `@toris-agent/native-${triple}`,
    join(HERE, '..', '..', 'build', `toris-native.${triple}.node`),
  ];
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (typeof mod?.spawnCaptured === 'function') return mod;
    } catch {
      // A missing prebuild is expected and non-fatal — that is the whole point
      // of the fallback. Keep trying the next candidate.
    }
  }
  return null;
}

const binding = loadBinding();

/** @returns {boolean} whether the Rust binding is in use. */
export function isNativeActive() {
  return binding !== null;
}

/** @returns {string} human-readable backend description, for `toris doctor`. */
export function backendInfo() {
  if (!binding) return `javascript fallback (${platformTriple()})`;
  try {
    return binding.nativeInfo();
  } catch {
    return `native (${platformTriple()})`;
  }
}

/**
 * Keep the tail of a stream, capped at `cap` bytes.
 *
 * The tail is what matters: the end of a build log carries the error. Chunks are
 * held in a list and trimmed from the front so a runaway process cannot exhaust
 * memory.
 */
class TailBuffer {
  /** @param {number} cap */
  constructor(cap) {
    this.cap = cap;
    /** @type {Buffer[]} */
    this.chunks = [];
    this.size = 0;
    this.truncated = false;
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const front = this.chunks[0];
      const excess = this.size - this.cap;
      this.truncated = true;
      if (front.length <= excess) {
        this.chunks.shift();
        this.size -= front.length;
      } else {
        this.chunks[0] = front.subarray(excess);
        this.size -= excess;
      }
    }
  }

  /** @returns {string} */
  toString() {
    return Buffer.concat(this.chunks, this.size).toString('utf8');
  }
}

/**
 * Signal an entire process group.
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups; taskkill walks the tree instead.
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
      stdio: 'ignore',
      shell: false,
    });
    killer.on('error', () => {});
    return;
  }
  try {
    // A negative pid targets the group. `detached: true` made the child its leader.
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH — the group is already gone.
  }
  try {
    child.kill(signal);
  } catch {
    // Already reaped.
  }
}

/**
 * Pure-JS implementation of `spawnCaptured`.
 * @param {string} command
 * @param {{ cwd?: string, timeoutMs?: number, maxOutputBytes?: number }} [options]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, truncated: boolean }>}
 */
function spawnCapturedJs(command, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const isWindows = process.platform === 'win32';
  const bin = isWindows ? 'cmd.exe' : '/bin/sh';
  const flag = isWindows ? '/C' : '-c';

  return new Promise((resolvePromise) => {
    const child = spawn(bin, [flag, command], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // On POSIX this calls setsid(), making the child a process-group leader so
      // a negative-pid kill reaches every descendant.
      detached: !isWindows,
    });

    const out = new TailBuffer(cap);
    const err = new TailBuffer(cap);
    let timedOut = false;
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer;

    child.stdout?.on('data', (c) => out.push(c));
    child.stderr?.on('data', (c) => err.push(c));

    const deadline = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so well-behaved children can flush, SIGKILL shortly after.
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), TERM_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    deadline.unref?.();

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        exitCode: code ?? -1,
        stdout: out.toString(),
        stderr: err.toString(),
        timedOut,
        truncated: out.truncated || err.truncated,
      });
    };

    // 'close' (not 'exit') so the pipes are fully drained first.
    child.on('close', (code) => finish(code));
    child.on('error', (e) => {
      err.push(Buffer.from(String(e?.message ?? e)));
      finish(-1);
    });
  });
}

/**
 * Run `command` through the platform shell in its own process group.
 *
 * On timeout the entire group is signalled, so no grandchild survives.
 *
 * @param {string} command
 * @param {{ cwd?: string, timeoutMs?: number, maxOutputBytes?: number }} [options]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, truncated: boolean }>}
 */
export function spawnCaptured(command, options = {}) {
  if (binding) {
    return binding.spawnCaptured(command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
  }
  return spawnCapturedJs(command, options);
}

export { spawnCapturedJs };
