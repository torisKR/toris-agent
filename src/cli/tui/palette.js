/**
 * Live slash-command palette for the chat REPL.
 *
 * While the operator types `/…`, matching commands are painted just below the
 * prompt — the same affordance claude-code and codex give. Everything here is
 * a pure function of the current line except the controller, which owns only
 * one integer: how many rows it drew last time. That is what keeps redraws
 * stable — every frame repaints max(now, before) rows, so stale text can never
 * outlive a keystroke.
 *
 * Escape-sequence strategy (scroll-safe): rows are entered with `\n`, which
 * scrolls naturally at the bottom of the screen, and the cursor returns with a
 * *relative* move up — never with absolute save/restore, which breaks the
 * moment the screen scrolls.
 */

import { SLASH_COMMANDS, SLASH_ALIASES } from './slash.js';
import { stripAnsi, stringWidth, truncate } from './text.js';
import { c } from '../output.js';

const ESC = '';
const DEFAULT_MAX_ROWS = 8;

/** @typedef {import('./slash.js').SlashCommandSpec} SlashCommandSpec */

/**
 * Commands worth showing for the current input line.
 *
 * - `/`        → the whole catalog
 * - `/mo`      → prefix matches by name, plus alias targets (`/q` → exit)
 * - `/model x` → just the matched command, kept as an argument hint
 * - prose      → nothing
 *
 * @param {unknown} line
 * @returns {SlashCommandSpec[]}
 */
export function suggestSlashCommands(line) {
  if (typeof line !== 'string' || !line.startsWith('/')) return [];
  const body = line.slice(1);

  if (/\s/.test(body)) {
    const head = body.split(/\s+/, 1)[0].toLowerCase();
    const name = SLASH_ALIASES[head] ?? head;
    const spec = SLASH_COMMANDS.find((cmd) => cmd.name === name);
    return spec && spec.args !== '' ? [spec] : [];
  }

  const prefix = body.toLowerCase();
  const byName = SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(prefix));
  if (byName.length > 0 || prefix === '') return byName;

  // No canonical name matches — fall back to alias spellings (`/q` → exit),
  // keeping catalog order and deduping targets shared by several aliases.
  const aliasTargets = new Set(
    Object.entries(SLASH_ALIASES)
      .filter(([alias]) => alias.startsWith(prefix))
      .map(([, target]) => target),
  );
  return SLASH_COMMANDS.filter((cmd) => aliasTargets.has(cmd.name));
}

/**
 * Readline completer: tab accepts the top suggestion.
 *
 * Exactly one candidate is ever returned, so readline substitutes it in place
 * instead of printing its own completion list under our palette.
 *
 * @param {string} line
 * @returns {[string[], string]}
 */
export function completeSlash(line) {
  if (typeof line !== 'string' || !line.startsWith('/') || /\s/.test(line.slice(1))) {
    return [[], String(line ?? '')];
  }
  const [top] = suggestSlashCommands(line);
  if (!top) return [[], line];
  return [[`/${top.name}${top.args === '' ? '' : ' '}`], line];
}

/**
 * One aligned row per suggestion: accent label, dim summary, clipped to width.
 * @param {ReadonlyArray<SlashCommandSpec>} specs
 * @param {{width?: number}} [options]
 * @returns {string[]}
 */
export function renderPaletteRows(specs, { width = 80 } = {}) {
  if (!Array.isArray(specs) || specs.length === 0) return [];
  const labels = specs.map((cmd) => `/${cmd.name}${cmd.args === '' ? '' : ` ${cmd.args}`}`);
  const column = Math.max(...labels.map((label) => label.length));
  return specs.map((cmd, i) =>
    truncate(`  ${c.accent(labels[i].padEnd(column))}  ${c.dim(cmd.summary)}`, width),
  );
}

/**
 * Paints and erases the palette under an active readline prompt.
 *
 * @param {{
 *   output: {write(chunk:string): unknown},
 *   maxRows?: number,
 *   suggest?: typeof suggestSlashCommands,
 *   render?: typeof renderPaletteRows,
 * }} deps
 */
export function createPaletteController({
  output,
  maxRows = DEFAULT_MAX_ROWS,
  suggest = suggestSlashCommands,
  render = renderPaletteRows,
}) {
  let drawnRows = 0;

  /**
   * Repaint for the current input state. Call after readline has applied a
   * keystroke (`rl.line` / `rl.cursor` are current).
   *
   * @param {{line: string, cursor: number, promptLength: number, width: number}} state
   */
  const update = ({ line, cursor, promptLength, width }) => {
    const text = typeof line === 'string' ? line : '';
    // A wrapped input line breaks the "one row up equals the prompt" math, so
    // the palette bows out rather than corrupt the screen.
    const fitsOneRow = promptLength + stringWidth(stripAnsi(text)) < width;
    const specs = fitsOneRow ? suggest(text) : [];
    const rows = render(specs.slice(0, maxRows), { width: Math.max(1, width - 1) });

    if (rows.length === 0 && drawnRows === 0) return;

    const column = promptLength + stringWidth(stripAnsi(text.slice(0, cursor)));
    const total = Math.max(rows.length, drawnRows);
    let frame = `${ESC}[?25l`;
    for (let i = 0; i < total; i += 1) frame += `\n${ESC}[2K${rows[i] ?? ''}`;
    frame += `${ESC}[${total}A\r`;
    if (column > 0) frame += `${ESC}[${column}C`;
    frame += `${ESC}[?25h`;
    output.write(frame);
    drawnRows = rows.length;
  };

  /**
   * The line was submitted: the cursor already sits at the start of what used
   * to be the first palette row, so one erase-below wipes the whole panel.
   */
  const onSubmit = () => {
    if (drawnRows === 0) return;
    output.write(`${ESC}[0J`);
    drawnRows = 0;
  };

  return {
    update,
    onSubmit,
    get openRows() {
      return drawnRows;
    },
  };
}
