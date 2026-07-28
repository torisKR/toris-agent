import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';

const withStore = async (fn) => {
  const home = await mkdtemp(join(tmpdir(), 'toris-test-'));
  const store = new Store(home);
  await store.init();
  try { await fn(store, home); } finally { await rm(home, { recursive: true, force: true }); }
};

test('init is idempotent', async () => {
  await withStore(async (store) => {
    await store.init();
    assert.deepEqual(await store.readCollection('projects'), []);
  });
});

test('a missing collection reads as empty instead of throwing', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.readCollection('never-written'), []);
  });
});

test('runs survive a write/read round trip', async () => {
  await withStore(async (store) => {
    await store.saveRun({ id: 'run_1', goal: 'ship', status: 'planned', tasks: [] });
    const loaded = await store.getRun('run_1');
    assert.equal(loaded.goal, 'ship');
  });
});

test('saveRun overwrites the same id rather than duplicating it', async () => {
  await withStore(async (store) => {
    await store.saveRun({ id: 'run_1', status: 'planned' });
    await store.saveRun({ id: 'run_1', status: 'succeeded' });
    const runs = await store.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');
  });
});

test('getRun returns null for an unknown id', async () => {
  await withStore(async (store) => assert.equal(await store.getRun('nope'), null));
});

test('updateCollection applies a pure updater', async () => {
  await withStore(async (store) => {
    await store.writeCollection('projects', [{ id: 'p1', name: 'a' }]);
    await store.updateCollection('projects', (items) => [...items, { id: 'p2', name: 'b' }]);
    assert.equal((await store.readCollection('projects')).length, 2);
  });
});

test('events append in order and are scoped per run', async () => {
  await withStore(async (store) => {
    await store.appendEvent('run_1', { type: 'run.started' });
    await store.appendEvent('run_1', { type: 'run.finished' });
    await store.appendEvent('run_2', { type: 'run.started' });
    assert.deepEqual((await store.readEvents('run_1')).map((e) => e.type), ['run.started', 'run.finished']);
    assert.equal((await store.readEvents('run_2')).length, 1);
  });
});

test('a corrupt event line does not poison the log', async () => {
  await withStore(async (store, home) => {
    await store.appendEvent('run_1', { type: 'ok' });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(home, 'runs', 'run_1.events.jsonl'), 'not json\n');
    await store.appendEvent('run_1', { type: 'after' });
    const types = (await store.readEvents('run_1')).map((e) => e.type);
    assert.deepEqual(types, ['ok', 'after'], 'valid events must still be readable');
  });
});
