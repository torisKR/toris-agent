import { loadConfig } from '../core/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { Store } from '../core/store.js';
import { resolveAutonomy } from '../core/autonomy.js';
import { acquireDaemonLock, releaseDaemonLock, touchHeartbeat, packageVersion } from './state.js';
import { DaemonQueue, DAEMON_JOB_TYPES } from './queue.js';
import { summarizeSchedules, tickSchedules } from './schedule.js';

function sleep(ms, timer = setTimeout) {
  return new Promise((resolve) => {
    timer(resolve, ms);
  });
}

export async function executeRunJob(home, job, options = {}) {
  if (typeof options.runJob === 'function') return options.runJob(job);
  const { config } = await loadConfig(home);
  const store = options.store || new Store(home);
  await store.init();
  const cwd = job.cwd || job.project?.path || process.cwd();
  const orchestrator =
    options.createOrchestrator?.({ store, config, cwd }) ??
    new Orchestrator({ store, config, cwd });
  const run = await orchestrator.run({
    goal: job.goal,
    project: job.project ?? null,
    autonomy: resolveAutonomy(job.autonomy ?? config.defaultAutonomy).level,
    dryRun: Boolean(job.dryRun),
    budgetUsd: job.budgetUsd ?? undefined,
    provider: job.provider ?? undefined,
    apply: Boolean(job.apply),
    review: job.review !== false,
    checks: job.project?.checks ?? [],
  });
  return { runId: run.id, status: run.status, goal: run.goal };
}

/**
 * Long-lived loop that owns `~/.toris`. Heartbeat keeps `daemon.json` fresh so
 * `toris daemon status` can report uptime without talking to a socket.
 */
export async function runDaemonWorker(options) {
  const home = options.home;
  const pid = options.pid ?? process.pid;
  const signals = options.signals || process;
  const intervalMs = options.intervalMs ?? 250;
  const heartbeatMs = options.heartbeatMs ?? 2000;
  const drainMs = options.drainMs ?? 2000;
  const timer = options.setTimeout || setTimeout;
  const startedAt = options.startedAt ?? new Date().toISOString();

  await acquireDaemonLock(home, { pid, startedAt, version: options.version ?? packageVersion() });

  const queue =
    options.queue ||
    new DaemonQueue(home, {
      runners: options.runners || {
        [DAEMON_JOB_TYPES.RUN]: (job) => executeRunJob(home, job, options),
      },
    });
  if (!queue.initialized) await queue.init();

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  signals.on?.('SIGTERM', stop);
  signals.on?.('SIGINT', stop);
  options.onReady?.({ stop, pid, queue });

  let lastBeat = 0;
  let active = null;
  try {
    while (!stopping) {
      await queue.drainInbox();
      const now = Date.now();
      if (now - lastBeat >= heartbeatMs) {
        await tickSchedules(home, queue, { clock: () => new Date(now) });
        await queue.drainInbox();
        await touchHeartbeat(home, {
          jobs: queue.counts(),
          recentJobs: queue.recent(),
          schedules: await summarizeSchedules(home, now),
        });
        lastBeat = now;
      }
      if (!active) {
        active = queue.kick();
        active?.finally(() => {
          active = null;
        }).catch(() => undefined);
      }
      if (stopping) break;
      await sleep(intervalMs, timer);
    }
    const deadline = Date.now() + drainMs;
    while (queue.busy && Date.now() < deadline) {
      await sleep(Math.min(50, intervalMs), timer);
    }
  } finally {
    signals.off?.('SIGTERM', stop);
    signals.off?.('SIGINT', stop);
    await releaseDaemonLock(home);
  }
}
