import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease, contentHash } from '../src/studio/release-guard.js';

const reviewed = {
  id: 'cnt_reviewed', kind: 'video', title: 'reviewed', channels: ['threads', 'x'],
  brief: null, media: { sha256: 'media-sha' }, quality: { passed: true, rules: [] },
};

test('release check keeps every incomplete gate local and blocked', () => {
  const valid = { confirmPublicPublish: true, confirmationText: `PUBLISH ${reviewed.id}`, contentHash: contentHash(reviewed) };
  assert.match(checkRelease(reviewed, { ...valid, confirmPublicPublish: false }).reason, /확인이 필요/);
  assert.match(checkRelease(reviewed, { ...valid, confirmationText: 'PUBLISH wrong' }).reason, /일치하지 않/);
  assert.match(checkRelease(reviewed, { ...valid, contentHash: 'stale' }).reason, /변경됐/);
  const failedQuality = { ...reviewed, quality: { passed: false } };
  assert.match(checkRelease(failedQuality, { ...valid, contentHash: contentHash(failedQuality) }).reason, /품질 검사/);
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
    reason: '이 로컬 Studio에서는 외부 게시가 비활성화되어 있습니다.',
  });
});
