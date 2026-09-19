import { TorisError } from '../errors.js';

/** Directed relations a domain may record between node ids. */
export const EDGE_KINDS = Object.freeze(['prerequisite', 'supports', 'conflicts', 'derived-from']);

/**
 * Kinds that imply an order. `conflicts` is recorded as a directed edge for
 * editability but does not participate in topological / cycle checks, so
 * A↔B conflict pairs stay legal.
 */
export const ORDERING_KINDS = Object.freeze(['prerequisite', 'supports', 'derived-from']);

export function normalizeEdgeKind(kind) {
  const value = String(kind ?? 'supports').trim().toLowerCase();
  if (!EDGE_KINDS.includes(value)) {
    throw new TorisError(
      `Unknown DAG edge kind "${kind}". Use one of: ${EDGE_KINDS.join(', ')}.`,
      'E_INVALID_DAG',
    );
  }
  return value;
}

export function normalizeEdge(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new TorisError('DAG edge must be an object with from, to, kind.', 'E_INVALID_DAG');
  }
  const from = String(raw.from ?? '').trim();
  const to = String(raw.to ?? '').trim();
  if (!from || !to) throw new TorisError('DAG edge needs from and to node ids.', 'E_INVALID_DAG');
  return Object.freeze({
    from,
    to,
    kind: normalizeEdgeKind(raw.kind),
  });
}

export function parseDagDocument(raw) {
  if (raw == null || raw === '') return { edges: [] };
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TorisError('dag.json is not valid JSON.', 'E_INVALID_DAG');
    }
  }
  const list = Array.isArray(parsed) ? parsed : parsed.edges;
  if (!Array.isArray(list)) {
    throw new TorisError('dag.json must be { "edges": [...] }.', 'E_INVALID_DAG');
  }
  return { edges: list.map(normalizeEdge) };
}

export function renderDagDocument(edges) {
  return `${JSON.stringify({ edges: edges.map(normalizeEdge) }, null, 2)}\n`;
}

function adjacency(edges, kinds = ORDERING_KINDS) {
  const allowed = new Set(kinds);
  const map = new Map();
  for (const edge of edges) {
    if (!allowed.has(edge.kind)) continue;
    if (!map.has(edge.from)) map.set(edge.from, []);
    map.get(edge.from).push(edge.to);
  }
  return map;
}

/** True when `start` can reach `goal` following ordering edges. */
export function canReach(edges, start, goal) {
  if (start === goal) return true;
  const graph = adjacency(edges);
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of graph.get(node) ?? []) {
      if (next === goal) return true;
      stack.push(next);
    }
  }
  return false;
}

/**
 * Directed cycles among ordering edges. Returns [] when the graph is a DAG.
 * Each cycle is a list of node ids that walk back to the first.
 */
export function detectCycles(edges) {
  const graph = adjacency(edges);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const parent = new Map();
  const cycles = [];

  const visit = (node) => {
    color.set(node, GRAY);
    for (const next of graph.get(node) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        const path = [next, node];
        let cursor = node;
        while (cursor !== next && parent.has(cursor)) {
          cursor = parent.get(cursor);
          path.push(cursor);
        }
        path.reverse();
        cycles.push(path);
        continue;
      }
      if (state === WHITE) {
        parent.set(next, node);
        visit(next);
      }
    }
    color.set(node, BLACK);
  };

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }
  return cycles;
}

export function wouldCreateCycle(edges, from, to, kind = 'supports') {
  if (!ORDERING_KINDS.includes(normalizeEdgeKind(kind))) return false;
  if (from === to) return true;
  return canReach(edges, to, from);
}

/**
 * Append an edge, refusing ordering cycles and exact duplicates.
 * @returns {ReadonlyArray<{from:string,to:string,kind:string}>}
 */
export function addDagEdge(edges, input) {
  const edge = normalizeEdge(input);
  if (edge.from === edge.to) {
    throw new TorisError(`Cannot link ${edge.from} to itself.`, 'E_DAG_CYCLE');
  }
  const current = edges.map(normalizeEdge);
  if (current.some((item) => item.from === edge.from && item.to === edge.to && item.kind === edge.kind)) {
    throw new TorisError(
      `Edge ${edge.from} -[${edge.kind}]-> ${edge.to} already exists.`,
      'E_DAG_DUPLICATE',
    );
  }
  if (wouldCreateCycle(current, edge.from, edge.to, edge.kind)) {
    throw new TorisError(
      `Linking ${edge.from} -[${edge.kind}]-> ${edge.to} would create a cycle.`,
      'E_DAG_CYCLE',
    );
  }
  return Object.freeze([...current, edge]);
}

function sameEdge(left, right) {
  return left.from === right.from && left.to === right.to && left.kind === right.kind;
}

/**
 * Drop exactly one matching `{ from, to, kind }` edge. Missing match throws
 * before the caller writes. Duplicate matches drop the first only.
 * @returns {ReadonlyArray<{from:string,to:string,kind:string}>}
 */
export function removeDagEdge(edges, input) {
  const edge = normalizeEdge(input);
  const current = edges.map(normalizeEdge);
  const index = current.findIndex((item) => sameEdge(item, edge));
  if (index === -1) {
    throw new TorisError(
      `Unknown edge ${edge.from} -[${edge.kind}]-> ${edge.to}.`,
      'E_UNKNOWN_EDGE',
    );
  }
  return Object.freeze([...current.slice(0, index), ...current.slice(index + 1)]);
}
