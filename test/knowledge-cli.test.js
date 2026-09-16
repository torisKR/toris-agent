import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdKnowledge } from '../src/cli/commands/knowledge.js';
import { EXIT } from '../src/core/errors.js';
import { proposeReflections } from '../src/core/knowledge/index.js';
import { createDefaultTools } from '../src/core/tools.js';

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
  return { home, cwd: home, json: true };
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
