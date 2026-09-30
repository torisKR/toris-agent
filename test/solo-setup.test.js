import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyDecision } from '../src/core/apply-gate.js';

const cli = resolve('bin/toris.js');

async function fixture(fn, providers = ['codex']) {
  // Child processes and Git expose physical paths on macOS, where TMPDIR can
  // contain the /var alias for /private/var.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'toris-solo-')));
  const home = join(dir, 'state');
  const project = join(dir, 'project');
  const bin = join(dir, 'bin');
  await mkdir(project);
  await mkdir(bin);
  await writeFile(join(project, 'package.json'), JSON.stringify({
    name: 'solo-project',
    scripts: { lint: 'node --check index.js', test: 'node --test', 'build:native': 'cargo build' },
  }));
  for (const provider of providers) {
    const path = join(bin, provider);
    // Discovery must never invoke a provider or require its credentials.
    await writeFile(path, '#!/bin/sh\nexit 99\n');
    await chmod(path, 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  delete env.TORIS_CODEX_BIN;
  delete env.TORIS_CLAUDE_BIN;
  const invoke = (...flags) => spawnSync(process.execPath,
      [cli, 'init', '--solo', '--json', '--home', home, ...flags],
      { cwd: project, env, encoding: 'utf8' });
  const init = (...flags) => {
    const result = invoke(...flags);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  try {
    await fn({ home, project, bin, init, invoke, env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('init --solo creates a manual-review harness using the available CLI', async () => {
  await fixture(async ({ home, project, init }) => {
    const result = init();
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(config.defaultAutonomy, 'L2');
    assert.equal(applyDecision(config.defaultAutonomy), 'ask');
    assert.equal(config.maxParallelAgents, 1);
    assert.equal(config.maxDailyCostUsd, 20);
    assert.equal(config.knowledge.autoRetrieve, true);
    assert.equal(config.defaultProvider, 'codex');
    assert.deepEqual(config.models.profiles['codex-cli'], { provider: 'codex-cli', model: 'auto' });
    assert.equal(config.models.routing.chat, 'codex-cli');
    assert.equal(config.providers.claude.enabled, false);
    assert.equal(result.solo.project.path, project);
    assert.deepEqual(result.solo.project.checks, ['npm run lint', 'npm run test']);
    assert.equal(result.solo.apply, 'manual');
  });
});

test('init --solo preserves explicitly stored preferences and custom project checks', async () => {
  await fixture(async ({ home, project, init }) => {
    await mkdir(home);
    const stored = {
      defaultAutonomy: 'L4', maxParallelAgents: 5, maxDailyCostUsd: 8,
      defaultProvider: 'claude',
      providers: { claude: { bin: 'custom-claude', enabled: true }, codex: { enabled: false } },
      knowledge: { autoRetrieve: false, custom: 'kept' },
      models: { profiles: { mine: { provider: 'anthropic', model: 'user-choice' } }, routing: { chat: 'mine' } },
      futureSetting: { keep: true },
    };
    await writeFile(join(home, 'config.json'), JSON.stringify(stored));
    const existing = {
      id: 'project_user', name: 'mine', path: project,
      checks: ['npm run custom-check'], addedAt: '2026-01-01T00:00:00.000Z',
    };
    await writeFile(join(home, 'projects.json'), JSON.stringify([existing]));
    const result = init();
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    for (const key of Object.keys(stored)) assert.deepEqual(config[key], {
      providers: { claude: stored.providers.claude, codex: { bin: 'codex', enabled: false } },
    }[key] ?? stored[key], key);
    assert.equal(result.created, false);
    assert.equal(result.solo.projectCreated, false);
    assert.deepEqual(result.solo.project, existing);
    assert.equal(result.solo.apply, 'automatic');
  });
});

test('init --solo completes missing values from disk rather than inherited config defaults', async () => {
  await fixture(async ({ home, init }) => {
    await mkdir(home);
    await writeFile(join(home, 'config.json'), JSON.stringify({ maxDailyCostUsd: 7 }));
    init();
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(config.maxDailyCostUsd, 7);
    assert.equal(config.defaultAutonomy, 'L2');
    assert.equal(config.maxParallelAgents, 1);
    assert.equal(config.defaultProvider, 'codex');
    assert.equal(config.models.routing.chat, 'codex-cli');
  });
});

test('init --solo is repeatable without duplicating project registration or changing config', async () => {
  await fixture(async ({ home, init }) => {
    const first = init();
    const before = await readFile(join(home, 'config.json'), 'utf8');
    const second = init();
    assert.equal(second.solo.projectCreated, false);
    assert.equal(second.solo.project.id, first.solo.project.id);
    assert.equal(await readFile(join(home, 'config.json'), 'utf8'), before);
    const projects = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8'));
    assert.equal(projects.length, 1);
  });
});

test('init --solo with no CLI does not invent a connected chat profile', async () => {
  await fixture(async ({ home, init }) => {
    const result = init();
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.deepEqual(config.models.profiles, {});
    assert.deepEqual(config.models.routing, {});
    assert.equal(config.providers.claude.enabled, false);
    assert.equal(config.providers.codex.enabled, false);
    assert.deepEqual(result.solo.availableProviders, []);
  }, []);
});

test('init --solo prefers a stored enabled provider when both CLIs are available', async () => {
  await fixture(async ({ home, init }) => {
    await mkdir(home);
    await writeFile(join(home, 'config.json'), JSON.stringify({ defaultProvider: 'codex' }));
    const result = init();
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.deepEqual(result.solo.availableProviders, ['claude', 'codex']);
    assert.equal(config.models.routing.chat, 'codex-cli');
  }, ['claude', 'codex']);
});

test('init --solo preserves an unreadable or invalid stored config without overwriting it', async () => {
  await fixture(async ({ home, invoke }) => {
    await mkdir(home);
    for (const contents of ['{broken', 'null', '{"defaultAutonomy":"L9"}']) {
      await writeFile(join(home, 'config.json'), contents);
      const result = invoke();
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).error.code, 'E_CONFIG');
      assert.equal(await readFile(join(home, 'config.json'), 'utf8'), contents);
    }
  });
});

test('init --solo registers the Git root when invoked from a subdirectory without creating a worktree', async () => {
  await fixture(async ({ home, project, init, env }) => {
    const gitInit = spawnSync('git', ['init', '-q'], { cwd: project, env, encoding: 'utf8' });
    assert.equal(gitInit.status, 0, gitInit.stderr);
    const nested = join(project, 'src');
    await mkdir(nested);
    const result = spawnSync(process.execPath, [cli, 'init', '--solo', '--json', '--home', home],
      { cwd: nested, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const first = JSON.parse(result.stdout);
    assert.equal(first.solo.project.path, project);
    assert.equal(first.solo.project.isGitRepo, true);
    assert.equal(init().solo.project.id, first.solo.project.id);
    const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'],
      { cwd: project, env, encoding: 'utf8' });
    assert.equal(worktrees.status, 0, worktrees.stderr);
    assert.equal(worktrees.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
  });
});

test('init --solo recognizes an existing project through its stored symlink path', async () => {
  await fixture(async ({ home, project, init }) => {
    const alias = join(project, '..', 'project-alias');
    await symlink(project, alias, 'dir');
    await mkdir(home);
    const existing = {
      id: 'project_alias', name: 'user-name', path: alias,
      checks: ['npm run custom-check'], addedAt: '2026-01-01T00:00:00.000Z',
    };
    await writeFile(join(home, 'projects.json'), JSON.stringify([existing]));
    const first = init();
    const second = init();
    const normalized = { ...existing, path: project };
    assert.equal(first.solo.projectCreated, false);
    assert.equal(second.solo.projectCreated, false);
    assert.deepEqual(first.solo.project, normalized, 'only the equivalent path is normalized');
    assert.deepEqual(JSON.parse(await readFile(join(home, 'projects.json'), 'utf8')), [normalized]);
    const { Store } = await import('../src/core/store.js');
    const { createHarnessHandlers } = await import('../src/cli/tui/harness.js');
    const output = [];
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    await createHarnessHandlers({ home, cwd: project, config, store: new Store(home) }, {
      log: line => output.push(line),
    }).status();
    assert.ok(output.some(line => /project.*user-name/.test(line)), 'the TUI selects the preserved project');
    assert.ok(output.some(line => /checks.*npm run custom-check/.test(line)), 'custom checks remain active');
  });
});
