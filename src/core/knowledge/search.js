/**
 * Keyword + tag recall over the knowledge index. No embeddings, no network.
 * Rank: exact id/slug, tag hit, title token, body excerpt token.
 */

function tokenize(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function haystack(entry) {
  return {
    id: String(entry.id ?? '').toLowerCase(),
    title: String(entry.title ?? '').toLowerCase(),
    tags: (entry.tags ?? []).map((tag) => String(tag).toLowerCase()),
    skills: (entry.skills ?? []).map((skill) => String(skill).toLowerCase()),
    excerpt: String(entry.excerpt ?? '').toLowerCase(),
    domain: String(entry.domain ?? '').toLowerCase(),
    kind: String(entry.kind ?? '').toLowerCase(),
  };
}

function scoreEntry(entry, tokens) {
  if (tokens.length === 0) return 0;
  const field = haystack(entry);
  let score = 0;
  for (const token of tokens) {
    if (field.id === token || field.domain === token) score += 8;
    else if (field.id.includes(token) || field.domain.includes(token)) score += 5;
    if (field.tags.some((tag) => tag === token || tag.includes(token))) score += 6;
    if (field.skills.some((skill) => skill === token || skill.includes(token))) score += 4;
    if (field.title === token) score += 6;
    else if (field.title.includes(token)) score += 3;
    if (field.excerpt.includes(token)) score += 1;
    if (token !== 'node' && field.kind === token) score += 2;
  }
  return score;
}

/**
 * @param {{entries?:Array<object>}|Array<object>} index
 * @param {string} query
 * @param {{limit?:number, kind?:string, domain?:string}} [opts]
 */
export function searchIndex(index, query, opts = {}) {
  const entries = Array.isArray(index) ? index : (index?.entries ?? []);
  const tokens = tokenize(query);
  const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
  const filtered = entries.filter((entry) => {
    if (opts.kind && entry.kind !== opts.kind) return false;
    if (opts.domain && entry.domain !== opts.domain) return false;
    return true;
  });
  if (tokens.length === 0) return [];
  return filtered
    .map((entry) => ({ ...entry, score: scoreEntry(entry, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)))
    .slice(0, limit);
}

export function tokenizeQuery(query) {
  return tokenize(query);
}
