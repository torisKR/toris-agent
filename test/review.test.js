import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, parseReview, skippedReview } from '../src/core/review.js';

test('the review prompt forbids the reviewer from writing files', () => {
  const prompt = buildReviewPrompt({
    goal: 'add health',
    implementer: 'claude',
    reviewer: 'codex',
    files: ['src/health.js'],
    patch: '+export const ok = true\n',
    summaries: ['added health'],
  });
  assert.match(prompt, /Do not edit/);
  assert.match(prompt, /claude/);
  assert.match(prompt, /codex/);
  assert.match(prompt, /src\/health\.js/);
  assert.match(prompt, /verdict/);
});

test('a fail verdict or blocker finding is not a pass', () => {
  assert.equal(
    parseReview('{"verdict":"fail","summary":"bug","findings":[]}', { provider: 'codex' }).passed,
    false,
  );
  assert.equal(
    parseReview(
      '{"verdict":"pass","summary":"ok","findings":[{"severity":"blocker","title":"auth bypass","detail":""}]}',
    ).passed,
    false,
  );
  const ok = parseReview(
    '{"verdict":"pass","summary":"fine","findings":[{"severity":"note","title":"nit","detail":"rename"}]}',
  );
  assert.equal(ok.passed, true);
  assert.equal(ok.findings[0].severity, 'note');
});

test('unparsable reviewer prose does not fail the run', () => {
  const review = parseReview('looks good to me');
  assert.equal(review.passed, true);
  assert.equal(review.unparsable, true);
});

test('skippedReview is explicit evidence, not a silent pass', () => {
  const review = skippedReview('opposite provider is not on PATH', { provider: 'codex' });
  assert.equal(review.skipped, true);
  assert.equal(review.passed, null);
});
