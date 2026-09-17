import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli/index.js';
import { cmdDaemon } from '../src/cli/commands/daemon.js';
import { EXIT } from '../src/core/errors.js';
import { Store } from '../src/core/store.js';
import { KnowledgeStore } from '../src/core/knowledge/store.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { dayKey } from '../src/core/cost.js';

async function captureStdout(fn) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    return { result: await fn(), out: written.join('') };
  } finally {
    process.stdout.write = original;
  }
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'toris-brief-cli-'));
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify(DEFAULT_CONFIG), 'utf8');
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function ctx(home) {
  return { home, cwd: home, json: true, store: new Store(home) };
}

test('toris brief --json is a machine digest with empty sections present', async () => {
  await withHome(async (home) => {
    const { result, out } = await captureStdout(() =>
      main(['brief', '--json', '--home', home], { isInteractive: false }),
    );
    assert.equal(result, EXIT.OK);
    const body = JSON.parse(out);
    assert.equal(body.ok, true);
    assert.equal(body.period, 'today');
    assert.equal(body.spend.spentUsd, 0);
    assert.deepEqual(body.runs, []);
    assert.equal(body.daemon.running, false);
    assert.equal(body.knowledge.available, false);
  });
});

test('human brief stays quiet on empty runs and uninitialized knowledge', async () => {
  await withHome(async (home) => {
    const { result, out } = await captureStdout(() =>
      main(['brief', '--home', home, '--no-color'], { isInteractive: false }),
    );
    assert.equal(result, EXIT.OK);
    assert.match(out, /Brief\s+\d{4}-\d{2}-\d{2}/);
    assert.match(out, /Spend/);
    assert.match(out, /STOPPED/);
    assert.doesNotMatch(out, /^Runs$/m);
    assert.doesNotMatch(out, /Knowledge/);
  });
});

test('toris brief today --json lists today\'s run verify outcome', async () => {
  await withHome(async (home) => {
    const store = new Store(home);
    await store.init();
    const today = dayKey(new Date());
    await store.saveRun({
      id: 'run_brief1',
      goal: 'add a health endpoint',
      status: 'succeeded',
      costUsd: 0.4,
      createdAt: `${today}T08:00:00.000`,
      finishedAt: `${today}T08:01:00.000`,
      verification: { passed: true, checks: [{ command: 'npm test', passed: true, exitCode: 0 }] },
    });

    const { result, out } = await captureStdout(() =>
      main(['brief', 'today', '--json', '--home', home], { isInteractive: false }),
    );
    assert.equal(result, EXIT.OK);
    const body = JSON.parse(out);
    assert.equal(body.spend.spentUsd, 0.4);
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].id, 'run_brief1');
    assert.equal(body.runs[0].verify, 'pass');
    assert.match(body.runs[0].goal, /health endpoint/);
  });
});

test('human brief prints runs and knowledge when they exist', async () => {
  await withHome(async (home) => {
    const store = new Store(home);
    await store.init();
    const today = dayKey(new Date());
    await store.saveRun({
      id: 'run_brief2',
      goal: 'measure flutter on a mid-range phone',
      status: 'succeeded',
      costUsd: 0.2,
      createdAt: `${today}T08:00:00.000`,
      finishedAt: `${today}T08:01:00.000`,
      verification: { passed: true, checks: [] },
    });
    const knowledge = new KnowledgeStore({ home, projectPath: home });
    await knowledge.init({ seed: true });

    const { result, out } = await captureStdout(() =>
      main(['brief', '--home', home, '--no-color'], { isInteractive: false }),
    );
    assert.equal(result, EXIT.OK);
    assert.match(out, /run_brief2/);
    assert.match(out, /pass/);
    assert.match(out, /Knowledge/);
  });
});

test('an unknown brief period is a usage error', async () => {
  await withHome(async (home) => {
    const code = await main(['brief', 'week', '--json', '--home', home], { isInteractive: false });
    assert.equal(code, EXIT.USAGE);
  });
});

test('daemon schedule add and daemon run refuse a brief goal', async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () => cmdDaemon(ctx(home), ['schedule', 'add', '09:00', 'toris brief'], {}),
      /foreground CLI digest/,
    );
    await assert.rejects(
      () => cmdDaemon(ctx(home), ['run', 'brief'], {}),
      /foreground CLI digest/,
    );
  });
});
