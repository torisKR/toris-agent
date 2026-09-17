import { searchIndex } from './search.js';

const BRIEF_CHARS = 1_200;
const USER_CHARS = 1_400;

/**
 * Pick domains whose slug, title, when, skills, or tags overlap the query.
 */
export function matchDomains(domains, query, { active = [], limit = 3 } = {}) {
  const tokens = String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/i)
    .filter((token) => token.length >= 2);
  const scored = domains.map((domain) => {
    const hay = [domain.slug, domain.title, domain.when, domain.anti, ...(domain.skills ?? []), ...(domain.tags ?? [])]
      .join(' ')
      .toLowerCase();
    let score = active.includes(domain.slug) ? 20 : 0;
    for (const token of tokens) {
      if (domain.slug === token) score += 10;
      else if (hay.includes(token)) score += 3;
    }
    return { ...domain, score };
  });
  return scored
    .filter((domain) => domain.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function clip(text, size) {
  const value = String(text ?? '').trim();
  if (value.length <= size) return value;
  return `${value.slice(0, size - 1).trimEnd()}…`;
}

/**
 * Compact profile / domain-header briefing for the system prompt.
 * Per-turn node + tacit bodies live in retrieveForTurn (auto-retrieve).
 */
export function renderKnowledgeBriefing({ user, memory, domains = [], hits = [] } = {}) {
  const lines = [
    'Local secretary knowledge (plain files under ~/.toris/knowledge).',
    'Search before inventing facts about this operator or their domains.',
    'After a verified successful run, propose a tacit note from the receipt — never write knowledge silently.',
    'Use knowledge_search, memory_get, domain_activate, and (when allowed) knowledge_write.',
  ];
  if (user) lines.push('', 'USER.md (excerpt):', clip(user, USER_CHARS));
  if (memory) lines.push('', 'MEMORY.md (excerpt):', clip(memory, USER_CHARS));
  if (domains.length > 0) {
    lines.push('', 'Relevant domains:');
    for (const domain of domains) {
      const skills = domain.skills?.length ? ` skills: ${domain.skills.join(', ')}` : '';
      lines.push(`- ${domain.slug}: ${domain.title || domain.slug}${skills}`);
      if (domain.when) lines.push(`  when: ${domain.when}`);
      if (domain.anti) lines.push(`  anti-jobs: ${domain.anti}`);
      if (domain.body) lines.push(`  ${clip(domain.body, BRIEF_CHARS)}`);
    }
  }
  if (hits.length > 0) {
    lines.push('', 'Keyword hits:');
    for (const hit of hits.slice(0, 6)) {
      lines.push(`- [${hit.kind}] ${hit.domain ? `${hit.domain}/` : ''}${hit.id} (${hit.score}): ${hit.excerpt || hit.title}`);
    }
  }
  return lines.join('\n');
}

/**
 * Wrap a user message with a knowledge context block the model can see.
 */
export function composeKnowledgeTurn(message, briefing) {
  const text = String(message ?? '');
  if (!briefing) return text;
  return `[knowledge context]\n${briefing}\n[/knowledge context]\n\n${text}`;
}

export async function briefingForQuery(store, query, session = {}, opts = {}) {
  const initialized = (await store.status()).ok;
  if (!initialized) return '';
  const includeProfile = opts.includeProfile !== false;
  const [user, memory, domains, index] = await Promise.all([
    includeProfile ? store.readUser() : Promise.resolve({ text: '' }),
    includeProfile ? store.readMemory() : Promise.resolve({ text: '' }),
    store.listDomains(),
    store.loadIndex(),
  ]);
  const active = session.activeDomains ?? [];
  const matched = matchDomains(domains, query, { active });
  const hits = String(query ?? '').trim() ? searchIndex(index, query, { limit: 6 }) : [];
  if (
    matched.length === 0 &&
    hits.length === 0 &&
    !(includeProfile && user.text?.trim()) &&
    active.length === 0
  ) {
    return includeProfile ? renderKnowledgeBriefing({ user: user.text, memory: memory.text }) : '';
  }
  return renderKnowledgeBriefing({
    user: includeProfile ? user.text : '',
    memory: includeProfile ? memory.text : '',
    domains: matched,
    hits,
  });
}
