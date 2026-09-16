/**
 * Studio-facing views of the existing `toris patches` store.
 * CLI apply/discard stay on `src/core/patches.js`; this module only bounds
 * diffs for the GUI and formats a review note as an agent turn.
 */

export const PATCH_DIFF_CHAR_LIMIT = 80_000;
export const PATCH_DIFF_LINE_LIMIT = 4_000;
export const PATCH_REVIEW_NOTE_LIMIT = 2_000;
export const PATCH_HUNK_LIMIT = 8_000;
export const PATCH_REVIEW_DIFF_CHAR_LIMIT = 16_000;
export const PATCH_STATUSES = Object.freeze(['pending', 'applied', 'discarded', 'failed']);

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
}

export function boundUnifiedDiff(diff, { maxChars = PATCH_DIFF_CHAR_LIMIT, maxLines = PATCH_DIFF_LINE_LIMIT } = {}) {
  const text = String(diff ?? '');
  const lines = text.split('\n');
  const lineCount = text.length === 0 ? 0 : lines.length;
  let body = text;
  let truncated = false;
  if (lineCount > maxLines) {
    body = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    truncated = true;
  }
  return {
    diff: truncated ? `${body}\n…[truncated]` : body,
    truncated,
    chars: text.length,
    lines: lineCount,
  };
}

/** Public patch card. Omits worktree/diff paths; list calls skip the diff. */
export function presentPatch(record, { diff } = {}) {
  const files = Array.isArray(record?.files) ? record.files : [];
  const presented = {
    id: record?.id ?? null,
    status: record?.status ?? null,
    source: record?.source ?? null,
    runId: record?.runId ?? null,
    originPath: record?.originPath ?? null,
    branch: record?.branch ?? null,
    baseSha: record?.baseSha ?? null,
    autonomy: record?.autonomy ?? null,
    files,
    fileCount: files.length,
    stats: record?.stats || '',
    originTouched: Boolean(record?.originTouched),
    createdAt: record?.createdAt ?? null,
    decidedAt: record?.decidedAt ?? null,
    applyError: record?.applyError ?? null,
  };
  if (diff != null) {
    const bounded = boundUnifiedDiff(diff);
    presented.diff = bounded.diff;
    presented.truncated = bounded.truncated;
    presented.diffChars = bounded.chars;
    presented.diffLines = bounded.lines;
  }
  return presented;
}

export function formatPatchReviewMessage({
  patch,
  diff,
  note,
  hunk,
  maxDiffChars = PATCH_REVIEW_DIFF_CHAR_LIMIT,
} = {}) {
  const record = patch && typeof patch === 'object' ? patch : {};
  const files = Array.isArray(record.files) ? record.files : [];
  const lines = [
    `## Patch review (${record.id || 'unknown'})`,
    `Status: ${record.status || 'unknown'}`,
    record.originPath ? `Origin: ${record.originPath}` : null,
    record.branch ? `Branch: ${record.branch}` : null,
    record.autonomy ? `Autonomy: ${record.autonomy}` : null,
    record.stats ? `Stats: ${record.stats}` : null,
    files.length ? `Files: ${files.slice(0, 24).join(', ')}${files.length > 24 ? '…' : ''}` : null,
    record.originTouched ? 'Warning: the original checkout also changed; inspect before applying.' : null,
    String(note ?? '').trim() ? `Reviewer note:\n${clip(String(note).trim(), PATCH_REVIEW_NOTE_LIMIT)}` : null,
    String(hunk ?? '').trim()
      ? `Selected hunk:\n\`\`\`diff\n${clip(String(hunk).trim(), PATCH_HUNK_LIMIT)}\n\`\`\``
      : null,
    diff ? `Unified diff:\n\`\`\`diff\n${clip(diff, maxDiffChars)}\n\`\`\`` : null,
    'This is operator intent on an isolated patch. Edit the work so the next apply is correct. Do not apply or discard unless asked. Stay inside this isolated worktree; do not write the original checkout.',
  ];
  return lines.filter((line) => line != null && line !== '').join('\n');
}
