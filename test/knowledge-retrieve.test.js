import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KnowledgeStore } from '../src/core/knowledge/store.js';
import {
  composeKnowledgeTurn,
  formatKnowledgeReceipt,
  knowledgeAutoRetrieveEnabled,
  publicKnowledgeReceipt,
  retrieveForTurn,
  retrievalQuery,
  stripKnowledgeContext,
} from '../src/core/knowledge/index.js';

async function withStore(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-knowledge-retrieve-'));
  const store = new KnowledgeStore({ home });
  await store.init({ seed: true });
  try {
    await fn(store, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('retrieveForTurn injects node and tacit bodies, not just index excerpts', async () => {
  await withStore(async (store) => {
    const result = await retrieveForTurn(store, { query: 'flutter play release mid-range phone' });
    assert.equal(result.enabled, true);
    assert.ok(result.retrieved.some((item) => item.kind === 'node' && item.id === 'play-release-checklist'));
    assert.ok(result.retrieved.some((item) => item.kind === 'tacit'));
    assert.match(result.briefing, /Play release checklist/);
    assert.match(result.briefing, /procedure, not a vibe/);
    assert.match(result.briefing, /dag: /);
    assert.doesNotMatch(result.briefing, /USER\.md \(excerpt\)/);
    const wrapped = composeKnowledgeTurn('ship the Play build', result.briefing);
    assert.match(wrapped, /^\[knowledge context\]/);
    assert.match(wrapped, /ship the Play build$/);
  });
});

test('retrieveForTurn prefers domain nodes and tacit over USER.md or MEMORY.md', async () => {
  await withStore(async (store) => {
    await store.appendUser('- I care about flutter play evidence');
    const result = await retrieveForTurn(store, { query: 'flutter play' });
    assert.ok(result.retrieved.every((item) => item.kind === 'node' || item.kind === 'tacit'));
    assert.ok(!result.retrieved.some((item) => item.kind === 'user' || item.kind === 'memory'));
    assert.doesNotMatch(result.briefing, /I care about flutter play evidence/);
  });
});

test('retrieveForTurn respects maxNodes / maxTacit / maxChars', async () => {
  await withStore(async (store) => {
    const tight = await retrieveForTurn(store, {
      query: 'android flutter expo play evidence measurement',
      budget: { maxNodes: 1, maxTacit: 1, maxChars: 900, nodeChars: 120, tacitChars: 80 },
    });
    assert.ok(tight.retrieved.filter((item) => item.kind === 'node').length <= 1);
    assert.ok(tight.retrieved.filter((item) => item.kind === 'tacit').length <= 1);
    assert.ok(tight.chars <= 900);
    assert.ok(tight.briefing.length <= 900);
  });
});

test('retrieveForTurn is read-only and does not write tacit', async () => {
  await withStore(async (store, home) => {
    const beforeInbox = await store.listInbox();
    const beforeIndex = await readFile(join(home, 'knowledge', 'index.json'), 'utf8');
    await retrieveForTurn(store, { query: 'always measure on a mid-range phone' });
    const afterInbox = await store.listInbox();
    const afterIndex = await readFile(join(home, 'knowledge', 'index.json'), 'utf8');
    assert.equal(afterInbox.length, beforeInbox.length);
    assert.equal(afterIndex, beforeIndex);
  });
});

test('disabled retrieve and --no-knowledge / config leave the message untouched', async () => {
  await withStore(async (store) => {
    const off = await retrieveForTurn(store, { query: 'flutter play', enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(off.briefing, '');
    assert.deepEqual(off.retrieved, []);
    assert.equal(knowledgeAutoRetrieveEnabled({ knowledge: { autoRetrieve: false } }), false);
    assert.equal(knowledgeAutoRetrieveEnabled({ knowledge: { autoRetrieve: true } }, { 'no-knowledge': true }), false);
    assert.equal(knowledgeAutoRetrieveEnabled({}, {}), true);
    assert.deepEqual(publicKnowledgeReceipt(off), { autoRetrieve: false, retrieved: [] });
    assert.equal(formatKnowledgeReceipt(off), '');
  });
});

test('recent user turns contribute keywords after stripping injected context', async () => {
  await withStore(async (store) => {
    const history = [
      {
        role: 'user',
        content: '[knowledge context]\nnnoise\n[/knowledge context]\n\nflutter play release checklist',
      },
    ];
    const query = retrievalQuery('what is the procedure?', history);
    assert.match(query, /flutter play release checklist/);
    assert.doesNotMatch(query, /nnoise/);
    assert.equal(stripKnowledgeContext(history[0].content), 'flutter play release checklist');

    const result = await retrieveForTurn(store, { query: 'what is the procedure?', history });
    assert.ok(result.retrieved.some((item) => item.id === 'play-release-checklist'));
  });
});

test('uninitialized store and empty query return no turn block', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-knowledge-empty-'));
  try {
    const store = new KnowledgeStore({ home });
    const missing = await retrieveForTurn(store, { query: 'flutter play' });
    assert.equal(missing.briefing, '');
    assert.equal(missing.enabled, true);
    await store.init({ seed: true });
    const none = await retrieveForTurn(store, { query: '' });
    assert.equal(none.briefing, '');
    assert.deepEqual(none.retrieved, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('formatKnowledgeReceipt is a single quiet line', async () => {
  await withStore(async (store) => {
    const result = await retrieveForTurn(store, { query: 'flutter play' });
    const note = formatKnowledgeReceipt(result);
    assert.match(note, /^knowledge  /);
    assert.ok(!note.includes('\n'));
    const receipt = publicKnowledgeReceipt(result);
    assert.equal(receipt.autoRetrieve, true);
    assert.ok(receipt.retrieved.length > 0);
    assert.ok(Array.isArray(receipt.domains));
  });
});
