import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { runAgentTurn } from '../src/studio/agent-runtime.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { excerptBody } from '../src/studio/knowledge-dag.js';
import {
  composePinnedKnowledgeTurn,
  knowledgePinOf,
  loadPinnedKnowledge,
} from '../src/studio/knowledge-pin.js';
import { HttpError } from '../src/studio/http.js';

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-know-pin-'));
  const studio = await createStudioServer({
    home,
    cwd: home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    ...extra,
  });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    await fn({ base, home });
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
}

async function snapshotKnowledge(home) {
  const root = join(home, 'knowledge');
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const info = await stat(path);
      files.push({ rel: path.slice(root.length), size: info.size, text: await readFile(path, 'utf8') });
    }
  }
  await walk(root);
  return files;
}

function mutation(base, body) {
  return {
    method: 'POST',
    headers: {
      origin: base,
      'x-toris-studio-token': 'test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function fakeProvider(seen) {
  return {
    name: 'fake',
    async *stream({ messages }) {
      seen.push(messages);
      yield { type: 'text', delta: 'ok' };
      yield {
        type: 'done',
        text: 'ok',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

async function writeChatConfig(home, extra = {}) {
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      models: {
        profiles: { main: { provider: 'anthropic', model: 'model-id' } },
        routing: { chat: 'main' },
      },
      knowledge: { autoRetrieve: false },
      ...extra,
    }),
  );
}

test('knowledgePinOf treats an omitted pin as today and a missing id as 400', () => {
  assert.equal(knowledgePinOf({}), null);
  assert.equal(knowledgePinOf({ message: 'hi' }), null);
  assert.equal(knowledgePinOf({ knowledge: null }), null);
  assert.throws(
    () => knowledgePinOf({ knowledge: { domain: 'toris-ops' } }),
    (error) => error instanceof HttpError && error.status === 400 && /nodeId/.test(error.message),
  );
  assert.deepEqual(knowledgePinOf({ knowledge: { domain: 'toris-ops', nodeId: 'receipts-not-vibes' } }), {
    domain: 'toris-ops',
    nodeId: 'receipts-not-vibes',
  });
});

test('composePinnedKnowledgeTurn prepends title, kind, and a capped excerpt', () => {
  const longBody = `A run is not done because an agent said so. ${'x'.repeat(400)}`;
  const node = {
    id: 'receipts-not-vibes',
    title: 'Receipts, not vibes',
    kind: 'node',
    excerpt: excerptBody(longBody),
    domain: 'toris-ops',
  };
  assert.equal(composePinnedKnowledgeTurn('ship this', null), 'ship this');
  const pinned = composePinnedKnowledgeTurn('ship this', node);
  assert.match(pinned, /^\[pinned knowledge\]/);
  assert.match(pinned, /title: Receipts, not vibes/);
  assert.match(pinned, /kind: node/);
  assert.match(pinned, /excerpt: A run is not done because an agent said so/);
  assert.match(pinned, /ship this$/);
  assert.doesNotMatch(pinned, /\[knowledge context\]/);
  assert.ok(node.excerpt.endsWith('…'));
  assert.ok(node.excerpt.length <= 180);
  assert.ok(pinned.includes(node.excerpt));
  assert.ok(!pinned.includes('x'.repeat(200)));
});

test('loadPinnedKnowledge returns the real excerpt and 400s an unknown id without fabricating text', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-pin-store-'));
  try {
    const store = new KnowledgeStore({ home, projectPath: home });
    await store.init({ seed: true });
    const longBody = `Cite the receipt path, not a vibe. ${'y'.repeat(300)}`;
    await store.addNode('toris-ops', { title: 'Pin excerpt fixture', body: longBody });
    const loaded = await loadPinnedKnowledge(store, { domain: 'toris-ops', nodeId: 'pin-excerpt-fixture' });
    assert.equal(loaded.id, 'pin-excerpt-fixture');
    assert.equal(loaded.title, 'Pin excerpt fixture');
    assert.equal(loaded.kind, 'node');
    assert.equal(loaded.domain, 'toris-ops');
    assert.match(loaded.excerpt, /Cite the receipt path/);
    assert.ok(loaded.excerpt.endsWith('…'));
    assert.ok(loaded.excerpt.length <= 180);
    assert.ok(!loaded.excerpt.includes('y'.repeat(200)));

    await assert.rejects(
      () => loadPinnedKnowledge(store, { domain: 'toris-ops', nodeId: 'no-such-node' }),
      (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 400);
        assert.match(error.message, /Unknown node "toris-ops\/no-such-node"/);
        assert.doesNotMatch(error.message, /Cite the receipt path/);
        assert.doesNotMatch(error.message, /fabricat/i);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('GET /knowledge ships one use-on-next-turn control without changing the DAG GET shape', async () => {
  await withServer(async ({ base, home }) => {
    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });

    const page = await fetch(`${base}/knowledge`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="knowledge-dag"/);
    assert.match(html, /id="dag-nodes"/);
    assert.match(html, /id="reflect-accept"/);
    assert.match(html, /id="add-node-form"/);

    const script = await (await fetch(`${base}/assets/knowledge.js`)).text();
    assert.match(script, /use on next turn/);
    assert.match(script, /knowledge-pin-client\.js/);
    assert.match(script, /nodeId/);
    assert.match(script, /\/api\/knowledge\/domains\/\$\{encodeURIComponent\(slug\)\}\/dag/);

    const pinClient = await (await fetch(`${base}/assets/knowledge-pin-client.js`)).text();
    assert.match(pinClient, /toris\.studio\.knowledge\.pin/);
    assert.equal((await fetch(`${base}/assets/knowledge-pin-client.js`)).status, 200);

    const agent = await (await fetch(`${base}/assets/app.js`)).text();
    assert.match(agent, /withStoredKnowledgePin/);
    assert.match(agent, /consumeKnowledgePinAfterAccept/);
    assert.match(agent, /\/api\/agent\/turn/);

    const android = await (await fetch(`${base}/assets/android.js`)).text();
    assert.match(android, /withStoredKnowledgePin/);
    assert.match(android, /consumeKnowledgePinAfterAccept/);
    assert.match(android, /\/api\/agent\/turn/);

    const dag = await (await fetch(`${base}/api/knowledge/domains/toris-ops/dag`)).json();
    assert.deepEqual(Object.keys(dag.nodes[0]).sort(), ['excerpt', 'id', 'kind', 'title']);
    assert.equal(Object.hasOwn(dag, 'pinned'), false);
    assert.equal(Object.hasOwn(dag.nodes[0], 'body'), false);
  });
});

test('POST /api/agent/turn without a pin has no pinned knowledge block', async () => {
  let received;
  await withServer(
    async ({ base, home }) => {
      const knowledge = new KnowledgeStore({ home, projectPath: home });
      await knowledge.init({ seed: true });
      const before = await snapshotKnowledge(home);

      const response = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, { agent: 'implementer', message: 'ship the Play build' }),
      );
      assert.equal(response.status, 200);
      assert.equal(received.knowledge, null);
      assert.equal(received.pinnedKnowledge, null);
      const composed = composePinnedKnowledgeTurn(received.message, received.pinnedKnowledge);
      assert.equal(composed, 'ship the Play build');
      assert.doesNotMatch(composed, /\[pinned knowledge\]/);
      assert.deepEqual(await snapshotKnowledge(home), before);
    },
    {
      runAgentTurn: async (input) => {
        received = input;
        return { ok: true, text: 'will ship', agent: { id: 'implementer', title: 'Implementer' } };
      },
    },
  );
});

test('POST /api/agent/turn with a pin includes the real excerpt and does not write', async () => {
  let received;
  await withServer(
    async ({ base, home }) => {
      const knowledge = new KnowledgeStore({ home, projectPath: home });
      await knowledge.init({ seed: true });
      const longBody = `Always measure on a mid-range phone. ${'z'.repeat(280)}`;
      const node = await knowledge.addNode('flutter-android', {
        title: 'Mid-device pin',
        body: longBody,
      });
      const before = await snapshotKnowledge(home);

      const response = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, {
          agent: 'implementer',
          message: 'fix jank on a cheap phone',
          knowledge: { domain: 'flutter-android', nodeId: node.id },
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(received.knowledge.domain, 'flutter-android');
      assert.equal(received.knowledge.nodeId, node.id);
      assert.equal(received.pinnedKnowledge.id, node.id);
      assert.equal(received.pinnedKnowledge.title, 'Mid-device pin');
      assert.equal(received.pinnedKnowledge.kind, 'node');
      assert.match(received.pinnedKnowledge.excerpt, /Always measure on a mid-range phone/);
      assert.ok(received.pinnedKnowledge.excerpt.endsWith('…'));
      assert.ok(received.pinnedKnowledge.excerpt.length <= 180);
      assert.ok(!received.pinnedKnowledge.excerpt.includes('z'.repeat(200)));
      const composed = composePinnedKnowledgeTurn(received.message, received.pinnedKnowledge);
      assert.match(composed, /\[pinned knowledge\]/);
      assert.match(composed, /Always measure on a mid-range phone/);
      assert.match(composed, /fix jank on a cheap phone$/);
      assert.ok(composed.includes(received.pinnedKnowledge.excerpt));
      assert.deepEqual(await snapshotKnowledge(home), before);
    },
    {
      runAgentTurn: async (input) => {
        received = input;
        return { ok: true, text: 'will measure', agent: { id: 'implementer', title: 'Implementer' } };
      },
    },
  );
});

test('POST /api/agent/turn with an unknown pin is 400, does not call the model, and does not fabricate text', async () => {
  let called = false;
  await withServer(
    async ({ base, home }) => {
      const knowledge = new KnowledgeStore({ home, projectPath: home });
      await knowledge.init({ seed: true });
      const before = await snapshotKnowledge(home);

      const response = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, {
          agent: 'implementer',
          message: 'use a ghost note',
          knowledge: { domain: 'toris-ops', nodeId: 'definitely-missing-node' },
        }),
      );
      assert.equal(response.status, 400);
      assert.equal(called, false);
      const body = await response.json();
      assert.match(body.error.message, /Unknown node "toris-ops\/definitely-missing-node"/);
      assert.doesNotMatch(JSON.stringify(body), /\[pinned knowledge\]/);
      assert.doesNotMatch(body.error.message, /Receipts, not vibes/);
      assert.deepEqual(await snapshotKnowledge(home), before);
    },
    {
      runAgentTurn: async () => {
        called = true;
        throw new Error('runner must not be called for an unknown knowledge pin');
      },
    },
  );
});

test('runAgentTurn prepends a pinned excerpt and leaves an unpinned turn untouched', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-pin-turn-'));
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
  try {
    await writeChatConfig(home);
    const store = new KnowledgeStore({ home, projectPath: home });
    await store.init({ seed: true });
    const longBody = `Receipts beat vibes on this machine. ${'w'.repeat(260)}`;
    const node = await store.addNode('toris-ops', { title: 'Pinned receipt', body: longBody });
    const before = await snapshotKnowledge(home);

    const unpinnedSeen = [];
    const unpinned = await runAgentTurn({
      home,
      cwd: home,
      agent: 'implementer',
      message: 'what should I do next',
      provider: fakeProvider(unpinnedSeen),
    });
    const unpinnedText = JSON.stringify(unpinnedSeen);
    assert.doesNotMatch(unpinnedText, /\[pinned knowledge\]/);
    assert.doesNotMatch(unpinnedText, /Pinned receipt/);
    assert.equal(unpinned.knowledge.pinned, null);

    const pinnedSeen = [];
    const pinned = await runAgentTurn({
      home,
      cwd: home,
      agent: 'implementer',
      message: 'what should I do next',
      knowledge: { domain: 'toris-ops', nodeId: node.id },
      provider: fakeProvider(pinnedSeen),
    });
    const pinnedText = JSON.stringify(pinnedSeen);
    assert.match(pinnedText, /\[pinned knowledge\]/);
    assert.match(pinnedText, /title: Pinned receipt/);
    assert.match(pinnedText, /kind: node/);
    assert.match(pinnedText, /Receipts beat vibes on this machine/);
    assert.match(pinnedText, /what should I do next/);
    assert.ok(!pinnedText.includes('w'.repeat(200)));
    assert.equal(pinned.knowledge.pinned.id, node.id);
    assert.deepEqual(await snapshotKnowledge(home), before);

    const failedSeen = [];
    await assert.rejects(
      () => runAgentTurn({
        home,
        cwd: home,
        agent: 'implementer',
        message: 'use a ghost note',
        knowledge: { domain: 'toris-ops', nodeId: 'ghost-pin' },
        provider: fakeProvider(failedSeen),
      }),
      (error) => error instanceof HttpError && error.status === 400 && /Unknown node/.test(error.message),
    );
    assert.equal(failedSeen.length, 0);
    assert.deepEqual(await snapshotKnowledge(home), before);
  } finally {
    if (previous == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
    await rm(home, { recursive: true, force: true });
  }
});
