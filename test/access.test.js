import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  studioAgentUrl,
  studioOrigin,
  renderStudioAccess,
  tuiAgentHint,
  openLocalCommand,
  openLocalUrl,
  isLoopbackHttpUrl,
} from '../src/core/access.js';

test('studio URLs stay on loopback and name the agent room', () => {
  assert.equal(studioOrigin(), 'http://127.0.0.1:5824');
  assert.equal(studioAgentUrl(), 'http://127.0.0.1:5824/agent');
  assert.equal(studioAgentUrl(0), 'http://127.0.0.1:0/agent');
  assert.equal(studioAgentUrl(5824, 'implementer'), 'http://127.0.0.1:5824/agent?id=implementer');
});

test('TUI and GUI directions name both doors onto the same agent', () => {
  const idle = renderStudioAccess({ running: false });
  assert.match(idle, /GUI {2}http:\/\/127\.0\.0\.1:5824\/agent/);
  assert.match(idle, /TUI {2}toris/);
  assert.match(idle, /toris studio/);

  const live = renderStudioAccess({ running: true, agentId: 'planner' });
  assert.match(live, /already running/);
  assert.match(live, /\/agent\?id=planner/);
  assert.doesNotMatch(live, /start the local GUI/);
});

test('the GUI inspector can show the typed TUI equivalent', () => {
  assert.equal(tuiAgentHint(), 'toris\n/agent');
  assert.equal(tuiAgentHint('toris'), 'toris\n/agent');
  assert.equal(tuiAgentHint('implementer'), 'toris --agent implementer\n/agent implementer');
});

test('openLocalCommand picks a no-shell opener per platform', () => {
  assert.deepEqual(openLocalCommand('linux'), { command: 'xdg-open', args: [] });
  assert.deepEqual(openLocalCommand('darwin'), { command: 'open', args: [] });
  assert.deepEqual(openLocalCommand('win32'), { command: 'cmd', args: ['/c', 'start', ''] });
});

test('openLocalUrl spawns the platform opener for loopback http', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => {
    child.unrefed = true;
  };
  const result = await openLocalUrl('http://127.0.0.1:5824/agent', {
    platform: 'linux',
    spawn(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].command, 'xdg-open');
  assert.deepEqual(calls[0].args, ['http://127.0.0.1:5824/agent']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(child.unrefed, true);
});

test('openLocalUrl refuses anything that is not loopback http', async () => {
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1:5824/agent'), true);
  assert.equal(isLoopbackHttpUrl('http://localhost:5824/'), true);
  assert.equal(isLoopbackHttpUrl('https://example.com'), false);
  const result = await openLocalUrl('https://example.com', {
    spawn() {
      throw new Error('must not spawn');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /loopback/);
});
