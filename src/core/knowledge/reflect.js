import { slugify } from './markdown.js';

const SIGNAL =
  /\b(always|never|prefer|remember|we (?:do|don't|did)|암묵|항상|절대|선호|기억)\b/i;

/**
 * Propose tacit notes from a finished turn. Heuristic only — the operator
 * accepts via `toris knowledge reflect --write` or chat `/reflect accept`.
 * Silent writes are intentionally not a thing.
 *
 * @param {{user?:string, assistant?:string, history?:Array<{role:string,content:string}>, domain?:string}} input
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
    return {
      notable: false,
      reason: 'Turn is too short to promote as tacit knowledge.',
      proposals: [],
    };
  }

  const sentences = blob
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((line) => line.replace(/^\[knowledge context\][\s\S]*?\[\/knowledge context\]\s*/i, '').trim())
    .filter((line) => line.length >= 24 && line.length <= 400);

  const hits = sentences.filter((line) => SIGNAL.test(line));
  const pool = hits.length > 0 ? hits : sentences.slice(-4);
  const domain = input.domain || guessDomain(blob);
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

function titleFrom(line) {
  const cleaned = line.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
  const cut = cleaned.slice(0, 72);
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

function guessDomain(blob) {
  const lower = blob.toLowerCase();
  if (/\b(seo|geo|listing|aso|llms\.txt)\b/.test(lower)) return 'product-growth';
  if (/\bflutter\b/.test(lower)) return 'flutter-android';
  if (/\bexpo\b/.test(lower)) return 'expo-android';
  if (/\b(toris|autonomy|receipt|design mode)\b/.test(lower)) return 'toris-ops';
  if (/\b(수익|1인|solo|revenue)\b/.test(lower)) return 'solo-revenue';
  return null;
}

/**
 * Format proposals for a CLI or chat `/reflect` display.
 */
export function renderReflection(result) {
  if (!result.notable) return result.reason;
  const blocks = result.proposals.map((item, index) => {
    const domain = item.domain ? ` domain=${item.domain}` : '';
    return `${index + 1}. ${item.title}${domain}\n${item.body}`;
  });
  return [`${result.reason}`, '', ...blocks, '', 'Accept with `toris knowledge reflect --write` or `/reflect accept`.'].join(
    '\n',
  );
}
