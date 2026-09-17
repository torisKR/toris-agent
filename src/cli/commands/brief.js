import { EXIT, UsageError } from '../../core/errors.js';
import { formatUsd } from '../../core/cost.js';
import { buildBrief, BRIEF_PERIODS, DEFAULT_BRIEF_PERIOD } from '../../core/brief.js';
import { printJson, line, table, keyValues, c, statusColor } from '../output.js';

function verifyLabel(value) {
  if (value === 'pass') return c.green('pass');
  if (value === 'fail') return c.red('fail');
  return c.dim('n/a');
}

function printSpend(spend) {
  const cap = spend.capUsd == null ? 'unlimited' : formatUsd(spend.capUsd);
  const remaining = spend.remainingUsd == null ? 'unlimited' : formatUsd(spend.remainingUsd);
  line(c.bold('Spend'));
  keyValues([
    ['today', `${formatUsd(spend.spentUsd)} / ${cap}`],
    ['remaining', remaining],
    ['runs', String(spend.runCount)],
  ]);
}

function printRuns(runs) {
  if (!runs.length) return;
  line();
  line(c.bold('Runs'));
  table(
    ['ID', 'STATUS', 'VERIFY', 'GOAL'],
    runs.map((run) => [run.id, statusColor(run.status), verifyLabel(run.verify), run.goal]),
  );
}

function printDaemon(daemon) {
  line();
  line(c.bold('Daemon'));
  if (daemon.running) {
    line(`${c.green('RUNNING')} pid ${daemon.pid}`);
  } else {
    line(`${c.yellow('STOPPED')}`);
  }
  const pairs = [];
  if (daemon.nextDueAt) {
    pairs.push(['next', `${daemon.nextDueAt}${daemon.nextId ? `  ${daemon.nextId}` : ''}`]);
  }
  if (daemon.scheduleCount > 0) {
    pairs.push(['schedules', `${daemon.schedulesEnabled} enabled / ${daemon.scheduleCount}`]);
  }
  if (pairs.length) keyValues(pairs);
}

function printKnowledge(knowledge) {
  if (!knowledge.available || !knowledge.headlines.length) return;
  line();
  line(c.bold('Knowledge'));
  table(
    ['KIND', 'ID', 'TITLE'],
    knowledge.headlines.map((item) => [
      item.kind,
      item.domain ? `${item.domain}/${item.id}` : item.id,
      item.title,
    ]),
  );
}

export async function cmdBrief(ctx, positionals) {
  const period = positionals[0] || DEFAULT_BRIEF_PERIOD;
  if (period && !BRIEF_PERIODS.includes(String(period).toLowerCase())) {
    throw new UsageError(`Unknown brief period "${period}". Use \`toris brief\` or \`toris brief today\`.`);
  }

  const brief = await buildBrief({
    home: ctx.home,
    store: ctx.store,
    config: ctx.config,
    cwd: ctx.cwd,
    period,
  });

  if (ctx.json) {
    printJson({ ok: true, ...brief });
    return EXIT.OK;
  }

  line(c.bold(`Brief  ${brief.day} (local)`));
  line();
  printSpend(brief.spend);
  printRuns(brief.runs);
  printDaemon(brief.daemon);
  printKnowledge(brief.knowledge);
  return EXIT.OK;
}
