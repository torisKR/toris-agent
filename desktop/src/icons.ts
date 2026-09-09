// Inline SVG icons (stroke-based, currentColor). Keyed by the `icon` field the
// backend presets use, plus a few UI glyphs. No icon-font dependency.

const S = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS: Record<string, string> = {
  sparkles: S(
    '<path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z"/>',
  ),
  mail: S('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
  calendar: S(
    '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  ),
  megaphone: S(
    '<path d="M3 11v2a1 1 0 001 1h2l9 5V5L6 10H4a1 1 0 00-1 1z"/><path d="M18 8a4 4 0 010 8"/>',
  ),
  document: S(
    '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  ),
  code: S('<path d="M16 18l4-6-4-6M8 6l-4 6 4 6M14 4l-4 16"/>'),
  receipt: S(
    '<path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1-2-1z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  ),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  send: S('<path d="M4 12l16-8-6 16-3-6-7-2z"/>'),
  trash: S(
    '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  ),
  settings: S(
    '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 12a7.4 7.4 0 00-.1-1.1l2-1.6-2-3.4-2.4 1a7.2 7.2 0 00-1.9-1.1l-.4-2.6H9.4L9 5.8a7.2 7.2 0 00-1.9 1.1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.2l-2 1.6 2 3.4 2.4-1a7.2 7.2 0 001.9 1.1l.4 2.6h5.2l.4-2.6a7.2 7.2 0 001.9-1.1l2.4 1 2-3.4-2-1.6c.1-.4.1-.7.1-1.1z"/>',
  ),
  stop: S('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  check: S('<path d="M20 6L9 17l-5-5"/>'),
  x: S('<path d="M18 6L6 18M6 6l12 12"/>'),
  tool: S(
    '<path d="M14.5 5.5a3.5 3.5 0 00-4.9 4.2L3 16.3 4.7 18l6.6-6.6a3.5 3.5 0 004.2-4.9l-2.3 2.3-1.6-1.6 2.3-2.3z"/>',
  ),
  bolt: S('<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>'),
  menu: S('<path d="M4 6h16M4 12h16M4 18h16"/>'),
};

export function icon(name: string): string {
  return ICONS[name] ?? ICONS.sparkles;
}
