import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStreamWriter,
  createSpinner,
  renderStatusBar,
  renderRule,
  renderPrompt,
  renderUserEcho,
} from '../src/cli/tui/render.js';
import { stringWidth, stripAnsi } from '../src/cli/tui/text.js';
import { SYM } from '../src/cli/tui/theme.js';

/** Collects everything a renderer writes so assertions can inspect it. */
function sink() {
  const chunks = [];
  return { chunks, write: (s) => chunks.push(s), text: () => chunks.join('') };
}

test('streamWriter emits nothing until a line is complete', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 20 });
  w.push('short');
  assert.equal(out.text(), '');
});

test('streamWriter flushes the remainder on end', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 20 });
  w.push('short');
  w.end();
  assert.equal(stripAnsi(out.text()).trim(), 'short');
});

test('streamWriter reassembles text split across chunk boundaries', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 40 });
  w.push('hel');
  w.push('lo wor');
  w.push('ld');
  w.end();
  assert.equal(stripAnsi(out.text()).trim(), 'hello world');
});

test('streamWriter wraps output to the given width', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 12 });
  w.push('the quick brown fox jumps over the lazy dog');
  w.end();
  for (const line of stripAnsi(out.text()).split('\n')) {
    assert.ok(stringWidth(line) <= 12, `too wide: ${JSON.stringify(line)}`);
  }
});

test('streamWriter preserves the full text when wrapping', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 12 });
  w.push('the quick brown fox');
  w.end();
  const joined = stripAnsi(out.text())
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  assert.equal(joined, 'the quick brown fox');
});

test('streamWriter respects explicit newlines from the model', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 40 });
  w.push('first\nsecond\n');
  w.end();
  const lines = stripAnsi(out.text())
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  assert.deepEqual(lines, ['first', 'second']);
});

test('streamWriter indents every line with the gutter', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 40, gutter: '| ' });
  w.push('alpha\nbeta\n');
  w.end();
  const lines = stripAnsi(out.text()).split('\n').filter(Boolean);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.ok(line.startsWith('| '), `missing gutter: ${line}`);
});

test('streamWriter accounts for the gutter when wrapping', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 12, gutter: '>>> ' });
  w.push('the quick brown fox jumps');
  w.end();
  for (const line of stripAnsi(out.text()).split('\n')) {
    assert.ok(stringWidth(line) <= 12, `too wide: ${JSON.stringify(line)}`);
  }
});

test('streamWriter wraps Hangul without exceeding the width', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 10 });
  w.push('토리스는 한국어 에이전트입니다');
  w.end();
  for (const line of stripAnsi(out.text()).split('\n')) {
    assert.ok(stringWidth(line) <= 10, `too wide: ${JSON.stringify(line)}`);
  }
});

test('streamWriter end is idempotent', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 20 });
  w.push('x');
  w.end();
  const after = out.text();
  w.end();
  assert.equal(out.text(), after);
});

test('streamWriter reports whether anything was written', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 20 });
  assert.equal(w.isEmpty(), true);
  w.push('x');
  assert.equal(w.isEmpty(), false);
});

test('spinner writes nothing when the stream is not a TTY', () => {
  const out = sink();
  const s = createSpinner({ write: out.write, isTTY: false });
  s.start('thinking');
  s.tick();
  s.stop();
  assert.equal(out.text(), '');
});

test('spinner clears its own line when stopped on a TTY', () => {
  const out = sink();
  const s = createSpinner({ write: out.write, isTTY: true });
  s.start('thinking');
  s.tick();
  s.stop();
  // The final write must reset the line so following output starts clean.
  assert.ok(out.text().includes('\r'), 'spinner should rewind its line');
  assert.equal(stripAnsi(out.chunks.at(-1) ?? '').trim(), '');
});

test('spinner shows the label while running', () => {
  const out = sink();
  const s = createSpinner({ write: out.write, isTTY: true });
  s.start('계획 수립 중');
  s.tick();
  assert.ok(stripAnsi(out.text()).includes('계획 수립 중'));
  s.stop();
});

test('spinner stop without start is safe', () => {
  const out = sink();
  const s = createSpinner({ write: out.write, isTTY: true });
  assert.doesNotThrow(() => s.stop());
});

test('statusBar never exceeds the terminal width', () => {
  const bar = renderStatusBar(
    [
      ['model', 'claude-sonnet-4-5-20250929'],
      ['autonomy', 'L2'],
      ['cost', '$0.42'],
    ],
    40,
  );
  assert.ok(stringWidth(bar) <= 40, `too wide: ${stringWidth(bar)}`);
});

test('statusBar includes the values that fit', () => {
  const bar = renderStatusBar([['autonomy', 'L2']], 60);
  assert.ok(stripAnsi(bar).includes('L2'));
  assert.ok(stripAnsi(bar).includes('autonomy'));
});

test('statusBar tolerates a very narrow terminal', () => {
  const bar = renderStatusBar([['model', 'claude']], 8);
  assert.ok(stringWidth(bar) <= 8, `too wide: ${stringWidth(bar)}`);
});

test('statusBar renders empty input as an empty string', () => {
  assert.equal(renderStatusBar([], 40), '');
});

// --- response marker --------------------------------------------------------

test('streamWriter marks the first line and merely indents the rest', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 20, gutter: '  ', firstGutter: '> ' });

  w.push('one line that has to wrap onto a second\n');
  w.end();

  const lines = out.text().split('\n').filter(Boolean);
  assert.ok(lines.length > 1, 'the text wrapped');
  assert.ok(lines[0].startsWith('> '), 'the answer is marked once');
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith('  '), `continuation is indented, not re-marked: ${line}`);
  }
});

test('the marker survives a leading newline instead of being spent on it', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 40, gutter: '  ', firstGutter: '> ' });

  w.push('\nreal text\n');
  w.end();

  assert.equal(out.text(), '\n> real text\n');
});

test('a wider first-line marker cannot push the text past the terminal edge', () => {
  const out = sink();
  const w = createStreamWriter({
    write: out.write,
    width: 12,
    gutter: '  ',
    firstGutter: '>>>>> ',
  });

  w.push('alpha beta gamma delta\n');
  w.end();

  for (const line of out.text().split('\n').filter(Boolean)) {
    assert.ok(stringWidth(line) <= 12, `${stringWidth(line)}: ${line}`);
  }
});

test('streamWriter without a first gutter behaves exactly as before', () => {
  const out = sink();
  const w = createStreamWriter({ write: out.write, width: 40, gutter: '  ' });

  w.push('a\nb\n');
  w.end();

  assert.equal(out.text(), '  a\n  b\n');
});

// --- spinner elapsed --------------------------------------------------------

test('spinner reports elapsed seconds and the key that stops it', () => {
  const out = sink();
  let now = 1000;
  const s = createSpinner({ write: out.write, isTTY: true, now: () => now });

  s.start('thinking');
  now += 3400;
  s.tick();
  const painted = stripAnsi(out.chunks.at(-1));
  s.stop();

  assert.match(painted, /thinking/);
  assert.match(painted, /3s/, 'elapsed time answers "is this stuck?"');
  assert.match(painted, /esc to interrupt/);
});

test('spinner elapsed starts from zero on each turn, not from process start', () => {
  const out = sink();
  let now = 50_000;
  const s = createSpinner({ write: out.write, isTTY: true, now: () => now });

  s.start('one');
  now += 9000;
  s.stop();
  s.start('two');
  const painted = stripAnsi(out.chunks.at(-1));
  s.stop();

  assert.match(painted, /\(esc to interrupt · 0s\)/);
});

// --- input area -------------------------------------------------------------

test('the rule spans the terminal exactly, and vanishes at zero width', () => {
  assert.equal(stringWidth(stripAnsi(renderRule(37))), 37);
  assert.equal(stripAnsi(renderRule(4)), SYM.horizontal.repeat(4));
  assert.equal(renderRule(0), '');
});

test('the prompt is a caret and a space, whatever the colour setting', () => {
  assert.equal(stripAnsi(renderPrompt()), `${SYM.caret} `);
});

test('a submitted line is repainted dim under its own caret', () => {
  const echo = renderUserEcho('deploy the thing', 80);

  assert.ok(echo, 'a short line is rewritten');
  assert.equal(stripAnsi(echo), `\r${SYM.caret} deploy the thing\n`);
  assert.ok(echo.includes('[1A'), "it rewinds over readline's own echo");
  assert.ok(echo.includes('[2K'), 'and clears what was there');
});

test('input that wrapped is left alone, since one rewind cannot undo it', () => {
  assert.equal(renderUserEcho('x'.repeat(90), 80), null);
  assert.equal(renderUserEcho('x'.repeat(78), 80), null, 'the caret counts too');
  assert.equal(renderUserEcho('hi', 0), null);
});
