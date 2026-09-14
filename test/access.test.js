import { test } from 'node:test';
import assert from 'node:assert/strict';

import { studioAgentUrl, studioOrigin, renderStudioAccess, tuiAgentHint } from '../src/core/access.js';

test('studio URLs stay on loopback and name the agent room', () => {
  assert.equal(studioOrigin(), 'http://127.0.0.1:5824');
  assert.equal(studioAgentUrl(), 'http://127.0.0.1:5824/agent');
  assert.equal(studioAgentUrl(0), 'http://127.0.0.1:0/agent');
});

test('TUI and GUI directions name both doors onto the same agent', () => {
  const idle = renderStudioAccess({ running: false });
  assert.match(idle, /GUI {2}http:\/\/127\.0\.0\.1:5824\/agent/);
  assert.match(idle, /TUI {2}toris/);
  assert.match(idle, /toris studio/);

  const live = renderStudioAccess({ running: true });
  assert.match(live, /already running/);
  assert.doesNotMatch(live, /start the local GUI/);
});

test('the GUI inspector can show the typed TUI equivalent', () => {
  assert.equal(tuiAgentHint(), 'toris\n/agent');
  assert.equal(tuiAgentHint('toris'), 'toris\n/agent');
  assert.equal(tuiAgentHint('implementer'), 'toris --agent implementer\n/agent implementer');
});
