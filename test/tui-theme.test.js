import test from 'node:test';
import assert from 'node:assert/strict';

import { SYM, SPARK_FRAMES, ACCENT_CODE } from '../src/cli/tui/theme.js';
import { c, setColor } from '../src/cli/output.js';
import { stringWidth, stripAnsi } from '../src/cli/tui/text.js';

test('the glyph set is frozen, so no surface can retune it at runtime', () => {
  assert.ok(Object.isFrozen(SYM));
  assert.ok(Object.isFrozen(SPARK_FRAMES));
  assert.throws(() => {
    'use strict';
    SYM.dot = 'x';
  });
});

test('every glyph is a single visible character', () => {
  for (const [name, glyph] of Object.entries(SYM)) {
    assert.equal(stripAnsi(glyph), glyph, `${name} carries no escape codes`);
    assert.ok(stringWidth(glyph) >= 1, `${name} is visible`);
    assert.ok(stringWidth(glyph) <= 2, `${name} fits a cell or two: ${glyph}`);
  }
});

test('the box corners and edges needed to close a frame all exist', () => {
  for (const key of [
    'topLeft',
    'topRight',
    'bottomLeft',
    'bottomRight',
    'vertical',
    'horizontal',
  ]) {
    assert.equal(typeof SYM[key], 'string', key);
  }
});

test('the accent is a 256-colour code, which every modern terminal renders', () => {
  assert.match(ACCENT_CODE, /^38;5;\d{1,3}$/);
});

test('accent colour is emitted when colour is on and dropped when it is off', () => {
  try {
    setColor(true);
    const painted = c.accent('toris');
    assert.ok(painted.includes(ACCENT_CODE), 'the accent code is used');
    assert.equal(stripAnsi(painted), 'toris');

    setColor(false);
    assert.equal(c.accent('toris'), 'toris', 'NO_COLOR/non-TTY gets plain text');
  } finally {
    setColor(false);
  }
});
