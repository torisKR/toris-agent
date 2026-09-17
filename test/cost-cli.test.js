import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli/index.js';
import { EXIT } from '../src/core/errors.js';
import { Store } from '../src/core/store.js';
import { dayKey } from '../src/core/cost.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

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
  const home = await mkdtemp(join(tmpdir(), 'toris-cost-cli-'));
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify(DEFAULT_CONFIG), 'utf8');
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('toris cost --json reports today, days and recent runs', async () => {
  await withHome(async (home) => {
    const store = new Store(home);
    await store.init();
    const today = dayKey(new Date());
    await store.saveRun({
      id: 'run_cli',
      goal: 'track spend',
      status: 'succeeded',
      costUsd: 1.5,
      createdAt: `${today}T09:00:00.000`,
      finishedAt: `${today}T09:01:00.000`,
    });

    const { result, out } = await captureStdout(() =>
      main(['cost', '--json', '--home', home], { isInteractive: false }),
    );
    assert.equal(result, EXIT.OK);
    const body = JSON.parse(out);
    assert.equal(body.ok, true);
    assert.equal(body.today.spentUsd, 1.5);
    assert.equal(body.today.capUsd, 20);
    assert.ok(body.days.some((day) => day.day === today));
    assert.ok(body.runs.some((run) => run.id === 'run_cli'));
  });
});

test('toris cost today --json scopes the listing to the local day', async () => {
  await withHome(async (home) => {
    const { result, out } = await captureStdout(() =>
      main(['cost', 'today', '--json', '--home', home], { isInteractive: false }),
    );
    assert.equal(result, EXIT.OK);
    const body = JSON.parse(out);
    assert.equal(body.days.length, 1);
    assert.equal(body.days[0].day, body.today.day);
  });
});

test('toris run refuses with E_BUDGET when the daily ceiling is already spent', async () => {
  await withHome(async (home) => {
    const store = new Store(home);
    await store.init();
    await store.saveRun({
      id: 'run_prior',
      goal: 'spent the day',
      status: 'succeeded',
      costUsd: 20,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const { result, out } = await captureStdout(() =>
      main(['run', 'do more', '--json', '--home', home], { isInteractive: false }),
    );
    assert.equal(result, EXIT.FAILURE);
    const body = JSON.parse(out);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'E_BUDGET');
    assert.match(body.error.message, /daily budget/);
  });
});

test('an unknown cost subcommand is a usage error', async () => {
  await withHome(async (home) => {
    const code = await main(['cost', 'yesterday', '--json', '--home', home], { isInteractive: false });
    assert.equal(code, EXIT.USAGE);
  });
});
