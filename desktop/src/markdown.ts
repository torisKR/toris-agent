// A tiny, dependency-free, XSS-safe Markdown renderer. We escape all HTML first
// and only ever emit a fixed set of tags, so model output can never inject
// markup. It covers what the assistant actually produces: headings, bold,
// italic, inline code, fenced code blocks, links (rendered as safe anchors),
// unordered/ordered lists, blockquotes, tables and paragraphs.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Inline: code spans first (so their contents are not further formatted), then
// bold, italic and safe links.
function renderInline(text: string): string {
  const codeSpans: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  out = escapeHtml(out);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, href) => {
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
      label,
    )}</a>`;
  });

  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)]);
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;

  const closeList = (stack: string[]) => {
    while (stack.length) html.push(`</${stack.pop()}>`);
  };
  const listStack: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      closeList(listStack);
      const lang = fence[1] ? ` class="lang-${escapeHtml(fence[1])}"` : '';
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      html.push(`<pre><code${lang}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Headings
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList(listStack);
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Table: header row + separator row
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      closeList(listStack);
      const parseRow = (row: string) =>
        row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const headers = parseRow(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        body.push(parseRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      html.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      closeList(listStack);
      html.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`);
      i += 1;
      continue;
    }

    // Unordered list
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (listStack[listStack.length - 1] !== 'ul') {
        closeList(listStack);
        listStack.push('ul');
        html.push('<ul>');
      }
      html.push(`<li>${renderInline(ul[1])}</li>`);
      i += 1;
      continue;
    }

    // Ordered list
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      if (listStack[listStack.length - 1] !== 'ol') {
        closeList(listStack);
        listStack.push('ol');
        html.push('<ol>');
      }
      html.push(`<li>${renderInline(ol[1])}</li>`);
      i += 1;
      continue;
    }

    // Blank line
    if (/^\s*$/.test(line)) {
      closeList(listStack);
      i += 1;
      continue;
    }

    // Paragraph (merge consecutive non-empty, non-block lines)
    closeList(listStack);
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^[-*]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  closeList(listStack);
  return html.join('\n');
}
