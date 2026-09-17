import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BRIDGE = fileURLToPath(new URL('../src/desktop/bridge.js', import.meta.url));

/**
 * Spawn the bridge sidecar and expose a tiny driver: send NDJSON commands and
 * await events by predicate. Demo delay is zeroed so turns finish instantly and
 * an isolated HOME/export dir keeps the test hermetic (no network, no config).
 */
function startBridge() {
  const home = mkdtempSync(join(tmpdir(), 'toris-home-'));
  const exportDir = mkdtempSync(join(tmpdir(), 'toris-exp-'));
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      TORIS_HOME: home,
      TORIS_DEMO_DELAY_MS: '0',
      TORIS_EXPORT_DIR: exportDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const events = [];
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      events.push(evt);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].pred(evt)) {
          waiters[i].resolve(evt);
          waiters.splice(i, 1);
        }
      }
    }
  });

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const waitFor = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      const existing = events.find(pred);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error('timed out waiting for event')), ms);
      waiters.push({ pred, resolve: (e) => (clearTimeout(timer), resolve(e)) });
    });

  return { child, send, waitFor, events, exportDir, stop: () => child.kill() };
}

test('bridge announces ready with presets, the demo profile and a cwd', async () => {
  const b = startBridge();
  try {
    const ready = await b.waitFor((e) => e.type === 'ready');
    assert.ok(Array.isArray(ready.presets) && ready.presets.length >= 6);
    assert.ok(ready.profiles.some((p) => p.id === 'demo'));
    assert.equal(typeof ready.cwd, 'string');
    assert.equal(ready.demoProfileId, 'demo');
  } finally {
    b.stop();
  }
});

test('bridge streams a demo turn end to end', async () => {
  const b = startBridge();
  try {
    await b.waitFor((e) => e.type === 'ready');
    b.send({
      type: 'send',
      conversationId: 'c1',
      messageId: 'm1',
      text: 'hello',
      profileId: 'demo',
      presetId: 'general',
      autonomy: 'L3',
    });
    const deltas = [];
    const unsub = b.waitFor((e) => e.type === 'text' && e.messageId === 'm1');
    await unsub;
    const end = await b.waitFor((e) => e.type === 'turn-end' && e.messageId === 'm1');
    for (const e of b.events) if (e.type === 'text' && e.messageId === 'm1') deltas.push(e.delta);
    assert.ok(deltas.length > 0, 'streamed at least one text delta');
    assert.equal(end.demo, true);
    assert.match(end.text, /Demo mode/i);
  } finally {
    b.stop();
  }
});

test('bridge runs the approval-gated tool loop below L3 and honours a deny', async () => {
  const b = startBridge();
  try {
    await b.waitFor((e) => e.type === 'ready');
    b.send({
      type: 'send',
      conversationId: 'c2',
      messageId: 'm2',
      text: 'please run a command to build',
      profileId: 'demo',
      presetId: 'code',
      autonomy: 'L2',
    });
    const req = await b.waitFor((e) => e.type === 'tool-approval-request' && e.messageId === 'm2');
    assert.equal(req.name, 'run_command');
    b.send({ type: 'approval', callId: req.callId, allow: false });
    const denied = await b.waitFor((e) => e.type === 'tool-denied' && e.messageId === 'm2');
    assert.equal(denied.name, 'run_command');
    await b.waitFor((e) => e.type === 'turn-end' && e.messageId === 'm2');
  } finally {
    b.stop();
  }
});

test('bridge validates and switches the workspace folder', async () => {
  const b = startBridge();
  try {
    await b.waitFor((e) => e.type === 'ready');
    b.send({ type: 'set-cwd', path: b.exportDir });
    const ok = await b.waitFor((e) => e.type === 'workspace');
    assert.equal(ok.ok, true);
    assert.equal(ok.cwd, b.exportDir);

    b.send({ type: 'set-cwd', path: '/no/such/folder/here' });
    const bad = await b.waitFor((e) => e.type === 'workspace' && e.ok === false);
    assert.match(bad.message, /not found/i);
  } finally {
    b.stop();
  }
});

test('bridge exports a conversation to Markdown on disk', async () => {
  const b = startBridge();
  try {
    await b.waitFor((e) => e.type === 'ready');
    b.send({
      type: 'export-conversation',
      conversationId: 'c3',
      conversation: {
        id: 'c3',
        title: 'Export me',
        presetId: 'email',
        messages: [
          { role: 'user', content: 'draft a note' },
          { role: 'assistant', content: 'Subject: Hi\n\nHello.' },
        ],
      },
    });
    const res = await b.waitFor((e) => e.type === 'export-result');
    assert.equal(res.ok, true);
    assert.match(res.path, /toris-export-me-.*\.md$/);
    assert.match(res.markdown, /Subject: Hi/);
  } finally {
    b.stop();
  }
});
