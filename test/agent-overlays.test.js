import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverAgentProfiles,
  loadAgentCatalogue,
  loadAgentProfileFile,
  listSurfaceAgents,
  resolveSurfaceAgent,
  composeAgentCatalogue,
  parseAgentProfile,
  serializeAgentProfile,
  writeAgentProfile,
} from '../src/core/agents.js';
import { normalizeTasks, buildPlanPrompt, validAgents } from '../src/core/planner.js';
import { cmdAgents } from '../src/cli/commands/catalog.js';
import { EXIT } from '../src/core/errors.js';

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'toris-agents-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeProfile(dir, id, extra = {}) {
  await mkdir(dir, { recursive: true });
  const profile = {
    id,
    title: extra.title ?? 'ASO Specialist',
    category: extra.category ?? 'plan',
    writes: extra.writes ?? false,
    summary: extra.summary ?? 'Turns a change into store listing copy.',
    ...('system' in extra ? { system: extra.system } : {}),
  };
  const file = join(dir, `${id}.json`);
  await writeFile(file, JSON.stringify(extra.raw ?? profile), 'utf8');
  return file;
}

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

test('discoverAgentProfiles ignores a missing directory', async () => {
  const overlays = await discoverAgentProfiles(['/definitely/not-an-agents-dir']);
  assert.deepEqual(overlays, []);
});

test('a later directory overrides the same id', async () => {
  await withRoot(async (root) => {
    const homeDir = join(root, 'home', 'agents');
    const projectDir = join(root, 'repo', '.toris', 'agents');
    await writeProfile(homeDir, 'aso-specialist', { title: 'Home ASO' });
    await writeProfile(projectDir, 'aso-specialist', { title: 'Project ASO' });
    await writeProfile(projectDir, 'growth-marketer', {
      title: 'Growth Marketer',
      summary: 'Plans launch loops for a single operator.',
    });
    const overlays = await discoverAgentProfiles([homeDir, projectDir], {
      home: join(root, 'home'),
      projectPath: join(root, 'repo'),
    });
    const aso = overlays.find((agent) => agent.id === 'aso-specialist');
    assert.equal(aso.title, 'Project ASO');
    assert.equal(aso.source, 'project');
    assert.equal(overlays.some((agent) => agent.id === 'growth-marketer'), true);
  });
});

test('loadAgentCatalogue merges overlays into the same catalogue APIs', async () => {
  await withRoot(async (root) => {
    const projectPath = join(root, 'repo');
    await writeProfile(join(projectPath, '.toris', 'agents'), 'aso-specialist');
    const catalogue = await loadAgentCatalogue({ projectPath });
    assert.ok(listSurfaceAgents(undefined, catalogue).some((agent) => agent.id === 'aso-specialist'));
    assert.equal(resolveSurfaceAgent('aso-specialist', catalogue).category, 'plan');
    assert.ok(validAgents(catalogue).has('aso-specialist'));
    assert.match(buildPlanPrompt('ship listing', { name: 'app', path: projectPath }, { catalogue }), /aso-specialist/);
    assert.equal(
      normalizeTasks([{ title: 'Draft listing', agent: 'aso-specialist' }], { catalogue })[0].agent,
      'aso-specialist',
    );
  });
});

test('examples subdirectories are not loaded', async () => {
  await withRoot(async (root) => {
    const agentsDir = join(root, '.toris', 'agents');
    await writeProfile(join(agentsDir, 'examples'), 'aso-specialist');
    const overlays = await discoverAgentProfiles([agentsDir]);
    assert.deepEqual(overlays, []);
  });
});

test('a malformed profile file fails with a path, not a crash', async () => {
  await withRoot(async (root) => {
    const file = join(root, 'broken.json');
    await writeFile(file, '{ not json', 'utf8');
    await assert.rejects(() => loadAgentProfileFile(file), {
      name: 'TorisError',
      code: 'E_INVALID_AGENT',
    });
    await assert.rejects(() => loadAgentProfileFile(file), /not valid JSON/);
    await assert.rejects(() => loadAgentProfileFile(file), /broken\.json/);
  });
});

test('loadAgentCatalogue throws a clear error for a bad project file', async () => {
  await withRoot(async (root) => {
    const dir = join(root, '.toris', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'aso-specialist.json'), JSON.stringify({ id: 'aso-specialist' }), 'utf8');
    await assert.rejects(() => loadAgentCatalogue({ projectPath: root }), /aso-specialist\.json/);
    await assert.rejects(() => loadAgentCatalogue({ projectPath: root }), /title/);
  });
});

test('loadAgentCatalogue skipInvalid keeps valid siblings and drops the broken file', async () => {
  await withRoot(async (root) => {
    const dir = join(root, '.toris', 'agents');
    await mkdir(dir, { recursive: true });
    await writeProfile(dir, 'aso-specialist');
    await writeFile(join(dir, 'broken-specialist.json'), '{', 'utf8');
    await writeFile(join(dir, 'also-broken.json'), JSON.stringify({ id: 'also-broken' }), 'utf8');
    const catalogue = await loadAgentCatalogue({ projectPath: root, skipInvalid: true });
    const agents = listSurfaceAgents(undefined, catalogue);
    assert.ok(agents.some((agent) => agent.id === 'aso-specialist'));
    assert.equal(agents.some((agent) => agent.id === 'broken-specialist'), false);
    assert.equal(agents.some((agent) => agent.id === 'also-broken'), false);
    assert.ok(agents.some((agent) => agent.id === 'implementer'));
  });
});

test('toris agents --json lists a project overlay with source=project', async () => {
  await withRoot(async (root) => {
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await mkdir(home, { recursive: true });
    await writeProfile(join(cwd, '.toris', 'agents'), 'aso-specialist');
    const { code, body } = await captureJson(() =>
      cmdAgents({ home, cwd, json: true }, [], {}),
    );
    assert.equal(code, EXIT.OK);
    const aso = body.agents.find((agent) => agent.id === 'aso-specialist');
    assert.equal(aso.source, 'project');
    assert.equal(body.agents[0].id, 'toris');
    assert.equal(body.agents[0].source, 'builtin');
    assert.ok(body.agents.some((agent) => agent.id === 'implementer'));
  });
});

test('toris agents fails with a field error when a project file is invalid', async () => {
  await withRoot(async (root) => {
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await mkdir(home, { recursive: true });
    await mkdir(join(cwd, '.toris', 'agents'), { recursive: true });
    await writeFile(join(cwd, '.toris', 'agents', 'aso-specialist.json'), '{', 'utf8');
    await assert.rejects(
      () => cmdAgents({ home, cwd, json: true }, [], {}),
      /aso-specialist\.json[\s\S]*JSON/,
    );
  });
});

test('composeAgentCatalogue keeps builtin identity when nothing is overlaid', () => {
  assert.equal(composeAgentCatalogue([]).surface.id, 'toris');
});

test('writeAgentProfile writes one valid project overlay and refuses duplicates', async () => {
  await withRoot(async (root) => {
    const projectPath = join(root, 'repo');
    const home = join(root, 'home');
    const raw = {
      id: 'aso-specialist',
      title: 'ASO Specialist',
      category: 'plan',
      writes: false,
      summary: 'Turns a change into store listing copy.',
      system: 'Advise on listing copy. Do not invent rankings.',
    };
    const written = await writeAgentProfile(raw, { projectPath });
    assert.equal(written.id, 'aso-specialist');
    assert.equal(written.source, 'project');
    const file = join(projectPath, '.toris', 'agents', 'aso-specialist.json');
    assert.equal(written.file, file);
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(onDisk, serializeAgentProfile(parseAgentProfile(raw)));
    assert.equal(Object.hasOwn(onDisk, 'source'), false);

    const catalogue = await loadAgentCatalogue({ home, projectPath });
    assert.equal(resolveSurfaceAgent('aso-specialist', catalogue).title, 'ASO Specialist');

    await assert.rejects(() => writeAgentProfile({ ...raw, title: 'Overwrite' }, { projectPath }), {
      name: 'TorisError',
      code: 'E_AGENT_EXISTS',
    });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).title, 'ASO Specialist');
    await assert.rejects(() => readdir(join(home, 'agents')), { code: 'ENOENT' });
  });
});

test('writeAgentProfile rejects a bad id before creating files', async () => {
  await withRoot(async (root) => {
    const projectPath = join(root, 'repo');
    await assert.rejects(
      () =>
        writeAgentProfile(
          {
            id: 'ASO',
            title: 'ASO Specialist',
            category: 'plan',
            writes: false,
            summary: 'Turns a change into store listing copy.',
          },
          { projectPath },
        ),
      { name: 'TorisError', code: 'E_INVALID_AGENT' },
    );
    await assert.rejects(() => writeAgentProfile({ id: 'ok' }, {}), /project path/);
    await assert.rejects(() => readdir(join(projectPath, '.toris')), { code: 'ENOENT' });
  });
});
