import { matchDomains, renderKnowledgeBriefing } from './context.js';
import { searchIndex } from './search.js';

/** Tight defaults: enough for a few nodes + tacit, not a dump of the store. */
export const DEFAULT_RETRIEVE_BUDGET = Object.freeze({
  maxChars: 3_600,
  maxNodes: 4,
  maxTacit: 2,
  maxDomains: 3,
  historyTurns: 2,
  nodeChars: 640,
  tacitChars: 480,
});

const PREFERRED_KINDS = new Set(['node', 'tacit']);

export function knowledgeAutoRetrieveEnabled(config = {}, flags = {}) {
  if (flags['no-knowledge'] === true) return false;
  return config.knowledge?.autoRetrieve !== false;
}

export function stripKnowledgeContext(text) {
  return String(text ?? '')
    .replace(/^\[knowledge context\][\s\S]*?\[\/knowledge context\]\s*/i, '')
    .trim();
}

/**
 * Search blob for this turn: the new user message plus recent user turns
 * (already-injected context blocks are stripped so they do not self-match).
 */
export function retrievalQuery(message, history = [], { turns = DEFAULT_RETRIEVE_BUDGET.historyTurns } = {}) {
  const current = stripKnowledgeContext(message);
  const recent = (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === 'user')
    .map((item) => stripKnowledgeContext(item.content))
    .filter((text) => text && text !== current)
    .slice(-Math.max(0, turns));
  return [current, ...recent].filter(Boolean).join(' ').trim();
}

function clip(text, size) {
  const value = String(text ?? '').trim();
  if (value.length <= size) return value;
  return `${value.slice(0, Math.max(0, size - 1)).trimEnd()}…`;
}

function budgetOf(input = {}) {
  return { ...DEFAULT_RETRIEVE_BUDGET, ...input };
}

function emptyResult({ enabled = true, query = '', briefing = '' } = {}) {
  return {
    enabled,
    query,
    briefing,
    retrieved: [],
    domains: [],
    chars: briefing.length,
    truncated: false,
  };
}

export function formatKnowledgeReceipt(result) {
  if (!result || result.enabled === false) return '';
  const items = result.retrieved ?? [];
  if (items.length === 0) return '';
  const labels = items.map((item) => (item.domain ? `${item.domain}/${item.id}` : item.id));
  return `knowledge  ${labels.join(' · ')}`;
}

export function publicKnowledgeReceipt(result) {
  if (!result || result.enabled === false) {
    return { autoRetrieve: false, retrieved: [] };
  }
  return {
    autoRetrieve: true,
    query: result.query || '',
    retrieved: (result.retrieved ?? []).map((item) => ({
      kind: item.kind,
      domain: item.domain ?? null,
      id: item.id,
      title: item.title,
      score: item.score,
    })),
    domains: result.domains ?? [],
    chars: result.chars ?? 0,
    truncated: Boolean(result.truncated),
  };
}

function pickHits(hits, kind, limit) {
  return hits.filter((hit) => hit.kind === kind).slice(0, Math.max(0, limit));
}

async function inspectCached(store, cache, slug) {
  if (!slug) return null;
  if (cache.has(slug)) return cache.get(slug);
  try {
    const domain = await store.inspectDomain(slug);
    cache.set(slug, domain);
    return domain;
  } catch {
    cache.set(slug, null);
    return null;
  }
}

function recordFromDomain(domain, hit) {
  if (!domain) return null;
  const list = hit.kind === 'tacit' ? domain.tacit : domain.nodes;
  const found = (list ?? []).find((item) => item.id === hit.id);
  if (!found) return null;
  return { ...found, kind: hit.kind, domain: hit.domain, score: hit.score, title: found.title || hit.title };
}

function relatedEdges(domain, nodeId) {
  return (domain?.edges ?? []).filter((edge) => edge.from === nodeId || edge.to === nodeId);
}

function renderTurnBriefing({ domains, records, budget }) {
  const lines = [
    'Retrieved local secretary knowledge (files under ~/.toris/knowledge).',
    'Prefer these domain nodes and tacit notes over invented facts.',
    'Do not write tacit, USER.md, or MEMORY.md unless the operator accepts.',
  ];
  if (domains.length > 0) {
    lines.push('', 'Relevant domains:');
    for (const domain of domains) {
      const skills = domain.skills?.length ? ` skills: ${domain.skills.join(', ')}` : '';
      lines.push(`- ${domain.slug}: ${domain.title || domain.slug}${skills}`);
      if (domain.when) lines.push(`  when: ${domain.when}`);
      if (domain.anti) lines.push(`  anti-jobs: ${domain.anti}`);
    }
  }
  const nodes = records.filter((item) => item.kind === 'node');
  const tacit = records.filter((item) => item.kind === 'tacit');
  if (nodes.length > 0) {
    lines.push('', 'Domain nodes:');
    for (const node of nodes) {
      lines.push(`### ${node.domain}/${node.id} — ${node.title}`);
      if (node.tags?.length) lines.push(`tags: ${node.tags.join(', ')}`);
      const body = clip(node.body, budget.nodeChars);
      if (body) lines.push(body);
      const dag = relatedEdges(node.inspected, node.id);
      if (dag.length > 0) {
        lines.push(`dag: ${dag.map((edge) => `${edge.from} -[${edge.kind}]-> ${edge.to}`).join('; ')}`);
      }
    }
  }
  if (tacit.length > 0) {
    lines.push('', 'Tacit notes (how we actually do this here):');
    for (const note of tacit) {
      lines.push(`### ${note.domain}/${note.id} — ${note.title}`);
      if (note.tags?.length) lines.push(`tags: ${note.tags.join(', ')}`);
      const body = clip(note.body, budget.tacitChars);
      if (body) lines.push(body);
    }
  }
  return lines.join('\n');
}

function fitBriefing(records, domains, budget) {
  let kept = records
    .slice()
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  let truncated = false;
  let briefing = renderTurnBriefing({ domains, records: kept, budget });
  while (briefing.length > budget.maxChars && kept.length > 0) {
    truncated = true;
    kept = kept.slice(0, -1);
    briefing = renderTurnBriefing({ domains, records: kept, budget });
  }
  if (briefing.length > budget.maxChars) {
    truncated = true;
    briefing = clip(briefing, budget.maxChars);
  }
  return { briefing, kept, truncated };
}

/**
 * Read-only recall for one chat turn. Never writes USER.md, MEMORY.md, nodes,
 * or tacit notes. Below L3 the write tools stay gated separately.
 *
 * @param {import('./store.js').KnowledgeStore} store
 * @param {{query?:string, history?:Array<{role:string, content?:string}>, session?:{activeDomains?:string[]}, includeProfile?:boolean, enabled?:boolean, budget?:object}} [opts]
 */
export async function retrieveForTurn(store, opts = {}) {
  if (opts.enabled === false) return emptyResult({ enabled: false, query: String(opts.query ?? '') });
  const status = await store.status();
  if (!status.ok) return emptyResult({ query: String(opts.query ?? '') });

  const budget = budgetOf(opts.budget);
  const includeProfile = opts.includeProfile === true;
  const query = retrievalQuery(opts.query ?? '', opts.history, { turns: budget.historyTurns });
  const [user, memory, domains, index] = await Promise.all([
    includeProfile ? store.readUser() : Promise.resolve({ text: '' }),
    includeProfile ? store.readMemory() : Promise.resolve({ text: '' }),
    store.listDomains(),
    store.loadIndex(),
  ]);
  const active = opts.session?.activeDomains ?? [];
  const matched = matchDomains(domains, query, { active, limit: budget.maxDomains });
  const hits = query ? searchIndex(index, query, { limit: 24 }) : [];
  const preferred = hits.filter((hit) => PREFERRED_KINDS.has(hit.kind) && hit.domain);
  const selectedHits = [
    ...pickHits(preferred, 'node', budget.maxNodes),
    ...pickHits(preferred, 'tacit', budget.maxTacit),
  ];

  const cache = new Map();
  const records = [];
  for (const hit of selectedHits) {
    const inspected = await inspectCached(store, cache, hit.domain);
    const record = recordFromDomain(inspected, hit);
    if (record) records.push({ ...record, inspected });
  }

  const hasProfile = includeProfile && Boolean(user.text?.trim() || memory.text?.trim());
  if (records.length === 0 && matched.length === 0 && !hasProfile) {
    return emptyResult({ query });
  }

  let kept = records;
  let truncated = false;
  let retrievedBriefing = '';
  if (records.length > 0 || matched.length > 0) {
    ({ briefing: retrievedBriefing, kept, truncated } = fitBriefing(records, matched, budget));
  }

  let briefing = retrievedBriefing;
  if (hasProfile) {
    const profile = renderKnowledgeBriefing({
      user: user.text,
      memory: memory.text,
      domains: retrievedBriefing ? [] : matched,
      hits: [],
    });
    briefing = retrievedBriefing ? `${profile}\n\n${retrievedBriefing}` : profile;
    if (briefing.length > budget.maxChars) {
      truncated = true;
      briefing = clip(briefing, budget.maxChars);
    }
  }

  if (!briefing.trim()) return emptyResult({ query });

  return {
    enabled: true,
    query,
    briefing,
    retrieved: kept.map((item) => ({
      kind: item.kind,
      domain: item.domain,
      id: item.id,
      title: item.title,
      score: item.score,
    })),
    domains: matched.map((domain) => domain.slug),
    chars: briefing.length,
    truncated,
  };
}
