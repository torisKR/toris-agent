import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease, contentHash } from '../src/studio/release-guard.js';

const reviewed = {
  id: 'cnt_reviewed', kind: 'video', title: 'reviewed', channels: ['threads', 'x'],
  brief: null, media: { sha256: 'media-sha' }, quality: { passed: true, rules: [] },
};

test('release check keeps every incomplete gate local and blocked', () => {
  const valid = { confirmPublicPublish: true, confirmationText: `PUBLISH ${reviewed.id}`, contentHash: contentHash(reviewed) };
  assert.match(checkRelease(reviewed, { ...valid, confirmPublicPublish: false }).reason, /confirmation is required/);
  assert.match(checkRelease(reviewed, { ...valid, confirmationText: 'PUBLISH wrong' }).reason, /does not match/);
  assert.match(checkRelease(reviewed, { ...valid, contentHash: 'stale' }).reason, /changed after review/);
  const failedQuality = { ...reviewed, quality: { passed: false } };
  assert.match(checkRelease(failedQuality, { ...valid, contentHash: contentHash(failedQuality) }).reason, /quality must pass/);
});

test('fully confirmed release remains blocked with no external action', () => {
  const result = checkRelease(reviewed, {
    confirmPublicPublish: true,
    confirmationText: `PUBLISH ${reviewed.id}`,
    contentHash: contentHash(reviewed),
  });
  assert.deepEqual(result, {
    ready: false,
    blocked: true,
    externalAction: false,
    reason: 'external publishing is disabled in this local Studio',
  });
});
