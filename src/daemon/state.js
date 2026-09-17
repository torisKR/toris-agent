import { createRequire } from 'node:module';
import { open, readFile, rename, unlink, writeFile, mkdir } from 'node:fs/promises';

import { daemonPaths } from './paths.js';

const require = createRequire(import.meta.url);
export const packageVersion = () => require('../../package.json').version;

export function emptyJobCounts() {
  return { queued: 0, running: 0, succeeded: 0, failed: 0 };
}

/**
 * `kill(pid, 0)` is the portable "does this pid exist?" probe. EPERM means
 * the process is alive but we cannot signal it — still "running" for lock
 * purposes, so we do not steal its home.
 */
export function isPidAlive(pid, killer = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killer(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export async function readDaemonState(home) {
  try {
    const raw = JSON.parse(await readFile(daemonPaths(home).state, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Cannot read daemon.json: ${err.message}`);
  }
}

export async function writeDaemonState(home, state) {
  const paths = daemonPaths(home);
  await mkdir(home, { recursive: true });
  const tmp = `${paths.state}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, paths.state);
  return state;
}

export function buildStatus(home, state, now = Date.now) {
  const pid = Number.isInteger(state?.pid) ? state.pid : null;
  const running = isPidAlive(pid);
  const startedAt = running && typeof state?.startedAt === 'string' ? state.startedAt : null;
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const t = typeof now === 'function' ? now() : now;
  return {
    running,
    supported: true,
    pid: running ? pid : null,
    startedAt,
    heartbeatAt: running && typeof state?.heartbeatAt === 'string' ? state.heartbeatAt : null,
    uptimeMs: running && Number.isFinite(startedMs) ? Math.max(0, t - startedMs) : 0,
    home,
    version: typeof state?.version === 'string' ? state.version : packageVersion(),
    // First slice is pid/lock + file inbox. Supervisor RPC / daemon.sock is next.
    socket: null,
    jobs: { ...emptyJobCounts(), ...(state?.jobs && typeof state.jobs === 'object' ? state.jobs : {}) },
    recentJobs: running && Array.isArray(state?.recentJobs) ? state.recentJobs : [],
  };
}

export async function readDaemonStatus(home, now = Date.now) {
  return buildStatus(home, await readDaemonState(home), now);
}

export async function isDaemonRunning(home) {
  return (await readDaemonStatus(home)).running;
}

export async function reclaimStale(home) {
  const status = await readDaemonStatus(home);
  if (status.running) return false;
  const paths = daemonPaths(home);
  await unlink(paths.lock).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await unlink(paths.state).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  return true;
}

export async function acquireDaemonLock(home, info) {
  const paths = daemonPaths(home);
  await mkdir(home, { recursive: true });
  const existing = await readDaemonStatus(home);
  if (existing.running) {
    const error = new Error(`Daemon already running (pid ${existing.pid}).`);
    error.code = 'E_DAEMON_RUNNING';
    error.pid = existing.pid;
    throw error;
  }
  await reclaimStale(home);
  try {
    const handle = await open(paths.lock, 'wx', 0o600);
    try {
      await handle.writeFile(`${info.pid}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err.code === 'EEXIST') {
      const again = await readDaemonStatus(home);
      const error = new Error(
        again.running
          ? `Daemon already running (pid ${again.pid}).`
          : 'Daemon lock exists; another start is in progress.',
      );
      error.code = 'E_DAEMON_RUNNING';
      error.pid = again.pid;
      throw error;
    }
    throw err;
  }
  const startedAt = info.startedAt ?? new Date().toISOString();
  return writeDaemonState(home, {
    pid: info.pid,
    version: info.version ?? packageVersion(),
    startedAt,
    heartbeatAt: startedAt,
    home,
    socket: null,
    jobs: emptyJobCounts(),
    recentJobs: [],
  });
}

/** Owner-only: drop the lock even though this pid is still alive. */
export async function releaseDaemonLock(home) {
  const paths = daemonPaths(home);
  await unlink(paths.lock).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await unlink(paths.state).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

export async function touchHeartbeat(home, extras = {}) {
  const state = await readDaemonState(home);
  if (!state) return null;
  const { heartbeatAt, ...rest } = extras;
  return writeDaemonState(home, {
    ...state,
    ...rest,
    heartbeatAt: heartbeatAt ?? new Date().toISOString(),
  });
}
