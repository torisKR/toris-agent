import { TorisError } from '../errors.js';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Minimal `key: value` frontmatter. Same spirit as skills: not a YAML engine.
 * Lists may be comma-separated (`tags: seo, listing`).
 */
export function parseFrontmatter(text, source = 'markdown') {
  const match = FRONTMATTER.exec(String(text ?? ''));
  if (!match) return { meta: {}, body: String(text ?? '').trim() };
  const meta = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(':');
    if (at === -1) {
      throw new TorisError(
        `${source} frontmatter line is not "key: value": ${trimmed}`,
        'E_INVALID_KNOWLEDGE',
      );
    }
    const key = trimmed.slice(0, at).trim();
    const value = trimmed
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

/** Serialize a knowledge markdown file with a stable key order. */
export function renderFrontmatter(meta, body) {
  const keys = Object.keys(meta).filter((key) => meta[key] != null && meta[key] !== '');
  const block = keys.map((key) => `${key}: ${Array.isArray(meta[key]) ? meta[key].join(', ') : meta[key]}`);
  return `---\n${block.join('\n')}\n---\n\n${String(body ?? '').trim()}\n`;
}

export function splitTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value
    .split(/[,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Filesystem-safe slug. ASCII preferred; Hangul is kept so Korean domain names
 * stay readable. Everything else becomes a hyphen.
 */
export function slugify(value, fallback = 'node') {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

export function isSafeSlug(value) {
  return typeof value === 'string' && /^[a-z0-9가-힣][a-z0-9가-힣-]{0,63}$/.test(value);
}

export function requireSlug(value, label = 'slug') {
  const slug = slugify(value, '');
  if (!isSafeSlug(slug)) {
    throw new TorisError(`Invalid ${label} "${value}". Use letters, numbers, and hyphens.`, 'E_INVALID_KNOWLEDGE');
  }
  return slug;
}
