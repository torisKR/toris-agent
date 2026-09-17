import { slugify } from './markdown.js';

const SIGNAL =
  /\b(always|never|prefer|remember|we (?:do|don't|did)|암묵|항상|절대|선호|기억)\b/i;

const STARTER_HINTS = [
  { slug: 'product-growth', pattern: /\b(seo|geo|listing|aso|llms\.txt)\b/i },
  { slug: 'flutter-android', pattern: /\bflutter\b/i },
  { slug: 'expo-android', pattern: /\bexpo\b/i },
  { slug: 'toris-ops', pattern: /\b(toris|autonomy|receipt|design mode)\b/i },
  { slug: 'solo-revenue', pattern: /\b(수익|1인|solo|revenue)\b/i },
];

/**
 * Propose tacit notes from a finished turn. Heuristic only — the operator
 * accepts via `toris knowledge reflect --write` or chat `/reflect accept`.
 * Silent writes are intentionally not a thing.
 *
 * @param {{user?:string, assistant?:string, history?:Array<{role:string,content:string}>, domain?:string, domains?:object[]}} input
 */
export function proposeReflections(input = {}) {
  const turns = [];
  if (Array.isArray(input.history)) {
    for (const item of input.history) {
      if (item?.role === 'user' || item?.role === 'assistant') {
        turns.push({ role: item.role, content: String(item.content ?? '') });
      }
    }
  }
  if (input.user) turns.push({ role: 'user', content: String(input.user) });
  if (input.assistant) turns.push({ role: 'assistant', content: String(input.assistant) });

  const blob = turns.map((turn) => turn.content).join('\n');
  if (blob.trim().length < 80) {
    return emptyReflection('Turn is too short to promote as tacit knowledge.');
  }

  const sentences = blob
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((line) => line.replace(/^\[knowledge context\][\s\S]*?\[\/knowledge context\]\s*/i, '').trim())
    .filter((line) => line.length >= 24 && line.length <= 400);

  const hits = sentences.filter((line) => SIGNAL.test(line));
  const pool = hits.length > 0 ? hits : sentences.slice(-4);
  const domain = input.domain || guessDomain(blob, input.domains);
  const proposals = [];
  const seen = new Set();
  for (const line of pool) {
    const title = titleFrom(line);
    const id = slugify(title, 'tacit-note');
    if (seen.has(id)) continue;
    seen.add(id);
    proposals.push({
      id,
      title,
      domain,
      tags: ['tacit', 'reflect'],
      body: [
        `# ${title}`,
        '',
        line,
        '',
        'Captured from a successful turn. Edit before promoting if the wording is too specific.',
      ].join('\n'),
    });
    if (proposals.length >= 3) break;
  }

  return {
    notable: proposals.length > 0,
    reason:
      proposals.length > 0
        ? 'Propose a tacit note the operator can accept. Do not write it silently.'
        : 'Nothing durable enough to save.',
    proposals,
  };
}

export function emptyReflection(reason, extras = {}) {
  return { notable: false, reason, proposals: [], ...extras };
}

export function titleFrom(line) {
  const cleaned = String(line ?? '')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = cleaned.slice(0, 72);
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/** True only when checks ran and passed. Unverified or failed is not a win. */
export function isVerifiedSuccess(receiptOrRun) {
  return receiptOrRun?.verification?.passed === true;
}

/**
 * Guess a starter or installed pack from keywords, then from pack tags/titles.
 * @param {string} blob
 * @param {Array<{slug?:string,title?:string,tags?:string[]|string,when?:string}>} [domains]
 */
export function guessDomain(blob, domains = []) {
  const lower = String(blob ?? '').toLowerCase();
  const heuristic = STARTER_HINTS.find((item) => item.pattern.test(lower))?.slug ?? null;
  if (heuristic && (!domains.length || domains.some((item) => item.slug === heuristic))) {
    return heuristic;
  }
  let best = null;
  let bestScore = 0;
  for (const domain of domains) {
    const score = domainMatchScore(lower, domain);
    if (score > bestScore) {
      best = domain.slug;
      bestScore = score;
    }
  }
  return best || heuristic || null;
}

function domainMatchScore(lower, domain) {
  if (!domain?.slug) return 0;
  let score = 0;
  const slug = String(domain.slug).toLowerCase();
  if (lower.includes(slug) || lower.includes(slug.replace(/-/g, ' '))) score += 3;
  const tags = Array.isArray(domain.tags)
    ? domain.tags
    : String(domain.tags ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  for (const tag of tags) {
    const token = String(tag).toLowerCase();
    if (token.length >= 3 && lower.includes(token)) score += 2;
  }
  const extra = `${domain.title ?? ''} ${domain.when ?? ''}`.toLowerCase();
  for (const word of extra.split(/[^a-z0-9가-힣]+/).filter((item) => item.length >= 4)) {
    if (lower.includes(word)) score += 1;
  }
  return score;
}

/**
 * Format proposals for a CLI or chat `/reflect` display.
 */
export function renderReflection(result) {
  if (!result?.notable) return result?.reason ?? 'Nothing to propose.';
  const runId = result.source?.runId;
  const accept = runId
    ? `Accept with \`toris knowledge reflect ${runId} --write\` or \`/reflect accept\`.`
    : 'Accept with `toris knowledge reflect --write` or `/reflect accept`.';
  const blocks = result.proposals.map((item, index) => {
    const domain = item.domain ? ` domain=${item.domain}` : '';
    return `${index + 1}. ${item.title}${domain}\n${item.body}`;
  });
  return [`${result.reason}`, '', ...blocks, '', accept].join('\n');
}
