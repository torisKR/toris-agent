import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../src/studio/server.js';
import { HttpError } from '../src/studio/http.js';
import { updateStudioAgentProfile } from '../src/studio/agent-write.js';
import { loadAgentProfileFile, parseAgentProfile, writeAgentProfile } from '../src/core/agents.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-agent-edit-'));
  const cwd = extra.cwd === undefined ? await mkdtemp(join(tmpdir(), 'toris-studio-agent-edit-cwd-')) : extra.cwd;
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

function mutation(base, body, method = 'PUT') {
  return {
    method,
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

async function seedHomeProfile(home, raw) {
  const dir = join(home, 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${raw.id}.json`), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

test('GET /agent ships the edit-profile form', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/agent`)).text();
    assert.match(html, /id="edit-agent-form"/);
    assert.match(html, /id="edit-agent-id"/);
    assert.match(html, /id="edit-agent-title"/);
    assert.match(html, /id="edit-agent-category"/);
    assert.match(html, /id="edit-agent-summary"/);
    assert.match(html, /id="edit-agent-writes"/);
    assert.match(html, /id="edit-agent-system"/);
    assert.match(html, />Save</);
    assert.match(html, /id="edit-agent-panel"[^>]*hidden/);

    const script = await (await fetch(`${base}/assets/app.js`)).text();
    assert.match(script, /\/api\/agents\/\$\{encodeURIComponent\(id\)\}/);
    assert.match(script, /method: 'PUT'/);
    assert.match(script, /edit-agent-form/);
    assert.match(script, /source === 'project'/);
    assert.match(script, /await loadAgents\(\)/);
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

test('Save updates one valid project overlay and GET lists the new fields', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const created = await fetch(`${base}/api/agents`, mutation(base, profile('growth-marketer'), 'POST'));
    assert.equal(created.status, 201);
    const file = join(cwd, '.toris', 'agents', 'growth-marketer.json');
    const original = await readFile(file, 'utf8');

    const updated = await fetch(
      `${base}/api/agents/growth-marketer`,
      mutation(base, {
        id: 'growth-marketer',
        title: 'Growth Lead',
        category: 'ship',
        writes: true,
        summary: 'Owns one launch loop for a single operator.',
        system: 'Propose one loop. Cite the repo.',
      }),
    );
    assert.equal(updated.status, 200);
    const body = await updated.json();
    assert.equal(body.ok, true);
    assert.equal(body.agent.id, 'growth-marketer');
    assert.equal(body.agent.title, 'Growth Lead');
    assert.equal(body.agent.category, 'ship');
    assert.equal(body.agent.writes, true);
    assert.equal(body.agent.summary, 'Owns one launch loop for a single operator.');
    assert.equal(body.agent.system, 'Propose one loop. Cite the repo.');
    assert.equal(body.agent.source, 'project');

    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(onDisk, {
      id: 'growth-marketer',
      title: 'Growth Lead',
      category: 'ship',
      writes: true,
      summary: 'Owns one launch loop for a single operator.',
      system: 'Propose one loop. Cite the repo.',
    });
    assert.notEqual(await readFile(file, 'utf8'), original);
    assert.equal(parseAgentProfile(onDisk).id, 'growth-marketer');
    const loaded = await loadAgentProfileFile(file);
    assert.equal(loaded.title, 'Growth Lead');
    assert.equal(loaded.source, 'project');

    const listed = await (await fetch(`${base}/api/agents`)).json();
    const row = listed.agents.find((agent) => agent.id === 'growth-marketer');
    assert.ok(row);
    assert.equal(row.source, 'project');
    assert.equal(row.title, 'Growth Lead');
    assert.equal(row.category, 'ship');
    assert.equal(row.writes, true);
    assert.equal(row.summary, 'Owns one launch loop for a single operator.');
    assert.equal(row.system, 'Propose one loop. Cite the repo.');

    const dirs = await snapshotAgentDirs(home, cwd);
    assert.equal(dirs.home, null);
    assert.equal(Object.keys(dirs.project).join(','), 'growth-marketer.json');
  });
});

test('unauthenticated Save is 403 and writes nothing', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const created = await fetch(`${base}/api/agents`, mutation(base, profile('keep-this'), 'POST'));
    assert.equal(created.status, 201);
    const before = await snapshotAgentDirs(home, cwd);
    const denied = await fetch(`${base}/api/agents/keep-this`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profile('keep-this', { title: 'Should not land' })),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await snapshotAgentDirs(home, cwd), before);
  });
});

test('home and builtin ids are refused without writing', async () => {
  await withServer(async ({ base, home, cwd }) => {
    await seedHomeProfile(home, profile('home-only', { title: 'Home Only', summary: 'Lives only in the user home overlay.' }));
    const before = await snapshotAgentDirs(home, cwd);
    assert.ok(before.home['home-only.json']);
    assert.equal(before.project, null);

    const homeDenied = await fetch(
      `${base}/api/agents/home-only`,
      mutation(base, profile('home-only', { title: 'Overwrite home', summary: 'should not land on disk!!' })),
    );
    assert.equal(homeDenied.status, 404);
    assert.match((await homeDenied.json()).error.message, /not found/i);

    const builtinDenied = await fetch(
      `${base}/api/agents/implementer`,
      mutation(base, profile('implementer', { title: 'Overwrite builtin', summary: 'should not land on disk!!' })),
    );
    assert.equal(builtinDenied.status, 404);
    assert.match((await builtinDenied.json()).error.message, /not found/i);

    const unknownDenied = await fetch(
      `${base}/api/agents/missing-agent`,
      mutation(base, profile('missing-agent')),
    );
    assert.equal(unknownDenied.status, 404);

    const after = await snapshotAgentDirs(home, cwd);
    assert.equal(after.home['home-only.json'], before.home['home-only.json']);
    assert.equal(after.project, null);
    await assert.rejects(() => readdir(join(cwd, '.toris', 'agents')), { code: 'ENOENT' });
  });
});

test('bad body is 400 and writes nothing', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const created = await fetch(`${base}/api/agents`, mutation(base, profile('keep-this'), 'POST'));
    assert.equal(created.status, 201);
    const file = join(cwd, '.toris', 'agents', 'keep-this.json');
    const original = await readFile(file, 'utf8');
    const before = await snapshotAgentDirs(home, cwd);

    const invalid = await fetch(
      `${base}/api/agents/keep-this`,
      mutation(base, profile('keep-this', { title: '', summary: 'too short' })),
    );
    assert.equal(invalid.status, 400);

    const extra = await fetch(
      `${base}/api/agents/keep-this`,
      mutation(base, { ...profile('keep-this'), extra: true }),
    );
    assert.equal(extra.status, 400);

    const renamed = await fetch(
      `${base}/api/agents/keep-this`,
      mutation(base, profile('other-id', { title: 'Renamed', summary: 'should not rename this file!!' })),
    );
    assert.equal(renamed.status, 400);
    assert.match((await renamed.json()).error.message, /immutable/i);

    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await snapshotAgentDirs(home, cwd), before);
    await assert.rejects(() => readdir(join(cwd, '.toris', 'agents', 'other-id.json')));
  });
});

test('edit does not write ~/.toris/agents even when home exists', async () => {
  await withServer(async ({ base, home, cwd }) => {
    const created = await fetch(`${base}/api/agents`, mutation(base, profile('local-only'), 'POST'));
    assert.equal(created.status, 201);
    const updated = await fetch(
      `${base}/api/agents/local-only`,
      mutation(base, profile('local-only', { title: 'Local Only', summary: 'Stays in the project overlay only.' })),
    );
    assert.equal(updated.status, 200);
    const dirs = await snapshotAgentDirs(home, cwd);
    assert.equal(dirs.home, null);
    assert.ok(dirs.project['local-only.json']);
    await assert.rejects(() => readdir(join(home, 'agents')), { code: 'ENOENT' });
  });
});

test('updateStudioAgentProfile rejects home/builtin/bad input before a write lands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'toris-agent-edit-unit-'));
  try {
    const written = await writeAgentProfile(profile('helper-agent'), { projectPath: root });
    assert.equal(written.id, 'helper-agent');
    const updated = await updateStudioAgentProfile(
      'helper-agent',
      profile('helper-agent', { title: 'Helper', summary: 'Updated helper copy for the overlay.' }),
      { projectPath: root },
    );
    assert.equal(updated.agent.title, 'Helper');
    await assert.rejects(
      () => updateStudioAgentProfile('helper-agent', profile('other-id'), { projectPath: root }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
      () => updateStudioAgentProfile('missing-agent', profile('missing-agent'), { projectPath: root }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () => updateStudioAgentProfile('implementer', profile('implementer'), { projectPath: root }),
      (error) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      () =>
        updateStudioAgentProfile(
          'helper-agent',
          profile('helper-agent', { title: '' }),
          { projectPath: root },
        ),
      (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
      () => updateStudioAgentProfile('helper-agent', profile('helper-agent'), {}),
      (error) => error instanceof HttpError && error.status === 400,
    );
    const names = await readdir(join(root, '.toris', 'agents'));
    assert.deepEqual(names, ['helper-agent.json']);
    assert.equal(JSON.parse(await readFile(join(root, '.toris', 'agents', 'helper-agent.json'), 'utf8')).title, 'Helper');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('edit form stays on the Studio agent page source', async () => {
  const html = await readFile(join(repoRoot, 'src/studio/ui/index.html'), 'utf8');
  const js = await readFile(join(repoRoot, 'src/studio/ui/app.js'), 'utf8');
  assert.match(html, /id="edit-agent-form"/);
  assert.match(html, /id="edit-agent-id"/);
  assert.match(js, /method: 'PUT'/);
  assert.match(js, /writes: elements\['edit-agent-writes'\]\.checked/);
  assert.match(js, /\/api\/agents\/\$\{encodeURIComponent\(id\)\}/);
  assert.doesNotMatch(js, /\/api\/agents\/(?:update|delete)/);
  assert.doesNotMatch(js, /~\/\.toris\/agents/);
});
