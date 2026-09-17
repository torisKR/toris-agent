import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TorisError } from '../core/errors.js';
import { daemonPaths } from './paths.js';
import { isPidAlive, readDaemonStatus, reclaimStale } from './state.js';
import { runDaemonWorker } from './worker.js';

const DEFAULT_BIN = fileURLToPath(new URL('../../bin/toris.js', import.meta.url));

export async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 40, timer = setTimeout } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start >= timeoutMs) return predicate();
    await new Promise((resolve) => timer(resolve, intervalMs));
  }
}

async function spawnStdio(logPath) {
  await mkdir(dirname(logPath), { recursive: true });
  const handle = await open(logPath, 'a');
  return { stdio: ['ignore', handle.fd, handle.fd], handle };
}

/**
 * Start a detached worker that owns `home`, or run that worker in this process
 * when `foreground` is set (used by the spawned child and by `start --foreground`).
 */
export async function startDaemon(home, options = {}) {
  const current = await readDaemonStatus(home);
  if (current.running) {
    throw new TorisError(`Daemon already running (pid ${current.pid}).`, 'E_DAEMON_RUNNING');
  }
  await reclaimStale(home);

  if (options.foreground) {
    return runDaemonWorker({ home, ...options });
  }

  const paths = daemonPaths(home);
  const nodePath = options.nodePath || process.execPath;
  const binPath = options.binPath || DEFAULT_BIN;
  const args = options.args || [binPath, 'daemon', 'start', '--foreground', '--home', home];
  const spawnFn = options.spawn || spawn;

  let handle = null;
  let stdio = options.stdio;
  if (!stdio && !options.spawn) {
    ({ stdio, handle } = await spawnStdio(paths.log));
  }

  let child;
  try {
    child = spawnFn(nodePath, args, {
      detached: true,
      windowsHide: true,
      stdio: stdio || 'ignore',
      env: { ...process.env, ...(options.env || {}), TORIS_HOME: home },
    });
  } finally {
    await handle?.close?.().catch(() => undefined);
  }

  const ready = await waitUntil(async () => (await readDaemonStatus(home)).running, {
    timeoutMs: options.readyTimeoutMs ?? 8000,
    intervalMs: options.pollMs ?? 40,
    timer: options.setTimeout,
  });
  if (!ready) {
    const pid = child?.pid;
    if (pid && isPidAlive(pid, options.kill)) {
      try {
        (options.kill || process.kill)(pid, 'SIGTERM');
      } catch {
        /* child already gone */
      }
    }
    throw new TorisError(
      `Daemon did not become ready. Check ${paths.log}.`,
      'E_DAEMON_START',
    );
  }
  child?.unref?.();
  return readDaemonStatus(home);
}

export async function stopDaemon(home, options = {}) {
  const status = await readDaemonStatus(home);
  if (!status.running) {
    await reclaimStale(home);
    return { ...status, running: false, stopped: false, reason: 'daemon is not running' };
  }
  const killer = options.kill || process.kill;
  try {
    killer(status.pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
  const stopped = await waitUntil(async () => !(await readDaemonStatus(home)).running, {
    timeoutMs: options.stopTimeoutMs ?? 5000,
    intervalMs: options.pollMs ?? 40,
    timer: options.setTimeout,
  });
  if (!stopped && isPidAlive(status.pid)) {
    try {
      killer(status.pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
    await waitUntil(() => !isPidAlive(status.pid), {
      timeoutMs: 2000,
      intervalMs: 40,
      timer: options.setTimeout,
    });
  }
  const final = await readDaemonStatus(home);
  if (final.running) {
    throw new TorisError(`Daemon pid ${status.pid} did not exit.`, 'E_DAEMON_STOP');
  }
  await reclaimStale(home);
  return {
    ...final,
    running: false,
    supported: true,
    stopped: true,
    pid: status.pid,
    home,
    version: status.version,
  };
}
