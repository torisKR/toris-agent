/**
 * Turn a desktop conversation into a portable Markdown document.
 *
 * Saving a chat as Markdown is a real, useful action for a solo operator (drop
 * the drafted email / invoice / plan straight into their notes). The webview
 * sends its conversation object to the bridge, which uses this pure function to
 * render the file — so the logic is testable without a DOM.
 *
 * The conversation shape mirrors the frontend store:
 *   { title, presetId?, createdAt?, updatedAt?, messages:[{ role, content, tools? }] }
 */

/** ISO-ish local timestamp, or '' when the value is missing/invalid. */
function stamp(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/** One tool-activity line, e.g. "run_command · echo hi — done". */
function toolLine(t) {
  const detail = t?.input?.command ?? t?.input?.path ?? '';
  const status = t?.status ?? 'done';
  const head = detail ? `${t.name} · ${detail}` : t?.name ?? 'tool';
  return `- \`${head}\` — ${status}`;
}

/**
 * @param {{title?:string, presetId?:string, createdAt?:number, updatedAt?:number,
 *          messages?:Array<{role:string, content:string, tools?:any[]}>}} conv
 * @returns {string} Markdown
 */
export function conversationToMarkdown(conv) {
  const title = (conv?.title && conv.title.trim()) || 'Conversation';
  const lines = [`# ${title}`, ''];

  const meta = [];
  if (conv?.presetId) meta.push(`**Mode:** ${conv.presetId}`);
  const created = stamp(conv?.createdAt);
  if (created) meta.push(`**Created:** ${created}`);
  const updated = stamp(conv?.updatedAt);
  if (updated) meta.push(`**Updated:** ${updated}`);
  if (meta.length) {
    lines.push(meta.join('  ·  '), '');
  }
  lines.push('---', '');

  for (const m of conv?.messages ?? []) {
    const who = m.role === 'user' ? 'You' : 'toris';
    lines.push(`## ${who}`, '');
    const tools = Array.isArray(m.tools) ? m.tools.filter((t) => t && t.name) : [];
    if (tools.length) {
      lines.push('_Tool activity:_', ...tools.map(toolLine), '');
    }
    lines.push((m.content ?? '').trim() || '_(empty)_', '');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** A filesystem-safe filename stem derived from a conversation title. */
export function exportFilename(conv) {
  const base = (conv?.title && conv.title.trim()) || 'conversation';
  const slug = base
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'conversation';
  const day = stamp(conv?.updatedAt || conv?.createdAt || Date.now()).slice(0, 10) || 'export';
  return `toris-${slug}-${day}.md`;
}
