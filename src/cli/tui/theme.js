/**
 * The glyph and colour vocabulary the chat TUI is drawn from.
 *
 * Centralised so a terminal that renders one of these badly can be fixed in a
 * single place, and so every surface (banner, spinner, prompt, footer) speaks
 * the same visual language instead of each inventing its own arrow.
 *
 * Everything here is plain Unicode that a modern terminal font covers; nothing
 * requires a patched/Nerd font.
 */

/** @type {Readonly<Record<string, string>>} */
export const SYM = Object.freeze({
  /** Assistant response marker, in the left gutter of an answer. */
  dot: '⏺',
  /** "Working" mark: the spinner head and the banner's title badge. */
  spark: '✳',
  star: '✻',
  /** Input caret, echoed back on the submitted line. */
  caret: '❯',
  /** Rounded box drawing, matching the welcome banner. */
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  vertical: '│',
  horizontal: '─',
  /** Inline separators. */
  bullet: '·',
  arrow: '→',
  cross: '✗',
});

/**
 * Spinner cycle: a spark that grows and fades rather than a rotating bar.
 * Reads as "thinking" instead of "loading a file", which is the honest signal.
 */
export const SPARK_FRAMES = Object.freeze(['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']);

/**
 * SGR parameters for the accent colour: 256-colour soft sky blue.
 *
 * The pivot to a focused local AI agent takes its visual cue from open-webui —
 * a calm, modern, dark, chat-centric surface. A cool, low-saturation blue reads
 * as "calm assistant" rather than the old orange "harness/studio" energy, and
 * sits quietly next to plain text instead of shouting over it.
 *
 * 256-colour rather than truecolour because every terminal emulator worth
 * supporting handles it, and `output.js` already degrades to plain text when
 * NO_COLOR is set or stdout is not a TTY.
 */
export const ACCENT_CODE = '38;5;75';

/**
 * A compact wordmark for the first-run / onboarding surface.
 *
 * Deliberately minimal — open-webui's identity is clean and quiet, so a small
 * rounded mark reads more on-brand than a loud block-letter banner. Every glyph
 * here is plain box-drawing/Unicode a modern terminal font already covers.
 */
export const WORDMARK = Object.freeze([
  '╭───────────────────────────────╮',
  '│   ✻  t o r i s                 │',
  '│      local ai agent           │',
  '╰───────────────────────────────╯',
]);
