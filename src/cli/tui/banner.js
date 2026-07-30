/**
 * The header a chat session opens with.
 *
 * Kept to four lines on purpose: an operator who runs `toris` twenty times a
 * day needs to confirm *what is answering, where, and how freely* — anything
 * beyond that is scrollback they will scroll past.
 */

import { homedir } from 'node:os';
import { c } from '../output.js';
import { renderStatusBar } from './render.js';
import { truncate, stringWidth, stripAnsi, padTo } from './text.js';
import { SYM } from './theme.js';

export const DEFAULT_TERMINAL_WIDTH = 80;

/**
 * Narrowest terminal we will lay out for. Below this everything is ellipsis, so
 * a smaller report is treated as noise rather than obeyed.
 */
export const MIN_TERMINAL_WIDTH = 20;

/** The three keys that get someone out of trouble on their first session. */
const HINT = '/help for commands · ctrl-c interrupt · ctrl-d exit';

/**
 * Widest the welcome box is allowed to get.
 *
 * A box that spans a 200-column terminal reads as a wall, not a header: the
 * eye has to travel the whole width to confirm five short values. Claude Code
 * and codex pin theirs at a similar measure for the same reason.
 */
export const BOX_MAX_WIDTH = 64;

/**
 * Below this the box costs more columns in borders than it earns in structure,
 * so the plain stacked layout is drawn instead.
 */
export const BOX_MIN_WIDTH = 40;

/** `│ ` + content + ` │`. */
const BOX_CHROME = 4;
/** Rows are indented under the title, the way a definition list reads. */
const ROW_INDENT = '  ';
/** Longest label (`autonomy`) plus a space, so values line up in a column. */
const LABEL_WIDTH = 9;

/**
 * Resolve a usable column count from `stdout.columns`.
 *
 * `??` is not enough: a pty that never negotiated a size (`script`, some CI
 * runners, a detached daemon) reports `0`, which is present-but-useless and
 * would otherwise truncate every line down to a bare "…".
 *
 * @param {unknown} columns
 * @returns {number}
 */
export function resolveWidth(columns) {
  const n = Number(columns);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TERMINAL_WIDTH;
  return Math.max(MIN_TERMINAL_WIDTH, Math.floor(n));
}

/**
 * Collapse `$HOME` to `~` so the cwd line stays readable on a narrow terminal.
 * @param {string} path
 * @param {string} [home]
 */
export function shortenPath(path, home = homedir()) {
  const value = String(path ?? '');
  if (!home || (value !== home && !value.startsWith(`${home}/`))) return value;
  return `~${value.slice(home.length)}`;
}

/** Wide enough that `renderStatusBar` measures instead of truncating. */
const MEASURE_WIDTH = 10_000;

/**
 * `2 turns` but `1 turn`. Only regular -s nouns; the TUI has no others.
 * @param {number} count @param {string} noun
 */
export const countOf = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Drop trailing status pairs until the bar fits.
 *
 * Truncating instead would leave a half-written value like `tools delegate…`,
 * which reads as a broken field rather than an omitted one. Pairs are ordered
 * most-important-first, so losing the tail is the right sacrifice.
 *
 * @param {ReadonlyArray<[string, string]>} pairs
 * @param {number} width
 * @returns {ReadonlyArray<[string, string]>}
 */
function fitPairs(pairs, width) {
  const fits = (subset) => stringWidth(stripAnsi(renderStatusBar(subset, MEASURE_WIDTH))) <= width;

  let kept = pairs;
  while (kept.length > 1 && !fits(kept)) kept = kept.slice(0, -1);
  return kept;
}

/** Versions read as versions with the `v`; unknown ones stay silent. */
const versionLabel = (version) => (version ? `v${version}` : '');

/**
 * @param {{
 *   version: string,
 *   profile: string,
 *   provider: string,
 *   model: string,
 *   cwd: string,
 *   autonomy: string,
 *   approvals: string,
 *   tools?: number|string,
 *   skills?: number|string,
 *   width?: number,
 *   home?: string,
 * }} info
 * @returns {string[]} Lines ready to print, in order.
 */
export function renderBanner(info) {
  const width = resolveWidth(info.width);
  const rows = bannerRows(info);

  // Every line is clipped to the terminal: a banner that wraps looks like a
  // rendering bug on the very first screen the operator ever sees.
  const clip = (text) => truncate(text, width);
  const hint = c.dim(clip(`${ROW_INDENT}${HINT}`));

  if (width < BOX_MIN_WIDTH) return [...stackedBanner(info, rows, width), hint];
  return [...boxedBanner(info, rows, Math.min(width, BOX_MAX_WIDTH)), hint];
}

/**
 * What a session is actually configured to do, most-load-bearing first.
 * @param {object} info
 * @returns {ReadonlyArray<[string, string]>}
 */
function bannerRows(info) {
  return [
    ['model', `${info.provider}/${info.model}`],
    ['profile', String(info.profile ?? '')],
    ['cwd', shortenPath(info.cwd, info.home)],
    ['autonomy', `${info.autonomy} (${info.approvals})`],
    ['tools', String(info.tools ?? 0)],
    ['skills', String(info.skills ?? 0)],
  ];
}

/**
 * The rounded welcome box.
 *
 * Borders are drawn at a fixed width and the *content* is clipped to fit, so
 * the right-hand edge always lines up — a ragged box is worse than no box.
 *
 * @param {object} info
 * @param {ReadonlyArray<[string, string]>} rows
 * @param {number} boxWidth
 * @returns {string[]}
 */
function boxedBanner(info, rows, boxWidth) {
  const inner = boxWidth - BOX_CHROME;
  const edge = SYM.horizontal.repeat(boxWidth - 2);

  // Padding is applied to the *visible* width, so colour codes inside the row
  // cannot push the closing border out of alignment.
  const row = (content) => {
    const clipped = truncate(content, inner);
    return `${SYM.vertical} ${padTo(clipped, inner)} ${SYM.vertical}`;
  };

  const title = `${c.accent(SYM.star)} ${c.accent('toris')} ${c.dim(versionLabel(info.version))}`;
  const field = ([label, value]) => row(`${ROW_INDENT}${c.dim(padTo(label, LABEL_WIDTH))}${value}`);

  return [
    `${SYM.topLeft}${edge}${SYM.topRight}`,
    row(title),
    row(''),
    ...rows.map(field),
    `${SYM.bottomLeft}${edge}${SYM.bottomRight}`,
  ];
}

/**
 * Fallback for terminals too narrow to frame anything: the original stacked
 * layout, which spends every column on content.
 *
 * @param {object} info
 * @param {ReadonlyArray<[string, string]>} rows
 * @param {number} width
 * @returns {string[]}
 */
function stackedBanner(info, rows, width) {
  const clip = (text) => truncate(text, width);
  const pairs = rows.filter(([label]) => label !== 'cwd');

  return [
    clip(`${c.accent(SYM.star)} ${c.bold('toris')} ${c.dim(versionLabel(info.version))}`),
    c.dim(clip(shortenPath(info.cwd, info.home))),
    renderStatusBar(fitPairs(pairs, width), width),
  ];
}

/**
 * The footer printed after each answer: which model spent what, so far.
 *
 * Dimmed as one piece rather than built from `renderStatusBar`, whose per-label
 * resets would cut the dim short partway along the line.
 *
 * @param {{provider:string, model:string, usage:{inputTokens:number, outputTokens:number, turns:number}, width?:number, elapsedMs?:number}} info
 */
export function renderTurnStatus({ provider, model, usage, width, elapsedMs }) {
  const parts = [
    `${provider}/${model}`,
    `${usage?.inputTokens ?? 0} in`,
    `${usage?.outputTokens ?? 0} out`,
    countOf(usage?.turns ?? 0, 'turn'),
  ];
  if (Number.isFinite(elapsedMs) && elapsedMs >= 0) parts.push(formatDuration(elapsedMs));

  // The marker matches the one in front of the answer it summarises, so the
  // eye reads footer and response as one block.
  const text = `${SYM.dot} ${parts.join(` ${SYM.bullet} `)}`;
  return c.dim(truncate(text, resolveWidth(width)));
}

/** One significant unit: `840ms`, `1.2s`, `1m04s`. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms));
  if (total < 1000) return `${total}ms`;
  if (total < 60_000) return `${(total / 1000).toFixed(1)}s`;
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.round((total % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}
