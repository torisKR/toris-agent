import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/core/store.js';

// The new terminal workflow must execute real project checks, preserve failing
// evidence, and keep commands local instead of handing them to a model.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'toris-tui-harness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const store = new Store(join(root, 'home'));
  await store.init();
  return { cwd, store, home: store.home, config: { defaultAutonomy: 'L2', maxParallelAgents: 1, maxDailyCostUsd: 20, defaultProvider: 'codex' }, json: false };
}

async function handlers(ctx, options = {}) {
  const module = await import('../src/cli/tui/harness.js').catch(() => null);
  assert.ok(module?.createHarnessHandlers, 'terminal harness handlers are implemented');
  const output = [];
  return { actions: module.createHarnessHandlers(ctx, { log: text => output.push(text), ...options }), output };
}

test('project matching includes a child whose name starts with two dots, but excludes siblings', async t => {
  const ctx = await fixture(t);
  await ctx.store.writeCollection('projects', [{ id: 'prj_test', name: 'Registered solo project', path: ctx.cwd, checks: [] }]);
  const child = join(ctx.cwd, '..notes'); await mkdir(child);
  const nested = await handlers({ ...ctx, cwd: child });
  await nested.actions.status([]);
  assert.ok(nested.output.some(text => text.includes('Registered solo project')));
  const sibling = join(ctx.cwd, '..', 'project-other'); await mkdir(sibling);
  const outside = await handlers({ ...ctx, cwd: sibling });
  await outside.actions.status([]);
  assert.ok(outside.output.some(text => text.includes('unregistered')));
});

test('check runs detected checks in the live editing directory', async t => {
  const ctx = await fixture(t);
  const live = join(ctx.cwd, 'live'); await mkdir(live);
  await writeFile(join(live, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'checked\',\'yes\')"' } }));
  const { actions, output } = await handlers(ctx, { workingDirectory: () => live });
  const result = await actions.check([]);
  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 1);
  assert.equal(await readFile(join(live, 'checked'), 'utf8'), 'yes');
  assert.ok(output.some(text => /PASS/.test(text)));
});

test('check shows a failing command and its evidence, and status still works', async t => {
  const ctx = await fixture(t);
  await ctx.store.writeCollection('projects', [{ id: 'prj_test', name: 'Solo', path: ctx.cwd, checks: ["node -e \"console.error('missing widget');process.exit(3)\"", "node -e \"require('fs').writeFileSync('should-not-run','x')\""] }]);
  const { actions, output } = await handlers(ctx);
  const result = await actions.check([]);
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].exitCode, 3);
  assert.equal(result.checks.length, 1);
  assert.ok(output.some(text => /missing widget/.test(text)));
  await actions.status([]);
  assert.ok(output.some(text => /Solo/.test(text)));
});

test('no checks is described as unverified rather than a pass', async t => {
  const ctx = await fixture(t);
  const { actions, output } = await handlers(ctx);
  const result = await actions.check([]);
  assert.equal(result.passed, null);
  assert.equal(result.checks.length, 0);
  assert.ok(output.some(text => /no checks|unverified/i.test(text)));
  assert.ok(!output.some(text => /PASS/.test(text)));
});

test('diff shows a saved patch without applying it', async t => {
  const ctx = await fixture(t);
  const diffPath = join(ctx.home, 'sample.diff');
  const diff = '--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-old\n+new\n';
  await writeFile(diffPath, diff);
  await ctx.store.writeCollection('patches', [{ id: 'pat_demo', status: 'pending', diffPath }]);
  const { actions, output } = await handlers(ctx);
  await actions.diff(['pat_demo']);
  assert.ok(output.some(text => text.includes('+new')));
  assert.equal((await ctx.store.readCollection('patches'))[0].status, 'pending');
});

test('diff without an id inspects the live isolation and keeps its patch pending', async t => {
  const ctx = await fixture(t);
  const { actions, output } = await handlers(ctx, { liveDiff: async () => '--- a/main.js\n+++ b/main.js\n+changed\n' });
  await actions.diff([]);
  assert.ok(output.some(text => text.includes('+changed')));
  assert.equal((await ctx.store.readCollection('patches')).length, 0);
});

test('checks and diff follow a pending run instead of an unrelated chat worktree', async t => {
  const ctx = await fixture(t);
  const chat = join(ctx.cwd, 'chat'); const run = join(ctx.cwd, 'run');
  await mkdir(chat); await mkdir(run);
  const command = "node -e \"require('fs').writeFileSync('checked','yes')\"";
  await ctx.store.writeCollection('projects', [{ id: 'prj_test', name: 'Solo', path: ctx.cwd, checks: [command] }]);
  const diffPath = join(ctx.home, 'run.diff'); await writeFile(diffPath, '+run change\n');
  const { actions, output } = await handlers(ctx, {
    workingDirectory: () => chat,
    liveDiff: async () => '',
    runCommand: async commandContext => {
      await ctx.store.writeCollection('patches', [{ id: 'pat_run', status: 'pending', worktreePath: run, diffPath }]);
      const result = { id: 'run_target', status: 'awaiting-apply', patchId: 'pat_run', createdAt: new Date().toISOString() };
      await ctx.store.saveRun(result);
      await commandContext.onRunResult?.(result);
      return 4;
    },
  });
  await actions.run(['implement']);
  await actions.check([]);
  await actions.diff([]);
  assert.equal(await readFile(join(run, 'checked'), 'utf8'), 'yes');
  assert.ok(output.some(text => text.includes('+run change')));
  actions.onChatTurn();
  await actions.check([]);
  assert.equal(await readFile(join(chat, 'checked'), 'utf8'), 'yes');
});

test('a newer concurrent run cannot redirect foreground checks or diff to another project', async t => {
  const ctx = await fixture(t);
  const foreground = join(ctx.cwd, 'foreground'); const unrelated = join(ctx.cwd, 'unrelated');
  await mkdir(foreground); await mkdir(unrelated);
  const command = "node -e \"require('fs').writeFileSync('checked','yes')\"";
  await ctx.store.writeCollection('projects', [{ id: 'prj_foreground', name: 'Solo', path: ctx.cwd, checks: [command] }]);
  const foregroundDiff = join(ctx.home, 'foreground.diff'); const unrelatedDiff = join(ctx.home, 'unrelated.diff');
  await writeFile(foregroundDiff, '+foreground change\n'); await writeFile(unrelatedDiff, '+unrelated change\n');
  const { actions, output } = await handlers(ctx, {
    runCommand: async commandContext => {
      await ctx.store.writeCollection('patches', [
        { id: 'pat_foreground', status: 'pending', worktreePath: foreground, diffPath: foregroundDiff },
        { id: 'pat_unrelated', status: 'pending', worktreePath: unrelated, diffPath: unrelatedDiff },
      ]);
      const ownRun = { id: 'run_foreground', projectId: 'prj_foreground', patchId: 'pat_foreground', status: 'awaiting-apply', createdAt: '2026-01-01T00:00:00Z' };
      await ctx.store.saveRun(ownRun);
      await ctx.store.saveRun({ id: 'run_unrelated', projectId: 'prj_other', patchId: 'pat_unrelated', status: 'awaiting-apply', createdAt: '2026-01-01T00:01:00Z' });
      await commandContext.onRunResult?.(ownRun);
      return 4;
    },
  });
  await actions.run(['implement']);
  await actions.check([]);
  await actions.diff([]);
  assert.equal(await readFile(join(foreground, 'checked'), 'utf8'), 'yes');
  await assert.rejects(readFile(join(unrelated, 'checked')), { code: 'ENOENT' });
  assert.ok(output.some(text => text.includes('+foreground change')));
  assert.ok(!output.some(text => text.includes('+unrelated change')));
});

test('plan creates a dry-run receipt without provider binaries or editing files', async t => {
  const ctx = await fixture(t);
  await ctx.store.writeCollection('projects', [{ id: 'prj_test', name: 'Solo', path: ctx.cwd, checks: [] }]);
  const url = new URL('../src/cli/tui/harness.js', import.meta.url).href;
  const storeUrl = new URL('../src/core/store.js', import.meta.url).href;
  const code = `import {createHarnessHandlers} from ${JSON.stringify(url)}; import {Store} from ${JSON.stringify(storeUrl)}; const ctx=${JSON.stringify({ ...ctx, store: undefined })}; ctx.store=new Store(ctx.home); await createHarnessHandlers(ctx,{log:console.log}).plan(['add','a','health','endpoint']);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ctx.cwd, encoding: 'utf8', env: { ...process.env, TORIS_CODEX_BIN: join(ctx.cwd, 'missing-codex'), TORIS_CLAUDE_BIN: join(ctx.cwd, 'missing-claude') } });
  assert.equal(child.status, 0, child.stderr);
  const runs = await ctx.store.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].dryRun, true);
  assert.equal(runs[0].goal, 'add a health endpoint');
  assert.ok(runs[0].tasks.length > 0);
  const { actions } = await handlers(ctx);
  assert.equal(await actions.receipt([]), 0);
});
