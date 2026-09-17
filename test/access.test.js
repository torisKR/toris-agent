import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  studioAgentUrl,
  studioDesignUrl,
  studioPatchesUrl,
  studioKnowledgeUrl,
  studioDaemonUrl,
  studioBriefUrl,
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
  assert.equal(studioDesignUrl(), 'http://127.0.0.1:5824/design');
  assert.equal(studioPatchesUrl(), 'http://127.0.0.1:5824/patches');
  assert.equal(studioKnowledgeUrl(), 'http://127.0.0.1:5824/knowledge');
  assert.equal(studioDaemonUrl(), 'http://127.0.0.1:5824/daemon');
  assert.equal(studioBriefUrl(), 'http://127.0.0.1:5824/brief');
  assert.equal(studioAgentUrl(0), 'http://127.0.0.1:0/agent');
});

test('TUI and GUI directions name both doors onto the same agent', () => {
  const idle = renderStudioAccess({ running: false });
  assert.match(idle, /GUI {2}http:\/\/127\.0\.0\.1:5824\/agent/);
  assert.match(idle, /http:\/\/127\.0\.0\.1:5824\/design/);
  assert.match(idle, /http:\/\/127\.0\.0\.1:5824\/patches/);
  assert.match(idle, /http:\/\/127\.0\.0\.1:5824\/knowledge/);
  assert.match(idle, /http:\/\/127\.0\.0\.1:5824\/daemon/);
  assert.match(idle, /http:\/\/127\.0\.0\.1:5824\/brief/);
  assert.match(idle, /TUI {2}toris/);
  assert.match(idle, /toris studio --open/);

  const live = renderStudioAccess({ running: true });
  assert.match(live, /already running/);
  assert.doesNotMatch(live, /start the local GUI/);
});

test('openLocalCommand picks a no-shell opener per platform', () => {
  assert.deepEqual(openLocalCommand('linux'), { command: 'xdg-open', args: [] });
  assert.deepEqual(openLocalCommand('darwin'), { command: 'open', args: [] });
  assert.deepEqual(openLocalCommand('win32'), { command: 'cmd', args: ['/c', 'start', ''] });
});

test('openLocalUrl uses an injected opener and never shells out', async () => {
  const opened = [];
  const result = await openLocalUrl('http://127.0.0.1:5824/agent', {
    opener(url) {
      opened.push(url);
      return { ok: true };
    },
    spawn() {
      throw new Error('must not spawn when opener is injected');
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(opened, ['http://127.0.0.1:5824/agent']);
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
  assert.equal(isLoopbackHttpUrl('http://[::1]:5824/'), true);
  assert.equal(isLoopbackHttpUrl('https://example.com'), false);
  assert.equal(isLoopbackHttpUrl('http://192.168.1.10/'), false);
  const result = await openLocalUrl('https://example.com', {
    opener() {
      throw new Error('must not open');
    },
    spawn() {
      throw new Error('must not spawn');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /loopback/);
});

test('the GUI inspector can show the typed TUI equivalent', () => {
  assert.equal(tuiAgentHint(), 'toris\n/agent');
  assert.equal(tuiAgentHint('toris'), 'toris\n/agent');
  assert.equal(tuiAgentHint('implementer'), 'toris --agent implementer\n/agent implementer');
});
