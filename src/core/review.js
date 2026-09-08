import { extractJsonArray } from './planner.js';

const MAX_DIFF_CHARS = 80_000;

/**
 * Cross-model second pass: the implementer never grades its own homework.
 * Claude implements, Codex reviews (or the reverse). That is the 2026 pattern
 * operators already run in two terminals; this is that handshake as a receipt.
 */

export function buildReviewPrompt({ goal, implementer, reviewer, files, patch, summaries }) {
  const diff = String(patch ?? '');
  const clipped =
    diff.length > MAX_DIFF_CHARS
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} characters]`
      : diff;
  const fileList = (files ?? []).map((f) => `- ${f}`).join('\n') || '- (none named)';
  const work = (summaries ?? []).filter(Boolean).join('\n') || '(no implementer summaries)';
  return [
    `You are the independent ${reviewer} reviewer. ${implementer} implemented the change.`,
    'Do not edit, create or delete files. Read-only. A model must not grade its own homework.',
    `Goal: ${goal}`,
    '',
    'Changed files:',
    fileList,
    '',
    'Implementer summaries:',
    work,
    '',
    'Diff:',
    clipped || '(empty diff)',
    '',
    'Reply with ONLY a JSON object, no prose, no code fences:',
    '{"verdict":"pass"|"fail","summary":"one paragraph","findings":[{"severity":"blocker"|"warning"|"note","title":"...","detail":"..."}]}',
    'verdict is fail if any finding would be wrong to merge without a human looking.',
  ].join('\n');
}

function parseObject(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try next */
    }
  }
  const arr = extractJsonArray(text);
  if (Array.isArray(arr) && arr[0] && typeof arr[0] === 'object') return arr[0];
  return null;
}

const SEVERITIES = new Set(['blocker', 'warning', 'note']);

/** Normalise a reviewer reply into evidence. Unparsable output does not fail the run. */
export function parseReview(text, { provider } = {}) {
  const raw = parseObject(text);
  if (!raw) {
    return {
      provider: provider ?? null,
      passed: true,
      skipped: false,
      unparsable: true,
      summary: String(text ?? '').slice(0, 2000),
      findings: [],
    };
  }
  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .filter((item) => item && typeof item === 'object' && typeof item.title === 'string')
    .map((item) => ({
      severity: SEVERITIES.has(item.severity) ? item.severity : 'note',
      title: String(item.title).trim().slice(0, 200),
      detail: typeof item.detail === 'string' ? item.detail.trim().slice(0, 1000) : '',
    }));
  const verdict = raw.verdict === 'fail' || findings.some((f) => f.severity === 'blocker') ? 'fail' : 'pass';
  return {
    provider: provider ?? null,
    passed: verdict === 'pass',
    skipped: false,
    unparsable: false,
    verdict,
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 2000) : '',
    findings,
  };
}

export function skippedReview(reason, { provider } = {}) {
  return {
    provider: provider ?? null,
    passed: null,
    skipped: true,
    reason,
    findings: [],
    summary: '',
  };
}
