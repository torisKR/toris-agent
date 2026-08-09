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
  if (input.confirmPublicPublish !== true) return blocked('public publish confirmation is required');
  if (input.confirmationText !== `PUBLISH ${content.id}`) return blocked('confirmation text does not match');
  if (input.contentHash !== contentHash(content)) return blocked('content changed after review');
  if (content.media && content.quality?.passed !== true) return blocked('video quality must pass before publish');
  if (!Array.isArray(content.channels) || content.channels.length === 0) return blocked('at least one publish channel is required');
  return blocked('external publishing is disabled in this local Studio');
}
