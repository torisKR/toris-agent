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
import { truncate, stringWidth, stripAnsi } from './text.js';

export const DEFAULT_TERMINAL_WIDTH = 80;

/**
 * Narrowest terminal we will lay out for. Below this everything is ellipsis, so
 * a smaller report is treated as noise rather than obeyed.
 */
export const MIN_TERMINAL_WIDTH = 20;

/** The three keys that get someone out of trouble on their first session. */
const HINT = '/help for commands · ctrl-c interrupts · ctrl-d exits';

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
  const pairs = [
    ['model', `${info.provider}/${info.model}`],
    ['profile', info.profile],
    ['autonomy', `${info.autonomy} ${c.dim(`(${info.approvals})`)}`],
    ['tools', String(info.tools ?? 0)],
    ['skills', String(info.skills ?? 0)],
  ];

  // Every line is clipped to the terminal: a banner that wraps looks like a
  // rendering bug on the very first screen the operator ever sees.
  const clip = (text) => truncate(text, width);

  return [
    clip(`${c.bold('toris')} ${c.dim(info.version)}`),
    c.dim(clip(shortenPath(info.cwd, info.home))),
    renderStatusBar(fitPairs(pairs, width), width),
    c.dim(clip(HINT)),
  ];
}

/**
 * The footer printed after each answer: which model spent what, so far.
 *
 * Dimmed as one piece rather than built from `renderStatusBar`, whose per-label
 * resets would cut the dim short partway along the line.
 *
 * @param {{provider:string, model:string, usage:{inputTokens:number, outputTokens:number, turns:number}, width?:number}} info
 */
export function renderTurnStatus({ provider, model, usage, width }) {
  const parts = [
    `${provider}/${model}`,
    `${usage?.inputTokens ?? 0} in`,
    `${usage?.outputTokens ?? 0} out`,
    countOf(usage?.turns ?? 0, 'turn'),
  ];
  return c.dim(truncate(parts.join(' · '), resolveWidth(width)));
}
