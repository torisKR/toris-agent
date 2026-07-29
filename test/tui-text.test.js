import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi, stringWidth, wrapAnsi, truncate, padTo } from '../src/cli/tui/text.js';

const ESC = String.fromCharCode(27);
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

test('stripAnsi removes SGR sequences but keeps text', () => {
  assert.equal(stripAnsi(`${RED}hello${RESET}`), 'hello');
  assert.equal(stripAnsi('plain'), 'plain');
  assert.equal(stripAnsi(''), '');
});

test('stringWidth counts ASCII as one column each', () => {
  assert.equal(stringWidth('hello'), 5);
  assert.equal(stringWidth(''), 0);
});

test('stringWidth counts Hangul as two columns', () => {
  // Terminals render Hangul syllables double-width.
  assert.equal(stringWidth('토리스'), 6);
  assert.equal(stringWidth('a토b'), 4);
});

test('stringWidth counts CJK ideographs and fullwidth forms as two columns', () => {
  assert.equal(stringWidth('日本'), 4);
  assert.equal(stringWidth('ＡＢ'), 4);
});

test('stringWidth ignores ANSI colour codes', () => {
  assert.equal(stringWidth(`${RED}토리스${RESET}`), 6);
});

test('stringWidth treats combining marks as zero width', () => {
  // "e" + combining acute accent renders as a single column.
  assert.equal(stringWidth(`e${String.fromCharCode(0x0301)}`), 1);
});

test('wrapAnsi breaks plain text at the requested width', () => {
  assert.deepEqual(wrapAnsi('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);
});

test('wrapAnsi never emits a line wider than the limit', () => {
  const lines = wrapAnsi('the quick brown fox jumps over the lazy dog', 10);
  for (const l of lines) assert.ok(stringWidth(l) <= 10, `too wide: ${JSON.stringify(l)}`);
});

test('wrapAnsi wraps Hangul by display width, not character count', () => {
  // 4 syllables = 8 columns, so a width of 4 fits only 2 per line.
  const lines = wrapAnsi('토리스가', 4);
  for (const l of lines) assert.ok(stringWidth(l) <= 4, `too wide: ${JSON.stringify(l)}`);
  assert.equal(lines.join(''), '토리스가');
});

test('wrapAnsi hard-breaks a single word longer than the width', () => {
  const lines = wrapAnsi('supercalifragilistic', 6);
  for (const l of lines) assert.ok(stringWidth(l) <= 6);
  assert.equal(lines.join(''), 'supercalifragilistic');
});

test('wrapAnsi preserves explicit newlines as separate lines', () => {
  assert.deepEqual(wrapAnsi('a\nb', 10), ['a', 'b']);
});

test('wrapAnsi keeps colour codes with their text', () => {
  const lines = wrapAnsi(`${RED}hello world${RESET}`, 5);
  assert.ok(lines.join('').includes(RED));
  assert.equal(stripAnsi(lines.join(' ')), 'hello world');
});

test('wrapAnsi returns a single empty line for empty input', () => {
  assert.deepEqual(wrapAnsi('', 10), ['']);
});

test('truncate leaves short strings untouched', () => {
  assert.equal(truncate('abc', 10), 'abc');
});

test('truncate cuts to the width including the ellipsis', () => {
  const out = truncate('abcdefghij', 5);
  assert.ok(stringWidth(out) <= 5, `too wide: ${out}`);
  assert.ok(out.endsWith('…'));
});

test('truncate never splits a wide character across the boundary', () => {
  const out = truncate('토리스가나다', 5);
  assert.ok(stringWidth(out) <= 5, `too wide: ${out}`);
});

test('padTo pads to the display width for wide characters', () => {
  assert.equal(stringWidth(padTo('토리', 8)), 8);
  assert.equal(stringWidth(padTo('ab', 8)), 8);
});

test('padTo does not shrink strings already at or past the width', () => {
  assert.equal(padTo('abcdef', 3), 'abcdef');
});
