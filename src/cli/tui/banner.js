/**
 * The header a chat session opens with.
 *
 * Kept to three lines on purpose: an operator who runs `toris` twenty times a
 * day needs to confirm *what is answering, where, and how freely* — anything
 * beyond that is scrollback they will scroll past.
 */

import { homedir } from 'node:os';
import { c } from '../output.js';
import { renderStatusBar } from './render.js';
import { truncate } from './text.js';

export const DEFAULT_TERMINAL_WIDTH = 80;

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
  const width = Math.max(1, Math.floor(info.width ?? DEFAULT_TERMINAL_WIDTH));
  const pairs = [
    ['model', `${info.provider}/${info.model}`],
    ['profile', info.profile],
    ['autonomy', `${info.autonomy} ${c.dim(`(${info.approvals})`)}`],
    ['tools', String(info.tools ?? 0)],
    ['skills', String(info.skills ?? 0)],
  ];

  return [
    `${c.bold('toris')} ${c.dim(info.version)}`,
    c.dim(shortenPath(info.cwd, info.home)),
    renderStatusBar(pairs, width),
    c.dim('/help for commands · ctrl-c interrupts · ctrl-d exits'),
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
export function renderTurnStatus({ provider, model, usage, width = DEFAULT_TERMINAL_WIDTH }) {
  const parts = [
    `${provider}/${model}`,
    `${usage?.inputTokens ?? 0} in`,
    `${usage?.outputTokens ?? 0} out`,
    `${usage?.turns ?? 0} turns`,
  ];
  return c.dim(truncate(parts.join(' · '), Math.max(1, Math.floor(width))));
}
