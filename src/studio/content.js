import { createId } from '../core/ids.js';

export const CONTENT_STATUS = Object.freeze({
  DRAFT: 'draft',
  IMPORTED: 'imported',
  QUEUED: 'queued',
  RENDERING: 'rendering',
  QUALITY_FAILED: 'quality_failed',
  AWAITING_REVIEW: 'awaiting_review',
  PUBLISHING: 'publishing',
  SUBMITTED: 'submitted',
  FAILED: 'failed',
});

const CONTENT_KINDS = new Set(['post', 'video', 'combined']);
const CONTENT_STATUSES = new Set(Object.values(CONTENT_STATUS));

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('now must produce a valid date');
  return date.toISOString();
}

function copy(value) {
  return value == null ? null : structuredClone(value);
}

export function createContent(input, options = {}) {
  if (!input || typeof input !== 'object') throw new Error('content must be an object');
  const kind = String(input.kind || '').trim();
  if (!CONTENT_KINDS.has(kind)) throw new Error('content kind must be post, video, or combined');
  const title = String(input.title || '').trim();
  if (!title) throw new Error('content title is required');

  const now = options.now || (() => new Date());
  const createdAt = timestamp(now());
  const channels = Array.isArray(input.channels)
    ? input.channels
    : Array.isArray(input.brief?.channels) ? input.brief.channels : [];

  return {
    id: options.id || createId('cnt'),
    kind,
    title,
    status: CONTENT_STATUS.AWAITING_REVIEW,
    channels: [...new Set(channels.map(String).filter(Boolean))],
    brief: copy(input.brief),
    media: copy(input.media),
    render: null,
    quality: null,
    publication: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function updateContent(content, patch, now = () => new Date()) {
  if (!content || !content.id) throw new Error('existing content is required');
  if (!patch || typeof patch !== 'object') throw new Error('content patch must be an object');
  if (patch.status != null && !CONTENT_STATUSES.has(patch.status)) throw new Error('unsupported content status');
  if (patch.title != null && !String(patch.title).trim()) throw new Error('content title is required');

  const candidate = timestamp(now());
  const minimum = new Date(Date.parse(content.updatedAt) + 1).toISOString();
  return {
    ...content,
    ...copy(patch),
    id: content.id,
    title: patch.title == null ? content.title : String(patch.title).trim(),
    createdAt: content.createdAt,
    updatedAt: candidate > content.updatedAt ? candidate : minimum,
  };
}
