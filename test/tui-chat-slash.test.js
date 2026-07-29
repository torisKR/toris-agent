import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSlashCommand,
  isQuitWord,
  isKnownSlashCommand,
  renderSlashHelp,
  SLASH_COMMANDS,
} from '../src/cli/tui/slash.js';
import { createInterruptPolicy, DOUBLE_PRESS_WINDOW_MS } from '../src/cli/tui/interrupt.js';
import { stripAnsi, stringWidth } from '../src/cli/tui/text.js';

// --- slash grammar ----------------------------------------------------------

test('prose is never mistaken for a command', () => {
  assert.equal(parseSlashCommand('what does /help do?'), null);
  assert.equal(parseSlashCommand('quit the loop early'), null);
  assert.equal(parseSlashCommand(''), null);
  assert.equal(parseSlashCommand(undefined), null);
});

test('a bare command parses to a name with no arguments', () => {
  assert.deepEqual(parseSlashCommand('/help'), {
    name: 'help',
    args: [],
    known: true,
    raw: '/help',
  });
});

test('arguments survive surrounding and repeated whitespace', () => {
  const parsed = parseSlashCommand('  /model   fast   extra  ');
  assert.equal(parsed.name, 'model');
  assert.deepEqual(parsed.args, ['fast', 'extra']);
});

test('aliases and casing map onto the canonical command', () => {
  assert.equal(parseSlashCommand('/QUIT').name, 'exit');
  assert.equal(parseSlashCommand('/q').name, 'exit');
  assert.equal(parseSlashCommand('/?').name, 'help');
  assert.equal(parseSlashCommand('/profile main').name, 'model');
  assert.equal(parseSlashCommand('/reset').name, 'clear');
  assert.equal(parseSlashCommand('/tokens').name, 'usage');
});

test('an unrecognised command is reported, not guessed at', () => {
  const parsed = parseSlashCommand('/frobnicate');
  assert.equal(parsed.known, false);
  assert.equal(parsed.name, 'frobnicate');
  assert.equal(parsed.raw, '/frobnicate');
});

test('a lone slash is a command with an empty name, not a crash', () => {
  const parsed = parseSlashCommand('/');
  assert.equal(parsed.known, false);
  assert.deepEqual(parsed.args, []);
});

test('only a bare q quits without a slash', () => {
  assert.equal(isQuitWord('q'), true);
  assert.equal(isQuitWord(' Q '), true);
  assert.equal(isQuitWord('quit'), false, 'a word the model could answer stays a message');
  assert.equal(isQuitWord('query the database'), false);
});

test('every advertised command is one the REPL recognises', () => {
  for (const cmd of SLASH_COMMANDS) {
    assert.equal(isKnownSlashCommand(cmd.name), true, cmd.name);
    assert.equal(parseSlashCommand(`/${cmd.name}`).known, true, cmd.name);
  }
});

test('help lists every command in aligned columns', () => {
  const help = stripAnsi(renderSlashHelp());
  const lines = help.split('\n');
  assert.equal(lines.length, SLASH_COMMANDS.length);
  for (const cmd of SLASH_COMMANDS) assert.match(help, new RegExp(`/${cmd.name}`));

  const summaryColumns = lines.map((l) => l.indexOf(l.trim().split(/\s{2,}/)[1] ?? ''));
  assert.equal(new Set(summaryColumns).size, 1, 'summaries share one column');
});

// --- ctrl-c policy ----------------------------------------------------------

test('ctrl-c during generation cancels the turn and nothing else', () => {
  const policy = createInterruptPolicy();
  assert.equal(policy.press({ isGenerating: true }), 'cancel');
  assert.equal(policy.press({ isGenerating: true }), 'cancel');
});

test('ctrl-c with a half-typed line clears the line', () => {
  const policy = createInterruptPolicy();
  assert.equal(policy.press({ hasInput: true }), 'clear');
});

test('ctrl-c at an empty prompt asks first, then exits', () => {
  const policy = createInterruptPolicy();
  assert.equal(policy.press({}), 'confirm');
  assert.equal(policy.press({}), 'exit');
});

test('a slow second press is a fresh request, not a confirmation', () => {
  let clock = 1000;
  const policy = createInterruptPolicy({ now: () => clock });

  assert.equal(policy.press({}), 'confirm');
  clock += DOUBLE_PRESS_WINDOW_MS + 1;
  assert.equal(policy.press({}), 'confirm', 'the earlier press has expired');
  clock += 1;
  assert.equal(policy.press({}), 'exit');
});

test('cancelling work does not count toward a double press', () => {
  const policy = createInterruptPolicy();

  assert.equal(policy.press({}), 'confirm');
  assert.equal(policy.press({ isGenerating: true }), 'cancel');
  assert.equal(policy.press({}), 'confirm', 'the pending confirmation was consumed by the cancel');
});

test('clearing a line does not count toward a double press', () => {
  const policy = createInterruptPolicy();

  assert.equal(policy.press({}), 'confirm');
  assert.equal(policy.press({ hasInput: true }), 'clear');
  assert.equal(policy.press({}), 'confirm');
});

test('exiting resets the policy, so a reused session starts clean', () => {
  const policy = createInterruptPolicy();
  policy.press({});
  assert.equal(policy.press({}), 'exit');
  assert.equal(policy.press({}), 'confirm');
});

test('help stays inside a narrow terminal', () => {
  for (const line of stripAnsi(renderSlashHelp()).split('\n')) {
    assert.ok(stringWidth(line) <= 80, line);
  }
});
