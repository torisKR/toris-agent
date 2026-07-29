/**
 * Display-width aware text utilities for the terminal UI.
 *
 * Terminals lay text out in fixed columns, and CJK characters occupy two of
 * them. Measuring with `String.length` therefore corrupts every box, status bar
 * and wrapped paragraph the moment non-Latin text appears. Everything here
 * measures in columns instead, and is ANSI-aware so colour codes never count
 * toward the visible width.
 *
 * All functions are pure and never mutate their inputs.
 */

const ESC = String.fromCharCode(27);

/** Matches CSI escape sequences (colour, cursor movement, erase). */
const ANSI_PATTERN = `${ESC}\\[[0-9;?]*[a-zA-Z]`;

const ELLIPSIS = '…';

/**
 * Code point ranges rendered two columns wide, from Unicode's East Asian Wide
 * and Fullwidth classes plus the common emoji blocks.
 * @type {ReadonlyArray<readonly [number, number]>}
 */
const WIDE_RANGES = Object.freeze([
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK symbols
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // emoji: symbols and pictographs
  [0x1f900, 0x1f9ff], // emoji: supplemental
  [0x20000, 0x3fffd], // CJK extension B and beyond
]);

/**
 * Code point ranges that occupy no columns at all: combining marks that stack
 * onto the previous glyph, and invisible formatting controls.
 * @type {ReadonlyArray<readonly [number, number]>}
 */
const ZERO_WIDTH_RANGES = Object.freeze([
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x200b, 0x200f], // zero-width space through RTL mark
  [0x2028, 0x202e],
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
]);

const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/**
 * Column count for a single code point.
 * @param {number} cp
 * @returns {0|1|2}
 */
function charWidth(cp) {
  if (cp === 0) return 0;
  // C0/C1 control characters render as nothing useful; treat them as invisible.
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/**
 * Remove ANSI escape sequences, leaving only the characters a user sees.
 * @param {string} input
 * @returns {string}
 */
export function stripAnsi(input) {
  return String(input).replace(new RegExp(ANSI_PATTERN, 'g'), '');
}

/**
 * Width of a string in terminal columns, ignoring ANSI codes.
 * @param {string} input
 * @returns {number}
 */
export function stringWidth(input) {
  let total = 0;
  for (const ch of stripAnsi(input)) total += charWidth(/** @type {number} */ (ch.codePointAt(0)));
  return total;
}

/**
 * Split a string into ANSI markers and individual characters, each tagged with
 * its column width. Markers carry zero width so they ride along with the text
 * they colour without affecting layout.
 * @param {string} input
 * @returns {Array<{ansi: boolean, text: string, width: number}>}
 */
function tokenize(input) {
  /** @type {Array<{ansi: boolean, text: string, width: number}>} */
  const tokens = [];
  const pattern = new RegExp(ANSI_PATTERN, 'g');
  let cursor = 0;

  const pushChars = (text) => {
    for (const ch of text) {
      tokens.push({
        ansi: false,
        text: ch,
        width: charWidth(/** @type {number} */ (ch.codePointAt(0))),
      });
    }
  };

  for (let m = pattern.exec(input); m !== null; m = pattern.exec(input)) {
    if (m.index > cursor) pushChars(input.slice(cursor, m.index));
    tokens.push({ ansi: true, text: m[0], width: 0 });
    cursor = m.index + m[0].length;
  }
  if (cursor < input.length) pushChars(input.slice(cursor));
  return tokens;
}

/**
 * Wrap one newline-free string to the given column width.
 * @param {string} input
 * @param {number} width
 * @returns {string[]}
 */
function wrapSingleLine(input, width) {
  /** @type {string[]} */
  const lines = [];
  let line = '';
  let lineWidth = 0;
  let word = '';
  let wordWidth = 0;

  const commitWord = () => {
    line += word;
    lineWidth += wordWidth;
    word = '';
    wordWidth = 0;
  };
  const breakLine = () => {
    lines.push(line);
    line = '';
    lineWidth = 0;
  };

  for (const token of tokenize(input)) {
    // Colour codes attach to the pending word so a wrap never separates them.
    if (token.ansi) {
      word += token.text;
      continue;
    }

    if (token.text === ' ') {
      if (lineWidth + wordWidth > width && lineWidth > 0) breakLine();
      commitWord();
      // A space that would overflow becomes the wrap point and is dropped.
      if (lineWidth + 1 <= width) {
        line += ' ';
        lineWidth += 1;
      } else {
        breakLine();
      }
      continue;
    }

    // A word too long to ever fit must be split mid-word.
    if (wordWidth + token.width > width) {
      if (lineWidth + wordWidth > width && lineWidth > 0) breakLine();
      commitWord();
      breakLine();
    }
    word += token.text;
    wordWidth += token.width;
  }

  if (lineWidth + wordWidth > width && lineWidth > 0) breakLine();
  commitWord();
  lines.push(line);
  return lines;
}

/**
 * Wrap text to a column width, preserving explicit newlines and colour codes.
 * Never returns a line wider than `width`.
 * @param {string} input
 * @param {number} width
 * @returns {string[]}
 */
export function wrapAnsi(input, width) {
  const limit = Math.max(1, Math.floor(width));
  return String(input)
    .split('\n')
    .flatMap((paragraph) => wrapSingleLine(paragraph, limit));
}

/**
 * Shorten a string to at most `width` columns, appending an ellipsis when text
 * is dropped. Never splits a wide character across the boundary.
 * @param {string} input
 * @param {number} width
 * @returns {string}
 */
export function truncate(input, width) {
  const limit = Math.max(0, Math.floor(width));
  const text = String(input);
  if (stringWidth(text) <= limit) return text;
  if (limit <= 1) return limit === 1 ? ELLIPSIS : '';

  const budget = limit - 1; // reserve one column for the ellipsis
  let out = '';
  let used = 0;
  for (const token of tokenize(text)) {
    if (token.ansi) {
      out += token.text;
      continue;
    }
    if (used + token.width > budget) break;
    out += token.text;
    used += token.width;
  }
  return `${out}${ELLIPSIS}`;
}

/**
 * Right-pad with spaces until the string occupies `width` columns. Strings
 * already at or beyond the width are returned unchanged.
 * @param {string} input
 * @param {number} width
 * @returns {string}
 */
export function padTo(input, width) {
  const text = String(input);
  const deficit = Math.floor(width) - stringWidth(text);
  return deficit > 0 ? `${text}${' '.repeat(deficit)}` : text;
}
