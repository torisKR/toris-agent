import { EXIT, UsageError } from '../../core/errors.js';
import { summarizeCost, formatUsd } from '../../core/cost.js';
import { printJson, line, table, keyValues, c } from '../output.js';

const ACTIONS = new Set(['today']);

export async function cmdCost(ctx, positionals) {
  const action = positionals[0];
  if (action && !ACTIONS.has(action)) {
    throw new UsageError(`Unknown cost subcommand "${action}". Use \`toris cost\` or \`toris cost today\`.`);
  }

  const summary = await summarizeCost({
    home: ctx.home,
    store: ctx.store,
    config: ctx.config,
  });

  if (ctx.json) {
    printJson({
      ok: true,
      timezone: summary.timezone,
      today: summary.today,
      days: action === 'today' ? [summary.today] : summary.days,
      runs: action === 'today' ? summary.today.entries : summary.runs,
    });
    return EXIT.OK;
  }

  printToday(summary.today);
  if (action !== 'today') {
    printDays(summary.days);
    printRuns(summary.runs);
  } else if (summary.today.entries.length) {
    line();
    line(c.bold('  Runs today'));
    table(
      ['ID', 'COST', 'STATUS', 'GOAL'],
      summary.today.entries.map((entry) => [
        entry.runId,
        formatUsd(entry.costUsd),
        entry.status,
        (entry.goal ?? '').slice(0, 48),
      ]),
    );
  }
  return EXIT.OK;
}

function printToday(today) {
  const cap = today.capUsd == null ? 'unlimited' : formatUsd(today.capUsd);
  const remaining = today.remainingUsd == null ? 'unlimited' : formatUsd(today.remainingUsd);
  line(c.bold('Cost'));
  line();
  keyValues([
    ['today', `${formatUsd(today.spentUsd)} / ${cap}`],
    ['remaining', remaining],
    ['day', `${today.day} (local)`],
    ['runs', String(today.runCount)],
  ]);
}

function printDays(days) {
  line();
  line(c.bold('  Days'));
  table(
    ['DATE', 'SPENT', 'RUNS'],
    days.map((day) => [day.day, formatUsd(day.spentUsd), day.runCount]),
  );
}

function printRuns(runs) {
  line();
  line(c.bold('  Recent runs'));
  table(
    ['ID', 'COST', 'STATUS', 'GOAL'],
    runs.map((run) => [run.id, formatUsd(run.costUsd), run.status, (run.goal ?? '').slice(0, 48)]),
  );
}
