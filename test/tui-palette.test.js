import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  suggestSlashCommands,
  completeSlash,
  renderPaletteRows,
  createPaletteController,
} from '../src/cli/tui/palette.js';
import { SLASH_COMMANDS } from '../src/cli/tui/slash.js';
import { stripAnsi } from '../src/cli/tui/text.js';

// --- suggestSlashCommands ---------------------------------------------------

test('a bare slash suggests every command, in catalog order', () => {
  const specs = suggestSlashCommands('/');
  assert.deepEqual(
    specs.map((s) => s.name),
    SLASH_COMMANDS.map((s) => s.name),
  );
});

test('a prefix narrows suggestions by command name', () => {
  assert.deepEqual(
    suggestSlashCommands('/mo').map((s) => s.name),
    ['model'],
  );
  assert.deepEqual(
    suggestSlashCommands('/c').map((s) => s.name),
    ['clear'],
  );
});

test('aliases surface their target command', () => {
  // "q" and "quit" are exit aliases; both must land on /exit.
  assert.deepEqual(
    suggestSlashCommands('/q').map((s) => s.name),
    ['exit'],
  );
});

test('prose, empty input and unknown prefixes suggest nothing', () => {
  assert.deepEqual(suggestSlashCommands('hello'), []);
  assert.deepEqual(suggestSlashCommands(''), []);
  assert.deepEqual(suggestSlashCommands('/zzz'), []);
  assert.deepEqual(suggestSlashCommands(undefined), []);
});

test('while typing arguments, only the matched command stays as a hint', () => {
  const specs = suggestSlashCommands('/model so');
  assert.deepEqual(
    specs.map((s) => s.name),
    ['model'],
  );
  // A command that takes no arguments offers no hint once a space is typed.
  assert.deepEqual(suggestSlashCommands('/help '), []);
});

// --- completeSlash (readline completer) --------------------------------------

test('tab completes the top suggestion to a full command', () => {
  const [candidates, matched] = completeSlash('/mo');
  assert.deepEqual(candidates, ['/model ']);
  assert.equal(matched, '/mo');
});

test('commands without arguments complete without a trailing space', () => {
  const [candidates] = completeSlash('/he');
  assert.deepEqual(candidates, ['/help']);
});

test('tab is inert for prose, arguments and unknown commands', () => {
  assert.deepEqual(completeSlash('hello')[0], []);
  assert.deepEqual(completeSlash('/model son')[0], []);
  assert.deepEqual(completeSlash('/zzz')[0], []);
});

// --- renderPaletteRows --------------------------------------------------------

test('palette rows align labels and carry each summary', () => {
  const rows = renderPaletteRows(suggestSlashCommands('/'), { width: 80 });
  assert.equal(rows.length, SLASH_COMMANDS.length);
  const plain = rows.map(stripAnsi);
  assert.ok(plain[0].includes('/help'));
  assert.ok(plain.some((row) => row.includes('/model [profile]')));
  for (const [i, row] of plain.entries()) {
    assert.ok(row.includes(SLASH_COMMANDS[i].summary));
  }
  // Labels share one column, so every summary starts at the same offset.
  const offsets = new Set(plain.map((row) => row.search(/\s\s\S/)));
  assert.equal(offsets.size, 1);
});

test('palette rows never exceed the terminal width', () => {
  const rows = renderPaletteRows(suggestSlashCommands('/'), { width: 24 });
  for (const row of rows) assert.ok(stripAnsi(row).length <= 24);
});

test('no suggestions renders no rows', () => {
  assert.deepEqual(renderPaletteRows([], { width: 80 }), []);
});

// --- createPaletteController ---------------------------------------------------

const makeOutput = () => {
  const chunks = [];
  return { chunks, write: (s) => chunks.push(s) };
};

const frame = (out) => out.chunks.join('');

test('update draws suggestion rows below the prompt and returns the cursor', () => {
  const out = makeOutput();
  const palette = createPaletteController({ output: out });
  palette.update({ line: '/mo', cursor: 3, promptLength: 2, width: 80 });

  const drawn = frame(out);
  assert.ok(drawn.includes('/model'));
  // one suggestion row: down one line, then back up one line
  assert.equal(drawn.match(/\n/g).length, 1);
  assert.ok(drawn.includes('[1A'));
  // cursor restored to prompt column 2 + 3 typed cells
  assert.ok(drawn.includes('[5C'));
  assert.equal(palette.openRows, 1);
});

test('a shrinking palette blanks the rows it no longer needs', () => {
  const out = makeOutput();
  const palette = createPaletteController({ output: out });
  palette.update({ line: '/', cursor: 1, promptLength: 2, width: 80 });
  const tall = palette.openRows;
  assert.ok(tall > 1);

  out.chunks.length = 0;
  palette.update({ line: '/mo', cursor: 3, promptLength: 2, width: 80 });
  const drawn = frame(out);
  // still repaints the previously used rows so stale text cannot linger
  assert.equal(drawn.match(/\n/g).length, tall);
  assert.ok(drawn.includes(`[${tall}A`));
  assert.equal(palette.openRows, 1);
});

test('leaving slash context erases the palette', () => {
  const out = makeOutput();
  const palette = createPaletteController({ output: out });
  palette.update({ line: '/mo', cursor: 3, promptLength: 2, width: 80 });
  out.chunks.length = 0;

  palette.update({ line: 'plain text', cursor: 10, promptLength: 2, width: 80 });
  assert.equal(palette.openRows, 0);
  const drawn = frame(out);
  assert.ok(drawn.includes('[2K'));
  assert.ok(!stripAnsi(drawn).includes('/model'));
});

test('update is silent when there is nothing to draw or erase', () => {
  const out = makeOutput();
  const palette = createPaletteController({ output: out });
  palette.update({ line: 'plain', cursor: 5, promptLength: 2, width: 80 });
  assert.deepEqual(out.chunks, []);
});

test('a line too wide for the terminal keeps the palette closed', () => {
  const out = makeOutput();
  const palette = createPaletteController({ output: out });
  palette.update({ line: `/${'m'.repeat(90)}`, cursor: 3, promptLength: 2, width: 40 });
  assert.equal(palette.openRows, 0);
  assert.deepEqual(out.chunks, []);
});

test('onSubmit wipes everything below the cursor exactly once', () => {
  const out = makeOutput();
  const palette = createPaletteController({ output: out });
  palette.update({ line: '/mo', cursor: 3, promptLength: 2, width: 80 });
  out.chunks.length = 0;

  palette.onSubmit();
  assert.deepEqual(out.chunks, ['[0J']);
  assert.equal(palette.openRows, 0);

  palette.onSubmit();
  assert.deepEqual(out.chunks, ['[0J'], 'a second submit writes nothing new');
});

test('the palette caps its height for very small terminals', () => {
  const out = makeOutput();
  const palette = createPaletteController({ output: out, maxRows: 3 });
  palette.update({ line: '/', cursor: 1, promptLength: 2, width: 80 });
  assert.equal(palette.openRows, 3);
});
