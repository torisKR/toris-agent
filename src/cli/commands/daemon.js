import { EXIT, TorisError, UsageError } from '../../core/errors.js';
import { asNumber } from '../args.js';
import { c, keyValues, line, printJson } from '../output.js';
import { findProject, loadProjects } from './project.js';
import {
  isDaemonRunning,
  readDaemonStatus,
  startDaemon,
  stopDaemon,
  submitDaemonJob,
} from '../../daemon/index.js';
import { cmdDaemonSchedule } from './daemon-schedule.js';

const SUBCOMMANDS = new Set(['start', 'stop', 'status', 'run', 'schedule']);

function formatUptime(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function printStatus(status) {
  if (!status.running) {
    line(`${c.yellow('STOPPED')} daemon is not running`);
    line(c.dim(`      home  ${status.home}`));
    line(c.dim('      start with `toris daemon start` (local-only; no cloud)'));
    printScheduleStatus(status);
    return;
  }
  line(`${c.green('RUNNING')} pid ${status.pid}  up ${formatUptime(status.uptimeMs)}`);
  keyValues([
    ['home', status.home],
    ['started', status.startedAt],
    ['heartbeat', status.heartbeatAt ?? c.dim('n/a')],
    ['jobs', `${status.jobs.queued} queued  ${status.jobs.running} running  ${status.jobs.succeeded} done`],
    ...scheduleStatusPairs(status),
  ]);
}

function scheduleStatusPairs(status) {
  const schedules = status.schedules || {};
  const count = Number(schedules.count) || 0;
  const enabled = Number(schedules.enabled) || 0;
  const next = schedules.nextDueAt
    ? `${schedules.nextDueAt}${schedules.nextId ? `  ${schedules.nextId}` : ''}`
    : c.dim('none');
  return [
    ['schedules', count === 0 ? '0' : `${enabled} enabled / ${count}`],
    ['next due', next],
  ];
}

function printScheduleStatus(status) {
  keyValues(scheduleStatusPairs(status));
}

export async function cmdDaemon(ctx, positionals, flags = {}, deps = {}) {
  const sub = positionals[0] ?? 'status';
  if (!SUBCOMMANDS.has(sub)) {
    throw new UsageError(
      `Unknown subcommand "daemon ${sub}". Try: start | stop | status | run | schedule`,
    );
  }
  if (sub === 'status') return statusCommand(ctx, deps);
  if (sub === 'start') return startCommand(ctx, flags, deps);
  if (sub === 'stop') return stopCommand(ctx, flags, deps);
  if (sub === 'schedule') return cmdDaemonSchedule(ctx, positionals.slice(1), flags);
  return runCommand(ctx, positionals.slice(1), flags, deps);
}

async function statusCommand(ctx, deps) {
  const status = await (deps.readStatus || readDaemonStatus)(ctx.home);
  if (ctx.json) {
    printJson(status);
    return EXIT.OK;
  }
  printStatus(status);
  return EXIT.OK;
}

async function startCommand(ctx, flags, deps) {
  const start = deps.start || startDaemon;
  if (flags.foreground) {
    await start(ctx.home, {
      foreground: true,
      signals: deps.signals || process,
      runJob: deps.runJob,
      spawn: deps.spawn,
      onReady: (info) => {
        if (ctx.json) {
          printJson({ ok: true, running: true, foreground: true, home: ctx.home, pid: info.pid });
        } else {
          (deps.output || line)(`${c.green('STARTED')} foreground daemon  pid ${info.pid}`);
          (deps.output || line)(c.dim(`      home  ${ctx.home}`));
        }
        deps.onReady?.(info);
      },
    });
    return EXIT.OK;
  }

  const status = await start(ctx.home, {
    spawn: deps.spawn,
    binPath: deps.binPath,
    nodePath: deps.nodePath,
    readyTimeoutMs: deps.readyTimeoutMs,
    stdio: deps.stdio,
  });
  if (ctx.json) {
    printJson({ ok: true, started: true, ...status });
    return EXIT.OK;
  }
  line(`${c.green('STARTED')} pid ${status.pid}`);
  line(c.dim(`      home  ${status.home}`));
  line(c.dim('      queue a goal with `toris daemon run "<goal>"` or `toris daemon schedule add`'));
  return EXIT.OK;
}

async function stopCommand(ctx, flags, deps) {
  const status = await (deps.stop || stopDaemon)(ctx.home, {
    kill: deps.kill,
    stopTimeoutMs: deps.stopTimeoutMs,
  });
  if (ctx.json) {
    printJson({ ok: true, ...status });
    return EXIT.OK;
  }
  if (status.stopped) line(`${c.green('STOPPED')} pid ${status.pid}`);
  else line(`${c.yellow('STOPPED')} daemon is not running`);
  return EXIT.OK;
}

async function resolveProject(ctx, flags) {
  if (!ctx.store) return null;
  const projects = await loadProjects(ctx).catch(() => []);
  if (flags.project) {
    const project = findProject(projects, String(flags.project));
    if (!project) throw new UsageError(`No project matching "${flags.project}"`);
    return project;
  }
  return projects.find((project) => project.path === ctx.cwd) ?? null;
}

async function runCommand(ctx, positionals, flags, deps) {
  const goal = positionals.join(' ').trim();
  if (!goal) throw new UsageError('Usage: toris daemon run "<goal>" [--dry-run] [-p <project>]');
  const running = await (deps.isRunning || isDaemonRunning)(ctx.home);
  if (!running) {
    throw new TorisError(
      'Daemon is not running. Start it with `toris daemon start`, then retry.',
      'E_DAEMON_UNAVAILABLE',
      EXIT.DAEMON_UNAVAILABLE,
    );
  }
  const project = await resolveProject(ctx, flags);
  const submit = deps.submit || submitDaemonJob;
  const job = await submit(ctx.home, {
    type: 'run',
    goal,
    cwd: ctx.cwd,
    project: project
      ? { id: project.id, name: project.name, path: project.path, checks: project.checks ?? [] }
      : null,
    autonomy: typeof flags.autonomy === 'string' ? flags.autonomy : null,
    dryRun: Boolean(flags['dry-run']),
    budgetUsd: asNumber(flags.budget, 'budget') ?? null,
    provider: typeof flags.provider === 'string' ? flags.provider : null,
    apply: Boolean(flags.apply),
    review: flags['no-review'] ? false : true,
  });
  if (ctx.json) {
    printJson({ ok: true, queued: true, job });
    return EXIT.OK;
  }
  line(`${c.green('QUEUED')} ${job.id}  run  ${job.goal}`);
  line(c.dim(`      home  ${ctx.home}`));
  line(c.dim('      inspect with `toris daemon status --json` or `toris runs`'));
  return EXIT.OK;
}

export async function daemonDoctorCheck(home) {
  const status = await readDaemonStatus(home);
  return {
    name: 'daemon',
    status: status.running ? 'PASS' : 'WARN',
    detail: status.running
      ? `running pid ${status.pid}`
      : 'not running; `toris daemon start` for background jobs',
  };
}

cmdDaemon.handlesFirstRun = true;
