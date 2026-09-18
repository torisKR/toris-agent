import { excerptBody } from './knowledge-dag.js';
import { HttpError } from './http.js';

/**
 * Optional pin on POST /api/agent/turn: { knowledge: { domain, nodeId } }.
 * Omitted / null is "no pin". A present object with a missing id is 400.
 */
export function knowledgePinOf(input = {}) {
  if (!Object.hasOwn(input, 'knowledge') || input.knowledge == null) return null;
  const raw = input.knowledge;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'knowledge pin must be { domain, nodeId }');
  }
  const domain = String(raw.domain ?? raw.slug ?? '').trim();
  const nodeId = String(raw.nodeId ?? raw.id ?? raw.node ?? '').trim();
  if (!domain || !nodeId) {
    throw new HttpError(400, 'knowledge pin requires domain and nodeId');
  }
  return { domain, nodeId };
}

/**
 * Load one domain node for a pin. Title / kind / excerpt only — never invents
 * text for a missing id. Read-only: does not call init() or write.
 */
export async function loadPinnedKnowledge(store, pin) {
  const ref = knowledgePinOf({ knowledge: pin });
  if (!ref) throw new HttpError(400, 'knowledge pin requires domain and nodeId');
  let domain;
  try {
    domain = await store.inspectDomain(ref.domain);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `Unknown node "${ref.domain}/${ref.nodeId}".`);
  }
  const node = (domain.nodes || []).find((item) => item.id === ref.nodeId);
  if (!node) throw new HttpError(400, `Unknown node "${ref.domain}/${ref.nodeId}".`);
  return {
    id: node.id,
    title: node.title || node.id,
    kind: node.kind || 'node',
    excerpt: excerptBody(node.body),
    domain: domain.slug,
  };
}

/** Markdown block prepended to a Studio agent turn — title, kind, excerpt only. */
export function composePinnedKnowledgeTurn(message, node) {
  const text = String(message ?? '');
  if (!node) return text;
  const excerpt = node.excerpt == null ? excerptBody(node.body) : node.excerpt;
  const lines = [
    '[pinned knowledge]',
    `title: ${node.title || node.id}`,
    `kind: ${node.kind || 'node'}`,
    excerpt ? `excerpt: ${excerpt}` : null,
    '[/pinned knowledge]',
  ].filter((line) => line != null);
  const block = lines.join('\n');
  return text ? `${block}\n\n${text}` : block;
}
