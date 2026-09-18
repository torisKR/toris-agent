const EXCERPT_LIMIT = 180;

/** Compact a node body for the Studio DAG panel. Not a second store. */
export function excerptBody(body, size = EXCERPT_LIMIT) {
  const compact = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '';
  return compact.length <= size ? compact : `${compact.slice(0, size - 1)}…`;
}

function publicNode(node) {
  return {
    id: node.id,
    title: node.title || node.id,
    kind: node.kind || 'node',
    excerpt: excerptBody(node.body),
  };
}

function publicEdge(edge) {
  return { from: edge.from, to: edge.to, kind: edge.kind };
}

/**
 * Slim inspectDomain() to the read-only DAG view: nodes (title/kind/excerpt)
 * and directed edges. Drops tacit, paths, and full markdown bodies.
 */
export function presentKnowledgeDag(domain) {
  const nodes = (domain?.nodes ?? []).map(publicNode);
  const known = new Set(nodes.map((node) => node.id));
  const edges = (domain?.edges ?? [])
    .filter((edge) => known.has(edge.from) && known.has(edge.to))
    .map(publicEdge);
  return {
    ok: true,
    slug: domain?.slug ?? '',
    title: domain?.title || domain?.slug || '',
    source: domain?.source || 'home',
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

/** GET helper. Reads the existing KnowledgeStore. Never calls init(). */
export async function loadKnowledgeDag(store, slug) {
  return presentKnowledgeDag(await store.inspectDomain(slug));
}
