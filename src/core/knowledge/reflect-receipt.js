import { slugify } from './markdown.js';
import { emptyReflection, guessDomain, isVerifiedSuccess, titleFrom } from './reflect.js';

const MAX_LIST = 8;

/**
 * Propose one tacit draft from a verified run receipt.
 * Failed or missing verification never yields a success note.
 *
 * @param {object} receipt  from buildReceipt()
 * @param {{domain?:string, domains?:object[]}} [options]
 */
export function proposeReflectionsFromReceipt(receipt = {}, options = {}) {
  const runId = receipt.runId ?? null;
  const source = { kind: 'receipt', runId, verified: isVerifiedSuccess(receipt) };
  if (!source.verified) {
    const failed = receipt.verification?.passed === false;
    return emptyReflection(
      failed
        ? 'Verification failed; will not propose a success tacit note.'
        : 'Nothing was verified on this run, so there is no success tacit to propose.',
      { source },
    );
  }

  const goal = String(receipt.goal ?? '').trim() || 'Verified run';
  const blob = receiptBlob(receipt);
  const domain = options.domain || guessDomain(blob, options.domains);
  const title = titleFrom(goal);
  return {
    notable: true,
    reason: 'Propose a tacit note the operator can accept. Do not write it silently.',
    proposals: [
      {
        id: slugify(title, 'tacit-note'),
        title,
        domain,
        tags: ['tacit', 'reflect', 'receipt'],
        body: renderReceiptDraft({ receipt, title, goal }),
        runId,
      },
    ],
    source,
  };
}

function receiptBlob(receipt) {
  const titles = (receipt.taskList ?? []).map((task) => task.title).join(' ');
  const checks = (receipt.verification?.checks ?? []).map((check) => check.command).join(' ');
  return [receipt.goal, titles, checks, receipt.verdict].filter(Boolean).join('\n');
}

function renderReceiptDraft({ receipt, title, goal }) {
  const runId = receipt.runId ?? 'unknown';
  return [
    `# ${title}`,
    '',
    `From verified run \`${runId}\`.`,
    '',
    `**Goal:** ${goal}`,
    '',
    '**Plan**',
    ...planLines(receipt.taskList),
    '',
    '**Checks**',
    ...checkLines(receipt.verification?.checks),
    '',
    '**Outcome**',
    outcomeNotes(receipt),
    '',
    'Captured from a verified successful run. Edit before promoting if the wording is too specific.',
  ].join('\n');
}

function planLines(tasks = []) {
  if (!tasks.length) return ['- (no plan titles)'];
  return tasks.slice(0, MAX_LIST).map((task) => `- ${task.title} (${task.status ?? 'unknown'})`);
}

function checkLines(checks = []) {
  if (!checks.length) return ['- (no checks)'];
  return checks
    .slice(0, MAX_LIST)
    .map((check) => `- \`${check.command}\` exit ${check.exitCode ?? (check.passed ? 0 : 1)}`);
}

function outcomeNotes(receipt) {
  const notes = [receipt.verdict || `${receipt.status ?? 'succeeded'} — verification passed`].filter(Boolean);
  if (receipt.review?.summary) notes.push(String(receipt.review.summary).slice(0, 240));
  return notes.join('\n');
}
