import { ACCENT_CODE } from './tui/theme.js';

const CSI = `${String.fromCharCode(27)}[`;
const RESET = `${CSI}0m`;

let colorEnabled =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

export function setColor(enabled) {
  colorEnabled = Boolean(enabled);
}

const wrap = (code) => (text) => (colorEnabled ? `${CSI}${code}m${text}${RESET}` : String(text));

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
  // The product's own colour, used sparingly: the banner badge, the caret and
  // the marker in front of an answer. 256-colour so it survives older
  // terminals, and plain text wherever colour is disabled.
  accent: wrap(ACCENT_CODE),
};

export const SYMBOL = Object.freeze({ ok: 'OK', fail: 'FAIL', warn: 'WARN', arrow: '->' });

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function line(text = '') {
  process.stdout.write(`${text}\n`);
}

export function errorLine(text) {
  process.stderr.write(`${text}\n`);
}

/** Aligned key/value block. */
export function keyValues(pairs) {
  const width = Math.max(0, ...pairs.map(([k]) => k.length));
  for (const [key, value] of pairs) {
    line(`  ${c.dim(key.padEnd(width))}  ${value}`);
  }
}

/** Simple column table that tolerates missing values. */
export function table(headers, rows) {
  if (rows.length === 0) {
    line(c.dim('  (none)'));
    return;
  }
  const norm = rows.map((r) => r.map((cell) => String(cell ?? '')));
  const widths = headers.map((h, i) => Math.max(h.length, ...norm.map((r) => (r[i] ?? '').length)));
  line(`  ${c.dim(headers.map((h, i) => h.padEnd(widths[i])).join('  '))}`);
  for (const row of norm) {
    line(`  ${row.map((cell, i) => cell.padEnd(widths[i])).join('  ')}`);
  }
}

export const statusColor = (status) => {
  if (status === 'succeeded' || status === 'PASS') return c.green(status);
  if (status === 'failed' || status === 'FAIL') return c.red(status);
  if (status === 'awaiting-approval' || status === 'WARN') return c.yellow(status);
  return c.dim(status);
};
