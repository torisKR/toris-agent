import { EDGE_KINDS } from '../core/knowledge/index.js';
import { HttpError } from './http.js';

function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

function optionalTarget(input) {
  return text(input.target ?? input.to ?? input.link);
}

/**
 * Node kind the store writes, plus DAG edge kinds `link()` already accepts.
 * Anything else is rejected before disk changes.
 */
export function acceptedKnowledgeKinds() {
  return ['node', ...EDGE_KINDS];
}

export function normalizeKnowledgeWriteKind(kind) {
  if (kind == null || text(kind) === '') return { nodeKind: 'node', edgeKind: 'supports' };
  const value = text(kind).toLowerCase();
  if (value === 'node') return { nodeKind: 'node', edgeKind: 'supports' };
  if (EDGE_KINDS.includes(value)) return { nodeKind: 'node', edgeKind: value };
  throw new HttpError(
    400,
    `Unknown kind "${kind}". Use one of: ${acceptedKnowledgeKinds().join(', ')}.`,
  );
}

async function requireDomain(store, slug) {
  try {
    return await store.inspectDomain(slug);
  } catch (error) {
    if (error.code === 'E_UNKNOWN_DOMAIN') throw new HttpError(404, error.message);
    throw error;
  }
}

/**
 * Opt-in Studio write: one `addNode`, and one `link` only when a target id
 * already exists in that domain. Validates kind and target before writing.
 */
export async function addStudioKnowledgeNode(store, slug, input = {}) {
  const domain = await requireDomain(store, slug);
  const { edgeKind } = normalizeKnowledgeWriteKind(input.kind);
  const target = optionalTarget(input);

  if (target && !domain.nodes.some((node) => node.id === target)) {
    throw new HttpError(400, `Unknown node "${domain.slug}/${target}".`);
  }

  let node;
  try {
    node = await store.addNode(domain.slug, {
      id: text(input.id) || undefined,
      title: text(input.title),
      tags: input.tags,
      body: text(input.body),
    });
  } catch (error) {
    if (error.code === 'E_NODE_EXISTS') throw new HttpError(409, error.message);
    if (error.code === 'E_UNKNOWN_DOMAIN') throw new HttpError(404, error.message);
    throw new HttpError(400, error.message);
  }

  let edge = null;
  if (target) {
    const linked = await store.link(domain.slug, { from: node.id, to: target, kind: edgeKind });
    edge = linked.added;
  }

  return { ...node, written: true, edge };
}

/**
 * Opt-in Studio write: one `updateNode` for title and/or body. Kind and id
 * stay as stored. Empty title / unknown domain / unknown node write nothing.
 */
export async function updateStudioKnowledgeNode(store, slug, nodeId, input = {}) {
  const domain = await requireDomain(store, slug);
  if (Object.hasOwn(input, 'title') && !text(input.title)) {
    throw new HttpError(400, 'Title is required.');
  }
  try {
    const node = await store.updateNode(domain.slug, nodeId, {
      title: Object.hasOwn(input, 'title') ? text(input.title) : undefined,
      body: Object.hasOwn(input, 'body') ? String(input.body ?? '') : undefined,
      source: domain.source,
    });
    return { ...node, written: true };
  } catch (error) {
    if (error.code === 'E_UNKNOWN_NODE' || error.code === 'E_UNKNOWN_DOMAIN') {
      throw new HttpError(404, error.message);
    }
    throw new HttpError(400, error.message);
  }
}

/**
 * Opt-in Studio write: one `removeNode`. Unknown domain / node are 404 and
 * the store does not write.
 */
export async function removeStudioKnowledgeNode(store, slug, nodeId) {
  const domain = await requireDomain(store, slug);
  try {
    return await store.removeNode(domain.slug, nodeId, domain.source);
  } catch (error) {
    if (error.code === 'E_UNKNOWN_NODE' || error.code === 'E_UNKNOWN_DOMAIN') {
      throw new HttpError(404, error.message);
    }
    throw new HttpError(400, error.message);
  }
}
