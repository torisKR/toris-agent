import { Orchestrator } from '../../core/orchestrator.js';
import { buildReceipt, receiptToMarkdown } from '../../core/receipt.js';
import { UsageError, EXIT, VerificationError } from '../../core/errors.js';
import { resolveAutonomy } from '../../core/autonomy.js';
import { asNumber } from '../args.js';
import { loadProjects, findProject } from './project.js';
import { printJson, line, table, keyValues, c, statusColor } from '../output.js';

export async function cmdRun(ctx, positionals, flags) {
  const goal = positionals.join(' ').trim();
  if (!goal) throw new UsageError('Usage: toris run "<goal>" [-p <project>] [--autonomy L1..L5] [--dry-run]');

  const projects = await loadProjects(ctx);
  const project = flags.project
    ? findProject(projects, String(flags.project))
    : projects.find((p) => p.path === process.cwd()) ?? null;
  if (flags.project && !project) throw new UsageError(`No project matching "${flags.project}"`);

  const autonomy = resolveAutonomy(flags.autonomy ?? ctx.config.defaultAutonomy).level;
  const dryRun = Boolean(flags['dry-run']);

  if (!ctx.json) {
    line(c.bold(`Run ${SYM(dryRun)}`));
    keyValues([
      ['goal', goal],
      ['project', project ? `${project.name} (${project.path})` : c.dim('none')],
      ['autonomy', `${autonomy}`],
      ['mode', dryRun ? 'dry-run (plan only, nothing executes)' : 'execute'],
    ]);
    line();
  }

  const orchestrator = new Orchestrator({
    store: ctx.store,
    config: ctx.config,
    onEvent: ctx.verbose && !ctx.json ? (e) => line(c.dim(`  [${e.type}] ${e.title ?? e.taskId ?? ''}`)) : undefined,
  });

  const run = await orchestrator.run({
    goal,
    project,
    autonomy,
    dryRun,
    budgetUsd: asNumber(flags.budget, 'budget'),
    provider: typeof flags.provider === 'string' ? flags.provider : undefined,
    checks: project?.checks ?? [],
  });

  if (ctx.json) {
    printJson({ ok: run.status !== 'failed', run });
  } else {
    printRun(run);
  }
  if (run.verification?.passed === false) return EXIT.VERIFICATION_FAILED;
  if (run.status === 'awaiting-approval') return EXIT.APPROVAL_DENIED;
  return run.status === 'failed' ? EXIT.FAILURE : EXIT.OK;
}

const SYM = (dry) => (dry ? c.dim('(dry-run)') : '');

function printRun(run) {
  line(`${c.bold('Run')} ${run.id}  ${statusColor(run.status)}`);
  if (!run.providerAvailable) {
    line(c.yellow(`  no provider CLI detected - used deterministic fallback plan`));
  }
  if (run.blockedReason) line(c.yellow(`  blocked: ${run.blockedReason}`));
  line();
  line(c.bold(`  Tasks (${run.tasks.length})`));
  table(['#', 'AGENT', 'STATUS', 'TITLE'],
    run.tasks.map((t, i) => [i + 1, t.agent, t.status, t.title]));
  if (run.verification?.checks?.length) {
    line();
    line(c.bold('  Verification'));
    table(['RESULT', 'EXIT', 'COMMAND'],
      run.verification.checks.map((v) => [v.passed ? 'PASS' : 'FAIL', v.exitCode, v.command]));
  }
  if (run.artifacts?.length) {
    line();
    line(`  ${c.bold('Changed files')}: ${run.artifacts.length}`);
  }
  line();
  line(`  ${c.dim('cost')} $${(run.costUsd ?? 0).toFixed(4)}   ${c.dim('receipt')} toris receipt ${run.id}`);
}

export async function cmdRuns(ctx, _positionals, flags) {
  let runs = await ctx.store.listRuns();
  if (flags.status) runs = runs.filter((r) => r.status === flags.status);
  if (flags.project) runs = runs.filter((r) => r.projectId === flags.project);
  const limit = asNumber(flags.limit, 'limit') ?? 20;
  runs = runs.slice(0, limit);
  if (ctx.json) { printJson({ runs }); return EXIT.OK; }
  line(c.bold(`Runs (${runs.length})`));
  line();
  table(['ID', 'STATUS', 'TASKS', 'CREATED', 'GOAL'],
    runs.map((r) => [r.id, r.status, r.tasks?.length ?? 0, r.createdAt?.slice(0, 19), (r.goal ?? '').slice(0, 48)]));
  return EXIT.OK;
}

async function mustGetRun(ctx, runId) {
  if (!runId) throw new UsageError('Missing <runId>');
  const run = await ctx.store.getRun(runId);
  if (!run) throw new UsageError(`No run "${runId}"`);
  return run;
}

export async function cmdInspect(ctx, positionals) {
  const run = await mustGetRun(ctx, positionals[0]);
  if (ctx.json) { printJson({ run }); return EXIT.OK; }
  printRun(run);
  return EXIT.OK;
}

export async function cmdReceipt(ctx, positionals, flags) {
  const run = await mustGetRun(ctx, positionals[0]);
  const receipt = buildReceipt(run, await ctx.store.readEvents(run.id));
  if (ctx.json) { printJson(receipt); return EXIT.OK; }
  if (flags.md) { line(receiptToMarkdown(receipt)); return EXIT.OK; }
  line(c.bold(`Receipt ${receipt.runId}`));
  keyValues([
    ['goal', receipt.goal],
    ['status', statusColor(receipt.status)],
    ['autonomy', receipt.autonomy],
    ['provider', receipt.provider],
    ['tasks', `${receipt.tasks.succeeded}/${receipt.tasks.total} succeeded`],
    ['verified', receipt.verification.passed === null ? 'n/a' : String(receipt.verification.passed)],
    ['cost', `$${receipt.costUsd.toFixed(4)}`],
    ['events', String(receipt.eventCount)],
  ]);
  return EXIT.OK;
}

export async function cmdLogs(ctx, positionals) {
  const run = await mustGetRun(ctx, positionals[0]);
  const events = await ctx.store.readEvents(run.id);
  if (ctx.json) { printJson({ events }); return EXIT.OK; }
  for (const event of events) {
    line(`${c.dim(event.at ?? '')}  ${c.cyan((event.type ?? '?').padEnd(16))} ${event.title ?? event.reason ?? event.error ?? ''}`);
  }
  return EXIT.OK;
}

export async function cmdCancel(ctx, positionals) {
  const run = await mustGetRun(ctx, positionals[0]);
  if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
    throw new UsageError(`Run ${run.id} already finished with status "${run.status}"`);
  }
  const cancelled = { ...run, status: 'cancelled', finishedAt: new Date().toISOString() };
  await ctx.store.saveRun(cancelled);
  await ctx.store.appendEvent(run.id, { type: 'run.cancelled', runId: run.id, at: cancelled.finishedAt });
  if (ctx.json) { printJson({ ok: true, run: cancelled }); return EXIT.OK; }
  line(`${c.yellow('x')} Cancelled ${cancelled.id}`);
  return EXIT.OK;
}
