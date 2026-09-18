import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { buildReceipt } from '../src/core/receipt.js';
import {
  acceptReflections,
  guessDomain,
  isVerifiedSuccess,
  looksLikeRunId,
  proposeFromRun,
  proposeReflections,
  proposeReflectionsFromReceipt,
} from '../src/core/knowledge/index.js';
import { createKnowledgeTools } from '../src/core/knowledge/tools.js';

function verifiedRun(overrides = {}) {
  return {
    id: 'run_verified1',
    goal: 'Fix Flutter jank on a mid-range Android phone',
    status: 'succeeded',
    autonomy: 'L3',
    provider: 'claude',
    costUsd: 0.12,
    createdAt: '2026-09-17T00:00:00.000Z',
    finishedAt: '2026-09-17T00:02:00.000Z',
    tasks: [
      { id: 't1', title: 'Measure raster budget', status: 'succeeded', agent: 'implementer' },
      { id: 't2', title: 'Drop oversized shadows', status: 'succeeded', agent: 'implementer' },
    ],
    verification: {
      passed: true,
      checks: [
        { command: 'flutter test', passed: true, exitCode: 0 },
        { command: 'npm test', passed: true, exitCode: 0 },
      ],
    },
    review: { passed: true, summary: 'Opposite review passed.' },
    ...overrides,
  };
}

function failedRun() {
  return verifiedRun({
    id: 'run_failed1',
    status: 'failed',
    goal: 'Ship the Flutter play bundle',
    verification: {
      passed: false,
      checks: [{ command: 'flutter test', passed: false, exitCode: 1 }],
    },
  });
}

test('looksLikeRunId accepts harness ids only', () => {
  assert.equal(looksLikeRunId('run_abc123'), true);
  assert.equal(looksLikeRunId('run-abc'), true);
  assert.equal(looksLikeRunId('flutter-android'), false);
  assert.equal(looksLikeRunId(''), false);
});

test('a verified receipt proposes one tacit draft with goal, plan, and exits', () => {
  const receipt = buildReceipt(verifiedRun(), []);
  const result = proposeReflectionsFromReceipt(receipt);
  assert.equal(result.notable, true);
  assert.equal(result.source.kind, 'receipt');
  assert.equal(result.source.runId, 'run_verified1');
  assert.equal(result.proposals.length, 1);
  const [draft] = result.proposals;
  assert.match(draft.title, /Flutter jank/i);
  assert.equal(draft.domain, 'flutter-android');
  assert.deepEqual(draft.tags, ['tacit', 'reflect', 'receipt']);
  assert.match(draft.body, /Fix Flutter jank/);
  assert.match(draft.body, /Measure raster budget/);
  assert.match(draft.body, /Drop oversized shadows/);
  assert.match(draft.body, /flutter test` exit 0/);
  assert.match(draft.body, /npm test` exit 0/);
  assert.match(draft.body, /Opposite review passed/);
  assert.equal(draft.goal, 'Fix Flutter jank on a mid-range Android phone');
  assert.match(draft.outcome, /verification passed|checks passed|Opposite review passed/i);
  assert.match(result.reason, /Do not write it silently/);
});

test('failed verification does not propose a success tacit note', () => {
  const receipt = buildReceipt(failedRun(), []);
  const result = proposeReflectionsFromReceipt(receipt);
  assert.equal(isVerifiedSuccess(receipt), false);
  assert.equal(result.notable, false);
  assert.equal(result.proposals.length, 0);
  assert.match(result.reason, /Verification failed/);
  assert.doesNotMatch(result.reason, /success tacit note to write/i);
});

test('an unverified run does not propose success tacit', () => {
  const receipt = buildReceipt(verifiedRun({ verification: { passed: null, checks: [] } }), []);
  const result = proposeReflectionsFromReceipt(receipt);
  assert.equal(result.notable, false);
  assert.equal(result.proposals.length, 0);
  assert.match(result.reason, /Nothing was verified/);
});

test('guessDomain uses pack tags when the heuristic misses', () => {
  const domains = [{ slug: 'checkout', title: 'Checkout', tags: ['payments', 'cart'], when: 'card entry' }];
  assert.equal(guessDomain('the payments cart broke on card entry', domains), 'checkout');
  assert.equal(guessDomain('seo listing for the store', []), 'product-growth');
});

test('proposeFromRun does not write and prefers the newest verified run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-reflect-run-'));
  const store = new Store(home);
  const knowledge = new KnowledgeStore({ home });
  await knowledge.init({ seed: true });
  const inboxBefore = await knowledge.listInbox();
  await store.saveRun(failedRun());
  await store.saveRun(verifiedRun());
  try {
    const named = await proposeFromRun(store, { runId: 'run_verified1', domains: await knowledge.listDomains() });
    assert.equal(named.notable, true);
    assert.equal(named.proposals[0].runId, 'run_verified1');

    const latest = await proposeFromRun(store, { domains: await knowledge.listDomains() });
    assert.equal(latest.source.runId, 'run_verified1');

    const failed = await proposeFromRun(store, { runId: 'run_failed1' });
    assert.equal(failed.notable, false);
    assert.equal(failed.proposals.length, 0);

    const inboxAfter = await knowledge.listInbox();
    assert.equal(inboxAfter.length, inboxBefore.length);
    const tacit = await knowledge.listTacit('flutter-android');
    assert.ok(tacit.every((note) => note.id !== named.proposals[0].id));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('knowledge_reflect proposes from a run id and never writes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-reflect-tool-'));
  const store = new Store(home);
  await store.saveRun(verifiedRun());
  const knowledge = new KnowledgeStore({ home });
  await knowledge.init({ seed: true });
  const tools = createKnowledgeTools({ home, projectPath: home });
  const reflect = tools.find((tool) => tool.name === 'knowledge_reflect');
  try {
    const text = await reflect.run({ runId: 'run_verified1' });
    assert.match(text, /Flutter jank/);
    assert.match(text, /Do not write it silently|Accept with/);
    const inbox = await readdir(join(home, 'knowledge', 'inbox')).catch(() => []);
    assert.equal(
      inbox.filter((name) => name.endsWith('.md')).length,
      0,
      'reflect must not create inbox notes',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('short chat turns still refuse to invent tacit', () => {
  const result = proposeReflections({ user: 'ok', assistant: 'done' });
  assert.equal(result.notable, false);
  assert.equal(result.proposals.length, 0);
});

test('acceptReflections writes proposed notes and empty results write nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-reflect-accept-'));
  const knowledge = new KnowledgeStore({ home });
  await knowledge.init({ seed: true });
  const inboxBefore = await knowledge.listInbox();
  try {
    const empty = await acceptReflections(knowledge, { notable: false, proposals: [] });
    assert.deepEqual(empty, []);
    assert.equal((await knowledge.listInbox()).length, inboxBefore.length);

    const receipt = proposeReflectionsFromReceipt(buildReceipt(verifiedRun(), []));
    const written = await acceptReflections(knowledge, receipt);
    assert.equal(written.length, 1);
    const tacit = await knowledge.listTacit('flutter-android');
    assert.ok(tacit.some((note) => note.id === written[0].id));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
