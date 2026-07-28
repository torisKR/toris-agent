/**
 * An evidence receipt: what was asked, what ran, what was proved, what it cost.
 * Pure function of the run so it can be regenerated at any time.
 */
export function buildReceipt(run, events = []) {
  const tasks = run.tasks ?? [];
  const byStatus = (status) => tasks.filter((t) => t.status === status).length;
  return {
    runId: run.id,
    goal: run.goal,
    project: run.projectId ?? null,
    status: run.status,
    autonomy: run.autonomy,
    provider: run.provider,
    startedAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : null,
    tasks: {
      total: tasks.length,
      succeeded: byStatus('succeeded'),
      failed: byStatus('failed'),
      skipped: byStatus('skipped'),
    },
    taskList: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      agent: t.agent ?? null,
      status: t.status ?? 'unknown',
      error: t.error ?? null,
    })),
    verification: {
      passed: run.verification?.passed ?? null,
      checks: run.verification?.checks ?? [],
    },
    costUsd: Number((run.costUsd ?? 0).toFixed(4)),
    eventCount: events.length,
    artifacts: run.artifacts ?? [],
  };
}

export function receiptToMarkdown(receipt) {
  const lines = [
    `# Run receipt \`${receipt.runId}\``,
    '',
    `**Goal** — ${receipt.goal}`,
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
    `## Tasks (${receipt.tasks.succeeded}/${receipt.tasks.total} succeeded)`,
    '',
  ];
  const ICONS = { succeeded: '✅', failed: '❌', skipped: '⏭️', pending: '⏳' };
  for (const task of receipt.taskList ?? []) {
    const icon = ICONS[task.status] ?? '•';
    const agent = task.agent ? ` _(${task.agent})_` : '';
    lines.push(`- ${icon} ${task.title}${agent}`);
    if (task.error) lines.push(`  - error: \`${task.error}\``);
  }
  if ((receipt.taskList ?? []).length > 0) lines.push('');
  if (receipt.verification.checks.length > 0) {
    lines.push('## Verification', '');
    for (const check of receipt.verification.checks) {
      lines.push(`- ${check.passed ? '✅' : '❌'} \`${check.command}\` (exit ${check.exitCode})`);
    }
    lines.push('');
  }
  if (receipt.artifacts.length > 0) {
    lines.push('## Artifacts', '', ...receipt.artifacts.map((a) => `- \`${a}\``), '');
  }
  return lines.join('\n');
}
