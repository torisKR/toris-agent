import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PATCH_DIFF_CHAR_LIMIT,
  boundUnifiedDiff,
  formatPatchReviewMessage,
  presentPatch,
} from '../src/studio/patch-view.js';

const SAMPLE = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1,3 +1,4 @@
 keep
-old
+new
`;

test('boundUnifiedDiff truncates by line and character limits', () => {
  const many = Array.from({ length: 12 }, (_, i) => `+line ${i}`).join('\n');
  const byLines = boundUnifiedDiff(many, { maxLines: 4, maxChars: 10_000 });
  assert.equal(byLines.truncated, true);
  assert.equal(byLines.lines, 12);
  assert.match(byLines.diff, /truncated/);
  assert.equal(byLines.diff.split('\n').filter((line) => line.startsWith('+')).length, 4);

  const huge = `+${'x'.repeat(80)}`;
  const byChars = boundUnifiedDiff(huge, { maxLines: 100, maxChars: 20 });
  assert.equal(byChars.truncated, true);
  assert.ok(byChars.diff.length < huge.length + 20);
});

test('presentPatch omits worktree paths and can attach a bounded diff', () => {
  const presented = presentPatch({
    id: 'pat_1',
    status: 'pending',
    originPath: '/Users/dev/app',
    worktreePath: '/tmp/wt',
    diffPath: '/tmp/pat_1.diff',
    files: ['src/app.js'],
    stats: '1 file changed',
    autonomy: 'L2',
    originTouched: false,
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(presented.id, 'pat_1');
  assert.equal(presented.fileCount, 1);
  assert.equal(presented.diff, undefined);
  assert.equal(presented.worktreePath, undefined);
  assert.equal(presented.diffPath, undefined);

  const withDiff = presentPatch(presented, { diff: `${SAMPLE}${'+pad\n'.repeat(PATCH_DIFF_CHAR_LIMIT)}` });
  assert.equal(withDiff.truncated, true);
  assert.match(withDiff.diff, /\+new/);
});

test('formatPatchReviewMessage is an implementer turn with operator intent', () => {
  const message = formatPatchReviewMessage({
    patch: { id: 'pat_1', status: 'pending', originPath: '/tmp/app', files: ['a.js'], stats: '1 file' },
    diff: SAMPLE,
    note: 'Keep the coral CTA at 44px.',
    hunk: '@@ -1,3 +1,4 @@\n keep\n-old\n+new',
  });
  assert.match(message, /Patch review \(pat_1\)/);
  assert.match(message, /Keep the coral CTA at 44px/);
  assert.match(message, /Selected hunk/);
  assert.match(message, /Unified diff/);
  assert.match(message, /Do not apply or discard unless asked/);
});
