import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../src/studio/server.js';
import { HttpError } from '../src/studio/http.js';
import { createStudioAgentProfile } from '../src/studio/agent-write.js';
import { loadAgentProfileFile, parseAgentProfile } from '../src/core/agents.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-agent-create-'));
  const cwd = extra.cwd === undefined ? await mkdtemp(join(tmpdir(), 'toris-studio-agent-cwd-')) : extra.cwd;
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

test('GET /agent ships the create-profile form', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/agent`)).text();
    assert.match(html, /id="create-agent-form"/);
    assert.match(html, /id="new-agent-id"/);
    assert.match(html, /id="new-agent-title"/);
    assert.match(html, /id="new-agent-category"/);
    assert.match(html, /id="new-agent-summary"/);
    assert.match(html, /id="new-agent-writes"/);
    assert.match(html, /id="new-agent-system"/);
    assert.match(html, />Create</);

    const script = await (await fetch(`${base}/assets/app.js`)).text();
    assert.match(script, /\/api\/agents/);
    assert.match(script, /create-agent-form/);
    assert.match(script, /await loadAgents\(\)/);
    assert.match(script, /showSurface\('agent', \{ agentId:/);
  });
});

test('GET does not write overlay files', async () => {
  await withServer(async ({ base, home, cwd }) => {
    assert.deepEqual(await snapshotAgentDirs(home, cwd), { home: null, project: null });
    assert.equal((await fetch(`${base}/agent`)).status, 200);
    assert.equal((await fetch(`${base}/api/agents`)).status, 200);
    assert.equal((await fetch(`${base}/api/agent/status`)).status, 200);
    assert.deepEqual(await snapshotAgentDirs(home, cwd), { home: null, project: null });
  });
});

test('create writes one valid project overlay', async () => {
  await withServer(
    async ({ base, home, cwd }) => {
      const raw = profile('growth-marketer', {
        title: 'Growth Marketer',
        summary: 'Plans launch loops for a single operator.',
        system: 'Propose one loop. Cite the repo.',
      });
      const created = await fetch(`${base}/api/agents`, mutation(base, raw));
      assert.equal(created.status, 201);
      const body = await created.json();
      assert.equal(body.ok, true);
      assert.equal(body.agent.id, 'growth-marketer');
      assert.equal(body.agent.title, 'Growth Marketer');
      assert.equal(body.agent.source, 'project');
      assert.equal(body.agent.system, 'Propose one loop. Cite the repo.');

      const file = join(cwd, '.toris', 'agents', 'growth-marketer.json');
      const onDisk = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(onDisk, {
        id: 'growth-marketer',
        title: 'Growth Marketer',
        category: 'plan',
        writes: false,
        summary: 'Plans launch loops for a single operator.',
        system: 'Propose one loop. Cite the repo.',
      });
      assert.equal(parseAgentProfile(onDisk).id, 'growth-marketer');
      const loaded = await loadAgentProfileFile(file);
      assert.equal(loaded.id, 'growth-marketer');
      assert.equal(loaded.source, 'project');

      const listed = await (await fetch(`${base}/api/agents`)).json();
      assert.ok(listed.agents.some((agent) => agent.id === 'growth-marketer' && agent.source === 'project'));

      const turn = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, { agent: 'growth-marketer', message: 'draft a loop' }),
      );
      assert.equal(turn.status, 200);
      assert.equal((await turn.json()).agent.id, 'growth-marketer');

      const dirs = await snapshotAgentDirs(home, cwd);
      assert.equal(dirs.home, null);
      assert.equal(Object.keys(dirs.project).join(','), 'growth-marketer.json');
    },
    {
      runAgentTurn: async ({ agent }) => ({
        ok: true,
        agent: { id: agent, title: 'Growth Marketer' },
        text: 'ok',
        events: [],
      }),
    },
  );
});

test('duplicate id is 409 and does not overwrite', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const first = await fetch(`${base}/api/agents`, mutation(base, profile('keep-this')));
    assert.equal(first.status, 201);
    const file = join(cwd, '.toris', 'agents', 'keep-this.json');
    const original = await readFile(file, 'utf8');
    const afterFirst = await snapshotAgentDirs(home, cwd);

    const again = await fetch(
      `${base}/api/agents`,
      mutation(base, profile('keep-this', { title: 'Overwrite attempt', summary: 'should not land on disk!!' })),
    );
    assert.equal(again.status, 409);
    assert.match((await again.json()).error.message, /already exists/);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.doesNotMatch(original, /Overwrite attempt/);
    assert.deepEqual(await snapshotAgentDirs(home, cwd), afterFirst);
  });
});

test('invalid id is 400 and writes nothing', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const before = await snapshotAgentDirs(home, cwd);
    for (const id of ['', 'ASO', 'has/slash', 'my_app', '---', '1bad']) {
      const denied = await fetch(`${base}/api/agents`, mutation(base, profile(id)));
      assert.equal(denied.status, 400, id);
      assert.match((await denied.json()).error.message, /id|slug|project path|JSON object/i);
    }
    assert.deepEqual(await snapshotAgentDirs(home, cwd), before);
  });
});

test('unauthenticated create is 403 and writes nothing', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const before = await snapshotAgentDirs(home, cwd);
    const denied = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profile('unauthed-agent')),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotAgentDirs(home, cwd), before);
  });
});

test('create does not write ~/.toris/agents even when home exists', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const created = await fetch(`${base}/api/agents`, mutation(base, profile('local-only')));
    assert.equal(created.status, 201);
    const dirs = await snapshotAgentDirs(home, cwd);
    assert.equal(dirs.home, null);
    assert.ok(dirs.project['local-only.json']);
    await assert.rejects(() => readdir(join(home, 'agents')), { code: 'ENOENT' });
  });
});

test('create without a Studio project path is 400 and writes nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-agent-nocwd-'));
  const studio = await createStudioServer({
    home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
  });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    const denied = await fetch(`${base}/api/agents`, mutation(base, profile('no-cwd')));
    assert.equal(denied.status, 400);
    assert.match((await denied.json()).error.message, /project path/);
    await assert.rejects(() => readdir(join(home, 'agents')), { code: 'ENOENT' });
    await assert.rejects(() => readdir(join(home, '.toris', 'agents')), { code: 'ENOENT' });
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('createStudioAgentProfile rejects bad input before writeAgentProfile lands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'toris-agent-create-unit-'));
  try {
    await assert.rejects(
      () => createStudioAgentProfile(profile('Not Valid'), { projectPath: root }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    const first = await createStudioAgentProfile(profile('helper-agent'), { projectPath: root });
    assert.equal(first.agent.id, 'helper-agent');
    await assert.rejects(
      () => createStudioAgentProfile(profile('helper-agent', { title: 'Overwrite' }), { projectPath: root }),
      (error) => error instanceof HttpError && error.status === 409,
    );
    await assert.rejects(
      () => createStudioAgentProfile(profile('no-project'), {}),
      (error) => error instanceof HttpError && error.status === 400,
    );
    const names = await readdir(join(root, '.toris', 'agents'));
    assert.deepEqual(names, ['helper-agent.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('create form stays on the Studio agent page source', async () => {
  const html = await readFile(join(repoRoot, 'src/studio/ui/index.html'), 'utf8');
  const js = await readFile(join(repoRoot, 'src/studio/ui/app.js'), 'utf8');
  assert.match(html, /id="create-agent-form"/);
  assert.match(js, /method: 'POST'/);
  assert.match(js, /writes: elements\['new-agent-writes'\]\.checked/);
  assert.doesNotMatch(js, /\/api\/agents\/(?:update|delete)/);
});
