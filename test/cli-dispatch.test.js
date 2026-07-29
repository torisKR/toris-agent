import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, resolveInvocation, isInteractiveTerminal } from '../src/cli/index.js';
import { EXIT } from '../src/core/errors.js';

const flags = (extra = {}) => ({ ...extra });

/** Captures stdout for the duration of one call. */
async function captureStdout(fn) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    return { result: await fn(), out: written.join('') };
  } finally {
    process.stdout.write = original;
  }
}

/** A throwaway ~/.toris containing exactly the config we hand it. */
async function fakeHome(config) {
  const home = await mkdtemp(join(tmpdir(), 'toris-dispatch-'));
  if (config) {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify(config), 'utf8');
  }
  return home;
}

const workingConfig = {
  version: 1,
  models: {
    profiles: { main: { provider: 'anthropic', model: 'model-id' } },
    routing: { chat: 'main' },
  },
};

// --- resolveInvocation ------------------------------------------------------

test('a bare invocation at a terminal opens chat', () => {
  const invocation = resolveInvocation({ positionals: [], flags: flags(), isInteractive: true });
  assert.deepEqual(invocation, { kind: 'command', name: 'chat', isDefault: true });
});

test('a bare invocation without a terminal keeps the help-and-fail contract', () => {
  const invocation = resolveInvocation({ positionals: [], flags: flags(), isInteractive: false });
  assert.deepEqual(invocation, { kind: 'help', exitCode: EXIT.USAGE });
});

test('--json never opens a prompt nobody can answer', () => {
  const invocation = resolveInvocation({
    positionals: [],
    flags: flags({ json: true }),
    isInteractive: true,
  });
  assert.equal(invocation.kind, 'help');
});

test('an explicit command still wins over the default', () => {
  const invocation = resolveInvocation({
    positionals: ['doctor'],
    flags: flags(),
    isInteractive: true,
  });
  assert.deepEqual(invocation, { kind: 'command', name: 'doctor', isDefault: false });
});

test('--help is help, and is only a usage error when nothing else was asked', () => {
  assert.deepEqual(
    resolveInvocation({ positionals: [], flags: flags({ help: true }), isInteractive: true }),
    { kind: 'help', exitCode: EXIT.USAGE },
  );
  assert.deepEqual(
    resolveInvocation({ positionals: ['run'], flags: flags({ help: true }), isInteractive: true }),
    { kind: 'help', exitCode: EXIT.OK },
  );
});

test('interactivity needs both halves of the terminal', () => {
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: true }, stdout: {} }), false);
  assert.equal(isInteractiveTerminal({ stdin: {}, stdout: { isTTY: true } }), false);
  assert.equal(isInteractiveTerminal({}), false);
});

// --- main() dispatch --------------------------------------------------------

test('bare `toris` on a TTY runs the chat command', async () => {
  const home = await fakeHome(workingConfig);
  const calls = [];
  const chat = async (ctx) => {
    calls.push(ctx);
    return EXIT.OK;
  };
  chat.handlesFirstRun = true;

  const code = await main(['--home', home], { commands: { chat }, isInteractive: true });

  assert.equal(code, EXIT.OK);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].configExists, true);
});

test('bare `toris` in a pipe prints help and fails, so scripts do not hang', async () => {
  const chat = async () => {
    throw new Error('chat must not run without a terminal');
  };

  const { result, out } = await captureStdout(() =>
    main([], { commands: { chat }, isInteractive: false }),
  );

  assert.equal(result, EXIT.USAGE);
  assert.match(out, /USAGE/);
});

test('help documents that a bare toris opens the TUI', async () => {
  const { out } = await captureStdout(() => main(['--help'], { isInteractive: false }));
  assert.match(out, /toris\s+Open the interactive chat TUI/);
});

// --- first-run onboarding ---------------------------------------------------

test('an unconfigured default launch onboards instead of crashing', async () => {
  const home = await fakeHome(null);
  const chat = async () => {
    throw new Error('chat must not run before anything is configured');
  };

  const { result, out } = await captureStdout(() =>
    main(['--home', home], { commands: { chat }, isInteractive: true }),
  );

  assert.equal(result, EXIT.OK, 'a first run is not an error');
  assert.match(out, /toris init/);
  assert.doesNotMatch(out, /E_CONFIG/);
});

test('a command that onboards itself is not preempted by the static message', async () => {
  const home = await fakeHome(null);
  let ran = false;
  const chat = async () => {
    ran = true;
    return EXIT.OK;
  };
  chat.handlesFirstRun = true;

  const code = await main(['--home', home], { commands: { chat }, isInteractive: true });

  assert.equal(ran, true);
  assert.equal(code, EXIT.OK);
});

test('an explicit command still fails loudly when nothing is configured', async () => {
  const home = await fakeHome(null);
  const chat = async () => {
    throw Object.assign(new Error('no profiles'), { exitCode: EXIT.FAILURE });
  };

  const code = await main(['chat', '--home', home], { commands: { chat }, isInteractive: true });

  assert.notEqual(code, EXIT.OK);
});

test('an unknown command is a usage error, not a crash', async () => {
  const code = await main(['nope', '--json'], { isInteractive: false });
  assert.equal(code, EXIT.USAGE);
});
