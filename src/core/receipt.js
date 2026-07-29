import { failureExcerpt } from './verifier.js';

/**
 * An evidence receipt: what was asked, what ran, what was proved, what it cost.
 * Pure function of the run so it can be regenerated at any time.
 */

/** Bump only on a breaking change to the receipt shape. Additive fields do not. */
export const RECEIPT_SCHEMA_VERSION = 1;

/** Every failure in the run, in one place, so nobody has to diff two sections. */
function collectFailures(tasks, checks) {
  const taskFailures = tasks
    .filter((t) => t.status === 'failed')
    .map((t) => ({ kind: 'task', label: t.title ?? t.id, detail: t.error ?? '' }));
  const checkFailures = checks
    .filter((c) => !c.passed)
    .map((c) => ({ kind: 'check', label: c.command, detail: failureExcerpt(c) }));
  return [...taskFailures, ...checkFailures];
}

/** One line a solo developer can read without opening anything else. */
function buildVerdict({ status, tasks, verification, durationMs, costUsd }) {
  const parts = [`${tasks.succeeded}/${tasks.total} tasks succeeded`];
  if (verification.passed === true) {
    parts.push(`${verification.total} check${verification.total === 1 ? '' : 's'} passed`);
  } else if (verification.passed === false) {
    parts.push(`${verification.failed} of ${verification.total} checks failed`);
  } else {
    parts.push('nothing verified');
  }
  if (durationMs != null) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  parts.push(`$${costUsd.toFixed(4)}`);
  return `${status} — ${parts.join(', ')}`;
}

export function buildReceipt(run, events = []) {
  const tasks = run.tasks ?? [];
  const checks = run.verification?.checks ?? [];
  const byStatus = (status) => tasks.filter((t) => t.status === status).length;
  const taskCounts = {
    total: tasks.length,
    succeeded: byStatus('succeeded'),
    failed: byStatus('failed'),
    skipped: byStatus('skipped'),
  };
  const verification = {
    passed: run.verification?.passed ?? null,
    total: checks.length,
    failed: checks.filter((c) => !c.passed).length,
    checks,
  };
  const durationMs = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : null;
  const costUsd = Number((run.costUsd ?? 0).toFixed(4));
  const status = run.status ?? 'unknown';

  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    runId: run.id,
    goal: run.goal,
    project: run.projectId ?? null,
    status: run.status,
    autonomy: run.autonomy,
    provider: run.provider,
    startedAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    durationMs,
    verdict: buildVerdict({ status, tasks: taskCounts, verification, durationMs, costUsd }),
    tasks: taskCounts,
    taskList: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      agent: t.agent ?? null,
      status: t.status ?? 'unknown',
      error: t.error ?? null,
    })),
    verification,
    failures: collectFailures(tasks, checks),
    costUsd,
    eventCount: events.length,
    artifacts: run.artifacts ?? [],
  };
}

const ICONS = Object.freeze({ succeeded: '✅', failed: '❌', skipped: '⏭️', pending: '⏳' });
const VERDICT_ICON = Object.freeze({
  succeeded: '✅',
  failed: '❌',
  'dry-run': '📝',
  'awaiting-approval': '⏸️',
});

/** Files listed inline before the reader is told to go look at git instead. */
const MAX_LISTED_ARTIFACTS = 20;

function headlineLines(receipt) {
  const icon = VERDICT_ICON[receipt.status] ?? '•';
  return [
    `# Run receipt \`${receipt.runId}\``,
    '',
    `${icon} **${receipt.goal}**`,
    '',
    `> ${receipt.verdict}`,
    '',
  ];
}

const indent = (text) => text.split('\n').map((l) => `  ${l}`);

function failureLines(receipt) {
  if (receipt.failures.length === 0) return [];
  const lines = ['## What went wrong', ''];
  for (const failure of receipt.failures) {
    lines.push(`- **${failure.kind === 'check' ? 'check' : 'task'}** \`${failure.label}\``);
    if (failure.detail) lines.push('', '  ```', ...indent(failure.detail), '  ```');
    lines.push('');
  }
  return lines;
}

function taskLines(receipt) {
  const lines = [`## Tasks (${receipt.tasks.succeeded}/${receipt.tasks.total} succeeded)`, ''];
  for (const task of receipt.taskList ?? []) {
    const icon = ICONS[task.status] ?? '•';
    const agent = task.agent ? ` _(${task.agent})_` : '';
    lines.push(`- ${icon} ${task.title}${agent}`);
    if (task.error) lines.push(`  - error: \`${task.error}\``);
  }
  if ((receipt.taskList ?? []).length > 0) lines.push('');
  return lines;
}

function verificationLines(receipt) {
  if (receipt.verification.checks.length === 0) {
    // Silence here would read as "verified"; say so explicitly instead.
    return ['## Verification', '', '_No checks ran, so nothing about this run was proved._', ''];
  }
  const lines = ['## Verification', ''];
  for (const check of receipt.verification.checks) {
    lines.push(`- ${check.passed ? '✅' : '❌'} \`${check.command}\` (exit ${check.exitCode})`);
  }
  lines.push('');
  return lines;
}

function artifactLines(receipt) {
  if (receipt.artifacts.length === 0) return [];
  const shown = receipt.artifacts.slice(0, MAX_LISTED_ARTIFACTS);
  const rest = receipt.artifacts.length - shown.length;
  return [
    `## Changed files (${receipt.artifacts.length})`,
    '',
    ...shown.map((a) => `- \`${a}\``),
    ...(rest > 0 ? [`- _…and ${rest} more_`] : []),
    '',
  ];
}

function detailLines(receipt) {
  return [
    '## Details',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | \`${receipt.status}\` |`,
    `| Autonomy | ${receipt.autonomy} |`,
    `| Provider | ${receipt.provider} |`,
    `| Started | ${receipt.startedAt} |`,
    `| Finished | ${receipt.finishedAt ?? '—'} |`,
    `| Duration | ${receipt.durationMs != null ? `${(receipt.durationMs / 1000).toFixed(1)}s` : '—'} |`,
    `| Cost | $${receipt.costUsd.toFixed(4)} |`,
    '',
  ];
}

/**
 * Verdict first, evidence below. A solo developer reviewing their own agent
 * reads the top three lines and only scrolls when something is red.
 */
export function receiptToMarkdown(receipt) {
  return [
    ...headlineLines(receipt),
    ...failureLines(receipt),
    ...taskLines(receipt),
    ...verificationLines(receipt),
    ...artifactLines(receipt),
    ...detailLines(receipt),
  ].join('\n');
}
