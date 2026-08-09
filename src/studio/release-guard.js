import { createHash } from 'node:crypto';

export function contentHash(content) {
  const snapshot = {
    id: content.id,
    kind: content.kind,
    title: content.title,
    channels: content.channels,
    brief: content.brief,
    mediaSha256: content.media?.sha256 || null,
    quality: content.quality || null,
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function blocked(reason) {
  return { ready: false, blocked: true, externalAction: false, reason };
}

export function checkRelease(content, input = {}) {
  if (input.confirmPublicPublish !== true) return blocked('외부 공개 확인이 필요합니다.');
  if (input.confirmationText !== `PUBLISH ${content.id}`) return blocked('확인 문구가 일치하지 않습니다.');
  if (input.contentHash !== contentHash(content)) return blocked('검토 이후 콘텐츠가 변경됐습니다.');
  if (content.media && content.quality?.passed !== true) return blocked('품질 검사를 통과한 영상만 공개 검토할 수 있습니다.');
  if (!Array.isArray(content.channels) || content.channels.length === 0) return blocked('검토할 채널이 하나 이상 필요합니다.');
  return blocked('이 로컬 Studio에서는 외부 게시가 비활성화되어 있습니다.');
}
