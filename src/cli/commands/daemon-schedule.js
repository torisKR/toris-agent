import { EXIT, UsageError } from '../../core/errors.js';
import { resolveAutonomy } from '../../core/autonomy.js';
import { asNumber } from '../args.js';
import { c, keyValues, line, printJson, table } from '../output.js';
import {
  addSchedule,
  findSchedule,
  listSchedules,
  publicSchedule,
  removeSchedule,
  ScheduleExprError,
  setScheduleEnabled,
} from '../../daemon/index.js';
import { findProject, loadProjects } from './project.js';

const ACTIONS = new Set(['list', 'ls', 'add', 'remove', 'rm', 'enable', 'disable']);

function autonomyOf(flags) {
  if (typeof flags.autonomy !== 'string') return null;
  try {
    return resolveAutonomy(flags.autonomy).level;
  } catch {
    throw new UsageError(`Unknown autonomy level "${flags.autonomy}". Use one of L1..L5.`);
  }
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

async function requireSchedule(home, ref) {
  const found = findSchedule(await listSchedules(home), ref);
  if (!found) throw new UsageError(`No schedule matching "${ref}".`);
  return found;
}

function wrapExpr(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ScheduleExprError) throw new UsageError(err.message);
      throw err;
    }
  };
}

export async function cmdDaemonSchedule(ctx, positionals, flags) {
  const action = positionals[0] ?? 'list';
  if (!ACTIONS.has(action)) {
    throw new UsageError(
      `Unknown subcommand "daemon schedule ${action}". Try: list | add | remove | enable | disable`,
    );
  }
  if (action === 'list' || action === 'ls') return listCommand(ctx);
  if (action === 'add') return addCommand(ctx, positionals.slice(1), flags);
  if (action === 'remove' || action === 'rm') return removeCommand(ctx, positionals[1]);
  return enableCommand(ctx, positionals[1], action === 'enable');
}

async function listCommand(ctx) {
  const schedules = (await listSchedules(ctx.home)).map(publicSchedule);
  if (ctx.json) {
    printJson({
      schedules,
      count: schedules.length,
      enabled: schedules.filter((item) => item.enabled).length,
      nextDueAt: earliest(schedules),
    });
    return EXIT.OK;
  }
  line(c.bold(`Schedules (${schedules.length})`));
  line(c.dim('      local cron only; no cloud'));
  line();
  table(
    ['ID', 'ON', 'WHEN', 'NEXT', 'GOAL'],
    schedules.map((item) => [
      item.id,
      item.enabled ? 'yes' : 'no',
      item.expr,
      item.nextDueAt ?? '—',
      item.goal,
    ]),
  );
  return EXIT.OK;
}

function earliest(schedules) {
  let next = null;
  for (const item of schedules) {
    if (!item.enabled || !item.nextDueAt) continue;
    if (!next || item.nextDueAt < next) next = item.nextDueAt;
  }
  return next;
}

const addCommand = wrapExpr(async function addCommand(ctx, positionals, flags) {
  const expr = positionals[0];
  const goal = positionals.slice(1).join(' ').trim();
  if (!expr || !goal) {
    throw new UsageError('Usage: toris daemon schedule add <expr> "<goal>" [--dry-run] [--disabled]');
  }
  const project = await resolveProject(ctx, flags);
  const schedule = await addSchedule(ctx.home, {
    expr,
    goal,
    enabled: !flags.disabled,
    autonomy: autonomyOf(flags),
    dryRun: Boolean(flags['dry-run']),
    budgetUsd: asNumber(flags.budget, 'budget') ?? null,
    provider: typeof flags.provider === 'string' ? flags.provider : null,
    apply: Boolean(flags.apply),
    review: flags['no-review'] ? false : true,
    cwd: ctx.cwd,
    project: project
      ? { id: project.id, name: project.name, path: project.path, checks: project.checks ?? [] }
      : null,
  });
  if (ctx.json) {
    printJson({ ok: true, created: true, schedule: publicSchedule(schedule) });
    return EXIT.OK;
  }
  line(`${c.green('ADDED')} ${schedule.id}  ${schedule.expr}  ${schedule.goal}`);
  keyValues([
    ['enabled', schedule.enabled ? 'yes' : 'no'],
    ['next', schedule.nextDueAt],
    ['home', ctx.home],
  ]);
  line(c.dim('      local only — the running daemon ticks these on its heartbeat'));
  return EXIT.OK;
});

async function removeCommand(ctx, ref) {
  if (!ref) throw new UsageError('Usage: toris daemon schedule remove <id>');
  const current = await requireSchedule(ctx.home, ref);
  await removeSchedule(ctx.home, current.id);
  if (ctx.json) {
    printJson({ ok: true, removed: true, schedule: publicSchedule(current) });
    return EXIT.OK;
  }
  line(`${c.green('REMOVED')} ${current.id}  ${current.goal}`);
  return EXIT.OK;
}

const enableCommand = wrapExpr(async function enableCommand(ctx, ref, enabled) {
  if (!ref) throw new UsageError(`Usage: toris daemon schedule ${enabled ? 'enable' : 'disable'} <id>`);
  const current = await requireSchedule(ctx.home, ref);
  const schedule = await setScheduleEnabled(ctx.home, current.id, enabled);
  if (ctx.json) {
    printJson({ ok: true, schedule: publicSchedule(schedule) });
    return EXIT.OK;
  }
  line(`${c.green(enabled ? 'ENABLED' : 'DISABLED')} ${schedule.id}  ${schedule.goal}`);
  if (enabled) line(c.dim(`      next  ${schedule.nextDueAt}`));
  return EXIT.OK;
});
