import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdKnowledge } from '../src/cli/commands/knowledge.js';
import { EXIT } from '../src/core/errors.js';
import { proposeReflections, KNOWLEDGE_PACK_SLUGS } from '../src/core/knowledge/index.js';
import { createDefaultTools } from '../src/core/tools.js';
import { Store } from '../src/core/store.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';

async function captureJson(fn) {
  const chunks = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await fn();
    return { code, body: JSON.parse(chunks.join('') || 'null') };
  } finally {
    process.stdout.write = write;
  }
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-knowledge-cli-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function ctx(home) {
  return { home, cwd: home, json: true, store: new Store(home) };
}

function verifiedRun(id = 'run_cliok01') {
  return {
    id,
    goal: 'Cite the receipt after a Toris autonomy check',
    status: 'succeeded',
    autonomy: 'L3',
    provider: 'claude',
    costUsd: 0.01,
    createdAt: '2026-09-17T00:00:00.000Z',
    finishedAt: '2026-09-17T00:01:00.000Z',
    tasks: [{ id: 't1', title: 'Read the receipt path', status: 'succeeded', agent: 'implementer' }],
    verification: { passed: true, checks: [{ command: 'npm test', passed: true, exitCode: 0 }] },
  };
}

test('knowledge init seeds starter domains and is json-scriptable', async () => {
  await withHome(async (home) => {
    const { code, body } = await captureJson(() => cmdKnowledge(ctx(home), ['init'], {}));
    assert.equal(code, EXIT.OK);
    assert.equal(body.ok, true);
    assert.equal(body.domains, 5);
  });
});

test('node add + link + search round-trip through the CLI', async () => {
  await withHome(async (home) => {
    await captureJson(() => cmdKnowledge(ctx(home), ['init'], {}));
    const added = await captureJson(() =>
      cmdKnowledge(ctx(home), ['node', 'add', 'toris-ops'], {
        title: 'Session continuity',
        body: 'Summaries belong in MEMORY.md, procedures in tacit notes.',
        tags: 'memory, dag',
      }),
    );
    assert.equal(added.code, EXIT.OK);
    assert.equal(added.body.node.id, 'session-continuity');

    const linked = await captureJson(() =>
      cmdKnowledge(
        ctx(home),
        ['node', 'link', 'toris-ops', 'receipts-not-vibes', 'session-continuity'],
        { kind: 'supports' },
      ),
    );
    assert.equal(linked.code, EXIT.OK);

    const found = await captureJson(() =>
      cmdKnowledge(ctx(home), ['search', 'session continuity'], {}),
    );
    assert.ok(found.body.hits.some((hit) => hit.id === 'session-continuity'));
  });
});

test('knowledge pack list is json-scriptable and does not write', async () => {
  await withHome(async (home) => {
    const { code, body } = await captureJson(() => cmdKnowledge(ctx(home), ['pack', 'list'], {}));
    assert.equal(code, EXIT.OK);
    assert.equal(body.ok, true);
    assert.equal(body.packs.length, KNOWLEDGE_PACK_SLUGS.length);
    assert.equal(
      body.packs.every((pack) => pack.installed === false),
      true,
    );
    const knowledge = new KnowledgeStore({ home });
    assert.equal((await knowledge.status()).ok, false);
  });
});

test('knowledge pack install writes one domain and --force replaces it', async () => {
  await withHome(async (home) => {
    const installed = await captureJson(() =>
      cmdKnowledge(ctx(home), ['pack', 'install', 'flutter-expo-android'], {}),
    );
    assert.equal(installed.code, EXIT.OK);
    assert.equal(installed.body.slug, 'flutter-expo-android');
    assert.equal(installed.body.written, true);

    const knowledge = new KnowledgeStore({ home });
    const domain = await knowledge.inspectDomain('flutter-expo-android');
    assert.ok(domain.nodeCount >= 3);
    assert.equal((await knowledge.status()).userBytes, 0);
    assert.equal((await knowledge.status()).memoryBytes, 0);

    await assert.rejects(
      () => cmdKnowledge(ctx(home), ['pack', 'install', 'flutter-expo-android'], {}),
      /already exists/,
    );

    const forced = await captureJson(() =>
      cmdKnowledge(ctx(home), ['pack', 'install', 'flutter-expo-android'], { force: true }),
    );
    assert.equal(forced.code, EXIT.OK);
    assert.equal(forced.body.forced, true);
    assert.equal((await knowledge.inspectDomain('flutter-expo-android')).nodeCount, domain.nodeCount);
  });
});

test('unknown knowledge subcommand is a usage error', async () => {
  await withHome(async (home) => {
    await assert.rejects(() => cmdKnowledge(ctx(home), ['wipe'], {}), /Unknown knowledge subcommand/);
  });
});

test('reflect proposes a note and --write captures it', async () => {
  await withHome(async (home) => {
    await captureJson(() => cmdKnowledge(ctx(home), ['init'], {}));
    const text =
      'We always cite the receipt path after a successful run. Remember that autonomy L3 auto-applies. ' +
      'Prefer tacit notes over dumping the whole transcript into MEMORY.md.';
    const dry = await captureJson(() => cmdKnowledge(ctx(home), ['reflect'], { text }));
    assert.equal(dry.body.written, false);
    assert.equal(dry.body.notable, true);

    const wrote = await captureJson(() =>
      cmdKnowledge(ctx(home), ['reflect'], { text, write: true, domain: 'toris-ops' }),
    );
    assert.equal(wrote.body.written, true);
    assert.ok(wrote.body.notes.length >= 1);
  });
});

test('reflect --from-run and --json propose without writing', async () => {
  await withHome(async (home) => {
    await captureJson(() => cmdKnowledge(ctx(home), ['init'], {}));
    await new Store(home).saveRun(verifiedRun());
    const knowledge = new KnowledgeStore({ home });
    const inboxBefore = (await knowledge.listInbox()).length;

    const fromFlag = await captureJson(() =>
      cmdKnowledge(ctx(home), ['reflect'], { 'from-run': 'run_cliok01' }),
    );
    assert.equal(fromFlag.code, EXIT.OK);
    assert.equal(fromFlag.body.written, false);
    assert.equal(fromFlag.body.notable, true);
    assert.equal(fromFlag.body.source.runId, 'run_cliok01');
    assert.match(fromFlag.body.proposals[0].body, /npm test/);
    assert.match(fromFlag.body.proposals[0].body, /Read the receipt path/);

    const fromPositional = await captureJson(() =>
      cmdKnowledge(ctx(home), ['reflect', 'run_cliok01'], {}),
    );
    assert.equal(fromPositional.body.written, false);
    assert.equal(fromPositional.body.source.runId, 'run_cliok01');

    const latest = await captureJson(() => cmdKnowledge(ctx(home), ['reflect'], {}));
    assert.equal(latest.body.written, false);
    assert.equal(latest.body.source.runId, 'run_cliok01');

    assert.equal((await knowledge.listInbox()).length, inboxBefore);
  });
});

test('reflect on a failed verification does not write a success tacit', async () => {
  await withHome(async (home) => {
    await captureJson(() => cmdKnowledge(ctx(home), ['init'], {}));
    await new Store(home).saveRun({
      ...verifiedRun('run_clibad01'),
      status: 'failed',
      verification: { passed: false, checks: [{ command: 'npm test', passed: false, exitCode: 1 }] },
    });
    const knowledge = new KnowledgeStore({ home });
    const proposed = await captureJson(() =>
      cmdKnowledge(ctx(home), ['reflect'], { 'from-run': 'run_clibad01', write: true }),
    );
    assert.equal(proposed.body.written, false);
    assert.equal(proposed.body.notable, false);
    assert.equal(proposed.body.notes, undefined);
    assert.match(proposed.body.reason, /Verification failed/);
    assert.equal((await knowledge.listInbox()).length, 0);
  });
});

test('proposeReflections ignores tiny turns', () => {
  const result = proposeReflections({ user: 'ok', assistant: 'done' });
  assert.equal(result.notable, false);
});

test('knowledge_write is gated; recall tools are not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-knowledge-tools-'));
  try {
    const tools = createDefaultTools({ cwd: home, home });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.knowledge_write.needsApproval, true);
    assert.equal(byName.knowledge_search.needsApproval, undefined);
    assert.equal(byName.memory_get.needsApproval, undefined);
    assert.equal(byName.domain_activate.needsApproval, undefined);
    const status = JSON.parse(await byName.memory_get.run({ target: 'status' }));
    assert.equal(status.ok, true);
    assert.ok(status.domains >= 5);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
