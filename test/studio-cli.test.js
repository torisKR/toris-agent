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
