/**
 * Inline terminal rendering primitives.
 *
 * Deliberately inline rather than full-screen: output goes to the normal
 * scrollback so the terminal's own search, selection and copy keep working,
 * and a resize never corrupts history. Nothing here takes a dependency beyond
 * Node's standard library.
 */

import { c } from '../output.js';
import { wrapAnsi, stringWidth, truncate } from './text.js';

const ESC = String.fromCharCode(27);
const CLEAR_LINE = `${ESC}[2K`;
const RESET = `${ESC}[0m`;

const SPINNER_FRAMES = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const SPINNER_INTERVAL_MS = 80;
const STATUS_SEPARATOR = ' · ';
const MIN_CONTENT_WIDTH = 1;

/**
 * Buffers streamed model output and emits it as complete, wrapped lines.
 *
 * Tokens arrive in arbitrary chunks that rarely align with word or line
 * boundaries, so text is held until a line is provably finished — either by an
 * explicit newline or because wrapping proved the line full. Anything still
 * pending is released by `end()`.
 *
 * @param {object} options
 * @param {(chunk: string) => void} options.write Sink for finished lines.
 * @param {number} options.width Total terminal columns available.
 * @param {string} [options.gutter] Prefix repeated on every emitted line.
 * @returns {{push: (chunk: string) => void, end: () => void, isEmpty: () => boolean}}
 */
export function createStreamWriter({ write, width, gutter = '' }) {
  const contentWidth = Math.max(MIN_CONTENT_WIDTH, Math.floor(width) - stringWidth(gutter));
  let pending = '';
  let wroteAnything = false;
  let ended = false;

  const emitLine = (text) => {
    write(text === '' ? '\n' : `${gutter}${text}\n`);
    wroteAnything = true;
  };

  /** Wrap one finished logical line and emit every resulting row. */
  const emitLogical = (logical) => {
    for (const row of wrapAnsi(logical, contentWidth)) emitLine(row);
  };

  return {
    push(chunk) {
      if (ended || chunk === '' || chunk === undefined || chunk === null) return;
      pending += String(chunk);

      // Explicit newlines close a line outright.
      for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
        emitLogical(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }

      // Wrapping proves every row but the last is final; the last may still grow.
      const rows = wrapAnsi(pending, contentWidth);
      if (rows.length > 1) {
        for (const row of rows.slice(0, -1)) emitLine(row);
        pending = rows[rows.length - 1] ?? '';
      }
    },

    end() {
      if (ended) return;
      ended = true;
      if (pending !== '') {
        emitLogical(pending);
        pending = '';
      }
    },

    isEmpty() {
      return !wroteAnything && pending === '';
    },
  };
}

/**
 * Single-line progress indicator that erases itself on stop.
 *
 * Writes nothing at all when the target stream is not a TTY, so piped and
 * redirected output stays free of control characters.
 *
 * @param {object} options
 * @param {(chunk: string) => void} options.write
 * @param {boolean} options.isTTY
 * @returns {{start: (label?: string) => void, tick: () => void, stop: () => void}}
 */
export function createSpinner({ write, isTTY }) {
  let frame = 0;
  let label = '';
  let active = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  const paint = () => {
    write(`\r${CLEAR_LINE}${c.dim(`${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${label}`)}`);
  };

  const clearTimer = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    start(text = '') {
      if (!isTTY || active) return;
      label = text;
      frame = 0;
      active = true;
      paint();
      timer = setInterval(() => {
        frame += 1;
        paint();
      }, SPINNER_INTERVAL_MS);
      // Never hold the event loop open on the spinner's account.
      if (typeof timer.unref === 'function') timer.unref();
    },

    tick() {
      if (!isTTY || !active) return;
      frame += 1;
      paint();
    },

    stop() {
      clearTimer();
      if (!isTTY || !active) return;
      active = false;
      write(`\r${CLEAR_LINE}`);
    },
  };
}

/**
 * Render a one-line status strip, clipped to the terminal width.
 * @param {ReadonlyArray<readonly [string, string]>} pairs Label/value pairs.
 * @param {number} width Available columns.
 * @returns {string} Empty string when there is nothing to show.
 */
export function renderStatusBar(pairs, width) {
  if (!Array.isArray(pairs) || pairs.length === 0) return '';
  const limit = Math.max(0, Math.floor(width));
  if (limit === 0) return '';

  const bar = pairs
    .map(([label, value]) => `${c.dim(label)} ${value}`)
    .join(c.dim(STATUS_SEPARATOR));

  const clipped = truncate(bar, limit);
  // Truncation can cut before a colour reset; close it so styling cannot bleed.
  return clipped.includes(ESC) && !clipped.endsWith(RESET) ? `${clipped}${RESET}` : clipped;
}
