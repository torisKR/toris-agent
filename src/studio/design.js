/**
 * Design Mode captures: a picked DOM element becomes evidence the coding
 * agent can edit against. Pure helpers so Studio, the picker, and tests share
 * one shape. No browser APIs here.
 */

export const DESIGN_HTML_LIMIT = 24_000;
export const DESIGN_SELECTOR_LIMIT = 500;
export const DESIGN_STYLE_VALUE_LIMIT = 240;
export const DESIGN_SCREENSHOT_CHAR_LIMIT = 180_000;
export const DESIGN_TEXT_LIMIT = 400;
export const DESIGN_NOTE_LIMIT = 800;
export const DESIGN_ANNOTATION_LIMIT = 12;

export const DESIGN_STYLE_KEYS = Object.freeze([
  'color',
  'backgroundColor',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'padding',
  'margin',
  'border',
  'borderRadius',
  'width',
  'height',
  'display',
  'position',
  'gap',
  'flexDirection',
  'justifyContent',
  'alignItems',
  'opacity',
  'boxShadow',
]);

export function assertSafeHttpUrl(value, label = 'url') {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new Error(`${label} must be an http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must be an http(s) URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not include credentials`);
  }
  if (!parsed.hostname) throw new Error(`${label} must include a hostname`);
  return parsed;
}

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
}

function boundStyleMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const key of DESIGN_STYLE_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value == null) continue;
    out[key] = clip(value, DESIGN_STYLE_VALUE_LIMIT);
  }
  return out;
}

function boundRect(input) {
  if (!input || typeof input !== 'object') return null;
  const num = (key) => {
    const value = Number(input[key]);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    x: num('x'),
    y: num('y'),
    width: num('width'),
    height: num('height'),
  };
}

function boundScreenshot(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > DESIGN_SCREENSHOT_CHAR_LIMIT) return null;
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=\s]+$/.test(value)) return null;
  return value;
}

/**
 * CSS path from a DOM-like node `{nodeType, tagName, id, parentElement, children}`.
 * Stops at a stable id so the selector stays short and pasteable.
 */
export function buildCssPath(node) {
  if (!node || node.nodeType !== 1) return '';
  const parts = [];
  let current = node;
  while (current && current.nodeType === 1) {
    const tag = String(current.tagName || '').toLowerCase();
    if (!tag || tag === 'html') {
      if (tag === 'html') parts.unshift('html');
      break;
    }
    const id = typeof current.id === 'string' ? current.id : '';
    if (id && /^[A-Za-z][\w-]*$/.test(id)) {
      parts.unshift(`#${id}`);
      break;
    }
    const parent = current.parentElement;
    if (!parent || !Array.isArray(parent.children)) {
      parts.unshift(tag);
      break;
    }
    const siblings = parent.children.filter(
      (child) => child && String(child.tagName).toLowerCase() === tag,
    );
    if (siblings.length <= 1) parts.unshift(tag);
    else parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
    current = parent;
  }
  return parts.join(' > ').slice(0, DESIGN_SELECTOR_LIMIT);
}

/**
 * Coerce a picker payload into the bounded record the agent turn consumes.
 * Unknown keys are dropped. Invalid URLs throw.
 */
export function normalizeDesignCapture(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const parsed = assertSafeHttpUrl(raw.url || raw.pageUrl, 'page URL');
  const screenshotDataUrl = boundScreenshot(raw.screenshotDataUrl || raw.screenshot);
  return {
    url: parsed.href,
    selector: clip(raw.selector ?? '', DESIGN_SELECTOR_LIMIT).trim(),
    outerHTML: clip(raw.outerHTML ?? '', DESIGN_HTML_LIMIT),
    computedStyle: boundStyleMap(raw.computedStyle || raw.styles),
    text: clip(raw.text ?? raw.textPreview ?? '', DESIGN_TEXT_LIMIT).trim(),
    note: clip(raw.note ?? '', DESIGN_NOTE_LIMIT).trim(),
    tagName: String(raw.tagName ?? '').toLowerCase().slice(0, 32),
    rect: boundRect(raw.rect),
    screenshotDataUrl,
  };
}

export function clipDesignNote(value) {
  return clip(value ?? '', DESIGN_NOTE_LIMIT).trim();
}

export function listDesignCaptures(capture) {
  if (!capture) return [];
  return (Array.isArray(capture) ? capture : [capture]).filter(Boolean).slice(0, DESIGN_ANNOTATION_LIMIT);
}

/** Markdown block prepended to a Studio agent turn. */
export function formatDesignContext(capture, { index, total } = {}) {
  const record = capture?.url ? capture : normalizeDesignCapture(capture);
  const styles = Object.entries(record.computedStyle || {})
    .map(([key, value]) => `  ${key}: ${value}`)
    .join('\n');
  const heading = index
    ? `### ${index}${total ? `/${total}` : ''} ${record.selector || record.tagName || 'element'}`
    : '## Design Mode attachment';
  const lines = [
    heading,
    `Page: ${record.url}`,
    record.selector ? `Selector: ${record.selector}` : null,
    record.tagName ? `Tag: <${record.tagName}>` : null,
    record.rect
      ? `Box: ${Math.round(record.rect.width)}×${Math.round(record.rect.height)} at (${Math.round(record.rect.x)}, ${Math.round(record.rect.y)})`
      : null,
    record.screenshotPath ? `Screenshot: ${record.screenshotPath}` : null,
    record.text ? `Text: ${record.text}` : null,
    record.note ? `Operator note: ${record.note}` : null,
    styles ? `Computed styles:\n${styles}` : null,
    record.outerHTML ? `outerHTML:\n\`\`\`html\n${record.outerHTML}\n\`\`\`` : null,
    index
      ? null
      : 'Treat this as evidence of the live UI. Edit the source that produced this element. Do not claim a visual fix without matching these styles and structure.',
  ];
  return lines.filter((line) => line != null && line !== '').join('\n');
}

export function composeDesignTurnMessage(message, capture) {
  const text = String(message ?? '').trim();
  const captures = listDesignCaptures(capture);
  if (captures.length === 0) return text;
  const context = captures.length === 1
    ? formatDesignContext(captures[0])
    : [
        `## Design Mode attachments (${captures.length})`,
        ...captures.map((item, index) => formatDesignContext(item, { index: index + 1, total: captures.length })),
        'Treat these as evidence of the live UI. Edit the source that produced each element. Do not claim a visual fix without matching these styles and structure.',
      ].join('\n\n');
  return text ? `${text}\n\n${context}` : context;
}

/** Bookmarklet that injects the picker into the operator's current tab. */
export function buildBookmarklet(origin) {
  const studio = assertSafeHttpUrl(origin, 'studio origin').origin;
  const src = JSON.stringify(`${studio}/assets/design-picker.js`);
  const studioJson = JSON.stringify(studio);
  return (
    'javascript:void((function(){var s=document.createElement("script");s.src=' +
    src +
    ';s.dataset.studio=' +
    studioJson +
    ';s.dataset.mode="bookmarklet";document.documentElement.appendChild(s);}()))'
  );
}

export function stripDocumentCsp(html) {
  return String(html ?? '').replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    '',
  );
}

export function injectPickerMarkup(html, { pickerSrc = '/assets/design-picker.js', baseHref } = {}) {
  const source = stripDocumentCsp(html);
  const tags = [
    baseHref
      ? `<base href="${String(baseHref).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}">`
      : '',
    `<script src="${pickerSrc}" data-toris-design="1"></script>`,
  ]
    .filter(Boolean)
    .join('\n');
  if (/<head[\s>]/i.test(source)) {
    return source.replace(/<head([^>]*)>/i, `<head$1>\n${tags}\n`);
  }
  return `${tags}\n${source}`;
}
