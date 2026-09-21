import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../src/studio/server.js';
import { HttpError } from '../src/studio/http.js';
import { deleteStudioAgentProfile } from '../src/studio/agent-write.js';
import { writeAgentProfile } from '../src/core/agents.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-agent-delete-'));
  const cwd = extra.cwd === undefined ? await mkdtemp(join(tmpdir(), 'toris-studio-agent-delete-cwd-')) : extra.cwd;
  const studio = await createStudioServer({
    home,
    cwd,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    ...extra,
  });
  await studio.listen();
  const address = studio.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ studio, home, cwd, base });
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
    if (extra.cwd === undefined) await rm(cwd, { recursive: true, force: true });
  }
}

function mutation(base, body, method = 'POST') {
  return {
    method,
    headers: {
      origin: base,
      'x-toris-studio-token': 'test-token',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function profile(id = 'aso-specialist', extra = {}) {
  return {
    id,
    title: extra.title ?? 'ASO Specialist',
    category: extra.category ?? 'plan',
    writes: extra.writes ?? false,
    summary: extra.summary ?? 'Turns a change into store listing copy.',
    ...('system' in extra ? { system: extra.system } : {}),
  };
}

async function snapshotAgentDirs(home, cwd) {
  const files = {};
  for (const [key, dir] of [
    ['home', join(home, 'agents')],
    ['project', join(cwd, '.toris', 'agents')],
  ]) {
    try {
      const names = (await readdir(dir)).sort();
      files[key] = {};
      for (const name of names) {
        files[key][name] = await readFile(join(dir, name), 'utf8');
      }
    } catch (error) {
      if (error.code === 'ENOENT') files[key] = null;
      else throw error;
    }
  }
  return files;
}

async function seedHomeProfile(home, raw) {
  const dir = join(home, 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${raw.id}.json`), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

test('GET /agent ships Delete with a confirm step on the project-local form', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/agent`)).text();
    assert.match(html, /id="delete-agent"/);
    assert.match(html, />Delete</);
    assert.match(html, /id="edit-agent-panel"[^>]*hidden/);

    const script = await (await fetch(`${base}/assets/app.js`)).text();
    assert.match(script, /\/api\/agents\/\$\{encodeURIComponent\(id\)\}/);
    assert.match(script, /method: 'DELETE'/);
    assert.match(script, /window\.confirm\(`Delete \$\{agent\.title \|\| agent\.id\}\?`\)/);
    assert.match(script, /source === 'project'/);
    assert.match(script, /state\.agentId === id/);
    assert.match(script, /state\.agentId = 'toris'/);
    assert.match(script, /await loadAgents\(\)/);
    const confirmAt = script.indexOf('window.confirm(`Delete ${agent.title || agent.id}?`)');
    const deleteAt = script.indexOf("method: 'DELETE'");
    assert.ok(confirmAt !== -1 && deleteAt !== -1 && confirmAt < deleteAt);
  });
});

test('GET never deletes overlay files', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const created = await fetch(`${base}/api/agents`, mutation(base, profile('keep-this')));
    assert.equal(created.status, 201);
    const before = await snapshotAgentDirs(home, cwd);
    assert.ok(before.project['keep-this.json']);

    assert.equal((await fetch(`${base}/agent`)).status, 200);
    assert.equal((await fetch(`${base}/api/agents`)).status, 200);
    assert.equal((await fetch(`${base}/api/agent/status`)).status, 200);
    assert.equal((await fetch(`${base}/api/agents/keep-this`)).status, 404);
    assert.equal((await fetch(`${base}/api/agent/status?agent=keep-this`)).status, 200);

    assert.deepEqual(await snapshotAgentDirs(home, cwd), before);
  });
});

test('confirmed delete removes one project overlay and the catalogue drops that id', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const first = await fetch(`${base}/api/agents`, mutation(base, profile('growth-marketer')));
    const second = await fetch(`${base}/api/agents`, mutation(base, profile('keep-this', {
      title: 'Keep This',
      summary: 'Stays on disk after the other overlay is deleted.',
    })));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const file = join(cwd, '.toris', 'agents', 'growth-marketer.json');
    assert.ok(await readFile(file, 'utf8'));

    const deleted = await fetch(`${base}/api/agents/growth-marketer`, mutation(base, undefined, 'DELETE'));
    assert.equal(deleted.status, 200);
    const body = await deleted.json();
    assert.equal(body.ok, true);
    assert.equal(body.deleted, true);
    assert.equal(body.id, 'growth-marketer');
    assert.equal(body.path, '.toris/agents/growth-marketer.json');

    await assert.rejects(() => readFile(file, 'utf8'), { code: 'ENOENT' });
    const listed = await (await fetch(`${base}/api/agents`)).json();
    assert.equal(listed.agents.some((agent) => agent.id === 'growth-marketer'), false);
    const kept = listed.agents.find((agent) => agent.id === 'keep-this');
    assert.ok(kept);
    assert.equal(kept.source, 'project');

    const dirs = await snapshotAgentDirs(home, cwd);
    assert.equal(dirs.home, null);
    assert.equal(Object.keys(dirs.project).join(','), 'keep-this.json');
  });
});

test('unauthenticated Delete is 403 and deletes nothing', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const created = await fetch(`${base}/api/agents`, mutation(base, profile('keep-this')));
    assert.equal(created.status, 201);
    const before = await snapshotAgentDirs(home, cwd);
    const denied = await fetch(`${base}/api/agents/keep-this`, { method: 'DELETE' });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotAgentDirs(home, cwd), before);
  });
});

test('home and builtin ids are refused without deleting', async () => {
  await withServer(async ({ base, home, cwd }) => {
    await seedHomeProfile(home, profile('home-only', { title: 'Home Only', summary: 'Lives only in the user home overlay.' }));
    const created = await fetch(`${base}/api/agents`, mutation(base, profile('keep-this')));
    assert.equal(created.status, 201);
    const before = await snapshotAgentDirs(home, cwd);
    assert.ok(before.home['home-only.json']);
    assert.ok(before.project['keep-this.json']);

    const homeDenied = await fetch(`${base}/api/agents/home-only`, mutation(base, undefined, 'DELETE'));
    assert.equal(homeDenied.status, 404);
    assert.match((await homeDenied.json()).error.message, /not found/i);

    const builtinDenied = await fetch(`${base}/api/agents/implementer`, mutation(base, undefined, 'DELETE'));
    assert.equal(builtinDenied.status, 404);
    assert.match((await builtinDenied.json()).error.message, /not found/i);

    const unknownDenied = await fetch(`${base}/api/agents/missing-agent`, mutation(base, undefined, 'DELETE'));
    assert.equal(unknownDenied.status, 404);

    const after = await snapshotAgentDirs(home, cwd);
    assert.equal(after.home['home-only.json'], before.home['home-only.json']);
    assert.equal(after.project['keep-this.json'], before.project['keep-this.json']);
  });
});

test('delete does not touch ~/.toris/agents even when home exists', async () => {
  await withServer(async ({ base, home, cwd }) => {
    await seedHomeProfile(home, profile('home-only', { title: 'Home Only', summary: 'Must stay in the user home overlay.' }));
    const created = await fetch(`${base}/api/agents`, mutation(base, profile('local-only')));
    assert.equal(created.status, 201);
    const deleted = await fetch(`${base}/api/agents/local-only`, mutation(base, undefined, 'DELETE'));
    assert.equal(deleted.status, 200);
    const dirs = await snapshotAgentDirs(home, cwd);
    assert.ok(dirs.home['home-only.json']);
    assert.deepEqual(dirs.project, {});
    const listed = await (await fetch(`${base}/api/agents`)).json();
    assert.equal(listed.agents.some((agent) => agent.id === 'local-only'), false);
    assert.ok(listed.agents.some((agent) => agent.id === 'home-only' && agent.source === 'home'));
  });
});

test('deleteStudioAgentProfile rejects home/builtin/bad input before a delete lands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'toris-agent-delete-unit-'));
  try {
    const written = await writeAgentProfile(profile('helper-agent'), { projectPath: root });
    assert.equal(written.id, 'helper-agent');
    const deleted = await deleteStudioAgentProfile('helper-agent', { projectPath: root });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.id, 'helper-agent');
    await assert.rejects(
      () => deleteStudioAgentProfile('helper-agent', { projectPath: root }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => deleteStudioAgentProfile('implementer', { projectPath: root }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => deleteStudioAgentProfile('ASO', { projectPath: root }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
      () => deleteStudioAgentProfile('helper-agent', {}),
      (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(() => readdir(join(root, '.toris', 'agents', 'helper-agent.json')));
    const names = await readdir(join(root, '.toris', 'agents'));
    assert.deepEqual(names, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delete control stays on the Studio agent page source', async () => {
  const html = await readFile(join(repoRoot, 'src/studio/ui/index.html'), 'utf8');
  const js = await readFile(join(repoRoot, 'src/studio/ui/app.js'), 'utf8');
  assert.match(html, /id="delete-agent"/);
  assert.match(html, />Delete</);
  assert.match(js, /method: 'DELETE'/);
  assert.match(js, /window\.confirm/);
  assert.match(js, /\/api\/agents\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(js, /state\.agentId = 'toris'/);
  assert.doesNotMatch(js, /\/api\/agents\/(?:update|delete)/);
  assert.doesNotMatch(js, /~\/\.toris\/agents/);
});
