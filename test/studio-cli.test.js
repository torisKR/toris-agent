import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cmdStudio } from '../src/cli/commands/studio.js';

test('studio command binds the fixed loopback address and shuts down on SIGTERM', async () => {
  const signals = new EventEmitter();
  let options;
  let closed = false;
  const code = await cmdStudio({ home: '/tmp/toris-home', json: false }, [], {}, {
    signals,
    output() {},
    createStudioServer: async (value) => {
      options = value;
      return {
        listen: async () => {},
        close: async () => { closed = true; },
      };
    },
    onReady: () => setImmediate(() => signals.emit('SIGTERM')),
  });
  assert.equal(code, 0);
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 5824);
  assert.equal(closed, true);
});

test('studio command rejects foreground arguments it does not own', async () => {
  await assert.rejects(cmdStudio({ home: '/tmp/home' }, ['wat'], {}, {}), /studio subcommand/);
});

test('studio command turns EADDRINUSE into a stable local error', async () => {
  await assert.rejects(cmdStudio({ home: '/tmp/home' }, [], {}, {
    signals: new EventEmitter(),
    output() {},
    createStudioServer: async () => ({
      listen: async () => { const error = new Error('busy'); error.code = 'EADDRINUSE'; throw error; },
      close: async () => {},
    }),
  }), (error) => error.code === 'E_STUDIO_IN_USE' && /5824/.test(error.message));
});

test('studio service subcommands delegate without starting the foreground server', async () => {
  const calls = [];
  const payloads = [];
  const manager = {
    install: async () => { calls.push('install'); return { installed: true, running: true }; },
    status: async () => { calls.push('status'); return { installed: true, running: true }; },
    restart: async () => { calls.push('restart'); return { installed: true, running: true }; },
    uninstall: async () => { calls.push('uninstall'); return { installed: false, running: false }; },
  };
  for (const subcommand of ['install', 'status', 'restart', 'uninstall']) {
    assert.equal(await cmdStudio({ home: '/tmp/home', json: true }, ['service', subcommand], {}, { serviceManager: manager, printJson: (value) => payloads.push(value) }), 0);
  }
  assert.deepEqual(calls, ['install', 'status', 'restart', 'uninstall']);
  assert.deepEqual(payloads.map((value) => value.running), [true, true, true, false]);
});
