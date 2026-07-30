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
import { SYM, SPARK_FRAMES } from './theme.js';

const ESC = String.fromCharCode(27);
const CLEAR_LINE = `${ESC}[2K`;
const CURSOR_UP = `${ESC}[1A`;
const RESET = `${ESC}[0m`;

const SPINNER_INTERVAL_MS = 80;
const STATUS_SEPARATOR = ' · ';
const MIN_CONTENT_WIDTH = 1;
/** Spinner hint, shown once a turn is slow enough that the keys matter. */
const INTERRUPT_HINT = 'esc to interrupt';

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
 * @param {string} [options.firstGutter] Prefix for the first line only, so an
 *   answer can be marked once (`⏺ `) and merely indented afterwards.
 * @returns {{push: (chunk: string) => void, end: () => void, isEmpty: () => boolean}}
 */
export function createStreamWriter({ write, width, gutter = '', firstGutter = gutter }) {
  // Wrapping is decided before we know which line will be first, so budget for
  // the wider of the two prefixes; that way neither can overflow the terminal.
  const reserved = Math.max(stringWidth(gutter), stringWidth(firstGutter));
  const contentWidth = Math.max(MIN_CONTENT_WIDTH, Math.floor(width) - reserved);
  let pending = '';
  let wroteAnything = false;
  let markerUsed = false;
  let ended = false;

  const emitLine = (text) => {
    wroteAnything = true;
    // A blank line stays blank: trailing gutter whitespace shows up on copy,
    // and the marker is saved for the first line that actually carries text.
    if (text === '') {
      write('\n');
      return;
    }
    write(`${markerUsed ? gutter : firstGutter}${text}\n`);
    markerUsed = true;
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
 * @param {() => number} [options.now] Clock, injectable so tests need no timers.
 * @returns {{start: (label?: string) => void, tick: () => void, stop: () => void}}
 */
export function createSpinner({ write, isTTY, now = Date.now }) {
  let frame = 0;
  let label = '';
  let active = false;
  let startedAt = 0;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  const paint = () => {
    const spark = SPARK_FRAMES[frame % SPARK_FRAMES.length];
    const seconds = Math.max(0, Math.floor((now() - startedAt) / 1000));
    // Elapsed time is the honest answer to "is this stuck?", and the interrupt
    // key is the thing an operator reaches for the moment they decide it is.
    const hint = c.dim(`(${INTERRUPT_HINT} ${SYM.bullet} ${seconds}s)`);
    write(`\r${CLEAR_LINE}${c.accent(spark)} ${label} ${hint}`);
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
      startedAt = now();
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
 * The dim rule that separates the last answer from the next prompt.
 *
 * A single line of structure is all the input area needs: a fully bordered,
 * live-redrawn input box fights readline for control of the cursor and breaks
 * the moment history, paste or a resize gets involved.
 *
 * @param {number} width
 * @returns {string}
 */
export function renderRule(width) {
  const columns = Math.max(0, Math.floor(width));
  return columns === 0 ? '' : c.dim(SYM.horizontal.repeat(columns));
}

/** The prompt readline draws. Accent only where colour actually renders. */
export function renderPrompt() {
  return `${c.accent(SYM.caret)} `;
}

/**
 * Repaint a just-submitted line as dim scrollback.
 *
 * Readline has already echoed the input in full brightness next to the prompt;
 * rewriting that line puts the user's own words in the background where they
 * belong, so the answer is what stands out.
 *
 * Returns `null` when the input wrapped, because only the final visual row can
 * be rewound with a single cursor move — clearing the rest would eat output
 * that is not ours.
 *
 * @param {string} text Submitted line, as typed.
 * @param {number} width Terminal columns.
 * @returns {string|null} A chunk to write, or null to leave the echo alone.
 */
export function renderUserEcho(text, width) {
  const columns = Math.max(0, Math.floor(width));
  const line = String(text);
  const prefix = `${SYM.caret} `;
  if (columns === 0 || stringWidth(`${prefix}${line}`) >= columns) return null;
  return `${CURSOR_UP}\r${CLEAR_LINE}${c.dim(`${prefix}${line}`)}\n`;
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
