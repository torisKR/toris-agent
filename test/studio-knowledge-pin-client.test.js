import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWLEDGE_PIN_KEY,
  clearKnowledgePin,
  consumeKnowledgePinAfterAccept,
  knowledgePinFromStorage,
  withStoredKnowledgePin,
  writeKnowledgePin,
} from '../src/studio/ui/knowledge-pin-client.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.hasOwn(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

function androidTurnBody({ message = 'the CTA is clipped', artifacts = ['screenshots/ok.png'], storage }) {
  return withStoredKnowledgePin({
    agent: 'implementer',
    message,
    android: { artifacts },
  }, storage);
}

test('android turn payload includes the stored pin and consumes it only after accept', () => {
  const storage = memoryStorage();
  writeKnowledgePin({ domain: 'toris-ops', nodeId: 'receipts-not-vibes' }, storage);

  const { payload, knowledge } = androidTurnBody({ storage });
  assert.deepEqual(payload, {
    agent: 'implementer',
    message: 'the CTA is clipped',
    android: { artifacts: ['screenshots/ok.png'] },
    knowledge: { domain: 'toris-ops', nodeId: 'receipts-not-vibes' },
  });
  assert.deepEqual(knowledge, { domain: 'toris-ops', nodeId: 'receipts-not-vibes' });
  assert.deepEqual(knowledgePinFromStorage(storage), { domain: 'toris-ops', nodeId: 'receipts-not-vibes' });

  consumeKnowledgePinAfterAccept(knowledge, storage);
  assert.equal(knowledgePinFromStorage(storage), null);
  assert.equal(storage.getItem(KNOWLEDGE_PIN_KEY), null);
});

test('android turn with no pin stays artifact-only', () => {
  const storage = memoryStorage();
  const { payload, knowledge } = androidTurnBody({ storage });
  assert.equal(knowledge, null);
  assert.equal(Object.hasOwn(payload, 'knowledge'), false);
  assert.deepEqual(payload, {
    agent: 'implementer',
    message: 'the CTA is clipped',
    android: { artifacts: ['screenshots/ok.png'] },
  });
});

function sendAndroidTurn({ ok, storage, ...rest }) {
  const built = androidTurnBody({ ...rest, storage });
  if (!ok) return built;
  consumeKnowledgePinAfterAccept(built.knowledge, storage);
  return built;
}

test('a failed send does not consume the stored pin', () => {
  const storage = memoryStorage();
  writeKnowledgePin({ domain: 'flutter-android', nodeId: 'mid-device-pin' }, storage);

  const failed = sendAndroidTurn({ ok: false, storage });
  assert.deepEqual(failed.payload.knowledge, { domain: 'flutter-android', nodeId: 'mid-device-pin' });
  assert.deepEqual(knowledgePinFromStorage(storage), { domain: 'flutter-android', nodeId: 'mid-device-pin' });

  consumeKnowledgePinAfterAccept(null, storage);
  assert.deepEqual(knowledgePinFromStorage(storage), { domain: 'flutter-android', nodeId: 'mid-device-pin' });

  const accepted = sendAndroidTurn({ ok: true, storage });
  assert.deepEqual(accepted.payload.knowledge, { domain: 'flutter-android', nodeId: 'mid-device-pin' });
  assert.equal(knowledgePinFromStorage(storage), null);
});

test('design and agent turns share the same pin store and consume rule', () => {
  const storage = memoryStorage();
  storage.setItem(KNOWLEDGE_PIN_KEY, JSON.stringify({ domain: 'toris-ops', id: 'receipts-not-vibes' }));
  assert.deepEqual(knowledgePinFromStorage(storage), { domain: 'toris-ops', nodeId: 'receipts-not-vibes' });

  const design = withStoredKnowledgePin({ agent: 'implementer', message: 'fix the tray', tray: true }, storage);
  assert.deepEqual(design.payload.knowledge, { domain: 'toris-ops', nodeId: 'receipts-not-vibes' });
  assert.ok(design.payload.tray);
  assert.deepEqual(knowledgePinFromStorage(storage), { domain: 'toris-ops', nodeId: 'receipts-not-vibes' });
  consumeKnowledgePinAfterAccept(design.knowledge, storage);
  assert.equal(knowledgePinFromStorage(storage), null);
});

test('malformed or empty storage is treated as no pin', () => {
  assert.equal(knowledgePinFromStorage(memoryStorage({ [KNOWLEDGE_PIN_KEY]: 'not-json' })), null);
  assert.equal(knowledgePinFromStorage(memoryStorage({ [KNOWLEDGE_PIN_KEY]: 'null' })), null);
  assert.equal(knowledgePinFromStorage(memoryStorage({ [KNOWLEDGE_PIN_KEY]: JSON.stringify({ domain: 'toris-ops' }) })), null);
  assert.equal(knowledgePinFromStorage(undefined), null);
  clearKnowledgePin(undefined);
});

test('android and app clients import the shared pin helper and consume after accept', async () => {
  const android = await readFile(join(repoRoot, 'src/studio/ui/android.js'), 'utf8');
  assert.match(android, /from ['"]\.\/knowledge-pin-client\.js['"]/);
  assert.match(android, /withStoredKnowledgePin/);
  assert.match(android, /consumeKnowledgePinAfterAccept\(knowledge\)/);
  const consumeAt = android.indexOf('consumeKnowledgePinAfterAccept(knowledge)');
  const requestAt = android.indexOf("api('/api/agent/turn'");
  assert.ok(requestAt > 0 && consumeAt > requestAt);

  const app = await readFile(join(repoRoot, 'src/studio/ui/app.js'), 'utf8');
  assert.match(app, /from ['"]\.\/knowledge-pin-client\.js['"]/);
  assert.match(app, /withStoredKnowledgePin\(payload\)/);
  assert.match(app, /consumeKnowledgePinAfterAccept\(knowledge\)/);
  assert.doesNotMatch(app, /localStorage\.removeItem\(KNOWLEDGE_PIN_KEY\)/);

  const knowledge = await readFile(join(repoRoot, 'src/studio/ui/knowledge.js'), 'utf8');
  assert.match(knowledge, /from ['"]\.\/knowledge-pin-client\.js['"]/);
  assert.match(knowledge, /writeKnowledgePin/);
  assert.doesNotMatch(knowledge, /toris\.studio\.knowledge\.pin/);
});
