import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/core/git.js';
import { Store } from '../src/core/store.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { applySavedPatch } from '../src/core/patches.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const plan = JSON.stringify([{ title: 'Make a local change', agent: 'implementer' }]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'toris-orchestrator-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, 'project');
  await mkdir(origin);
  const checkedGit = async (...args) => {
    const result = await git(args, origin);
    assert.equal(result.ok, true, result.stderr);
    return result.stdout;
  };
  await checkedGit('init', '-q');
  await writeFile(join(origin, 'base.txt'), 'original\n');
  await checkedGit('add', 'base.txt');
  await checkedGit('-c', 'user.name=Local QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'fixture');
  const store = await new Store(join(root, 'home')).init();
  const project = { id: 'prj_local', name: 'local', path: origin };
  const engine = options => new Orchestrator({
    store, config: { ...DEFAULT_CONFIG, defaultProvider: 'codex' }, cwd: origin,
    detect: binary => binary === 'codex', notify: async () => {}, ...options,
  });
  return { root, origin, store, project, checkedGit, engine };
}

for (const autonomy of ['L3', 'L4', 'L5']) {
  for (const failure of ['checks', 'task']) {
    for (const apply of [false, true]) {
      test(`${autonomy} holds a patch after failed ${failure}, apply=${apply}`, async t => {
        const f = await fixture(t);
        const run = await f.engine({
          invoke: async (_adapter, prompt, { cwd }) => {
            if (!prompt.includes('Your single task')) return { text: plan, costUsd: 0 };
            await writeFile(join(cwd, 'synthetic.txt'), 'local implementation\n');
            if (failure === 'task') throw new Error('Synthetic task failed after editing');
            return { text: 'Local implementation finished', costUsd: 0 };
          },
        }).run({
          goal: 'local test', project: f.project, autonomy, apply, review: false,
          checks: [`node -e "process.exit(${failure === 'checks' ? 7 : 0})"`],
        });
        assert.equal(run.status, 'failed');
        const patch = (await f.store.readCollection('patches')).find(item => item.id === run.patchId);
        assert.equal(patch?.status, 'pending', 'failed work is saved for an explicit later decision');
        assert.equal(await readFile(join(f.origin, 'synthetic.txt'), 'utf8').catch(() => null), null);
        assert.equal(await f.checkedGit('status', '--porcelain'), '');
        assert.ok(!(await f.store.readEvents(run.id)).some(event => event.type === 'run.applied'));
        if (autonomy === 'L3' && failure === 'checks' && apply === false) {
          await applySavedPatch(f.store, run.patchId);
          assert.equal(await readFile(join(f.origin, 'synthetic.txt'), 'utf8'), 'local implementation\n');
        }
      });
    }
  }
}

for (const autonomy of ['L1', 'L3']) {
  for (const outcome of ['success', 'failure', 'unparsable']) {
    test(`${autonomy} planning isolates even destructive provider output and cleans up after ${outcome}`, async t => {
      const f = await fixture(t);
      let planningDirectory = null;
      let planningPrompt = null;
      const run = await f.engine({
        invoke: async (_adapter, prompt, { cwd }) => {
          planningDirectory = cwd;
          planningPrompt = prompt;
          await writeFile(join(cwd, 'base.txt'), 'destructive synthetic planner edit\n');
          await writeFile(join(cwd, 'planner-output.txt'), 'synthetic planner output\n');
          if (outcome === 'failure') throw new Error('Synthetic planner failed');
          return { text: outcome === 'unparsable' ? 'not a JSON plan' : plan, costUsd: 0.2 };
        },
      }).run({ goal: 'plan safely', project: f.project, autonomy, dryRun: autonomy === 'L3' });
      assert.notEqual(planningDirectory, f.origin);
      assert.ok(!planningPrompt.includes(f.origin), 'planner context names the isolated checkout');
      assert.equal(await readFile(join(f.origin, 'base.txt'), 'utf8'), 'original\n');
      assert.equal(await readFile(join(f.origin, 'planner-output.txt'), 'utf8').catch(() => null), null);
      assert.equal(await f.checkedGit('status', '--porcelain'), '');
      assert.equal((await f.checkedGit('worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 1);
      assert.equal(await readFile(join(planningDirectory, 'base.txt'), 'utf8').catch(() => null), null, 'planning workspace is removed');
      assert.equal(run.costUsd, outcome === 'failure' ? 0 : 0.2);
      assert.equal((await f.store.getRun(run.id)).costUsd, run.costUsd);
      assert.equal(run.status, autonomy === 'L1' ? 'awaiting-approval' : 'dry-run');
      assert.ok(run.tasks.length > 0);
    });
  }
}

test('successful verified L3 work still auto-applies after disposable planning', async t => {
  const f = await fixture(t);
  const run = await f.engine({ invoke: async (_adapter, prompt, { cwd }) => {
    if (!prompt.includes('Your single task')) return { text: plan, costUsd: 0.2 };
    await writeFile(join(cwd, 'implemented.txt'), 'verified\n');
    return { text: 'done', costUsd: 0.1 };
  } }).run({ goal: 'verified change', project: f.project, autonomy: 'L3', checks: ['node -e "process.exit(0)"'], review: false });
  assert.equal(run.status, 'succeeded');
  assert.equal(run.verification.passed, true);
  assert.equal((await f.store.readCollection('patches'))[0].status, 'applied');
  assert.equal(await readFile(join(f.origin, 'implemented.txt'), 'utf8'), 'verified\n');
  assert.ok(Math.abs(run.costUsd - 0.3) < 1e-9);
  assert.equal((await f.checkedGit('worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 1);
});

test('non-Git planning uses a deterministic fallback without running a CLI in the source directory', async t => {
  const f = await fixture(t);
  await rm(join(f.origin, '.git'), { recursive: true, force: true });
  let invoked = false;
  const run = await f.engine({ invoke: async () => { invoked = true; return { text: plan }; } })
    .run({ goal: 'safe preview', project: f.project, dryRun: true });
  assert.equal(invoked, false);
  assert.equal(run.status, 'dry-run');
  assert.equal(run.costUsd, 0);
  assert.ok(run.tasks.length > 0);
  assert.equal(await readFile(join(f.origin, 'base.txt'), 'utf8'), 'original\n');
  assert.ok((await f.store.readEvents(run.id)).some(event => event.type === 'plan.fallback'));
});

test('an unborn Git repository falls back safely when a planning worktree cannot be created', async t => {
  const f = await fixture(t);
  const unborn = join(f.root, 'unborn'); await mkdir(unborn);
  assert.equal((await git(['init', '-q'], unborn)).ok, true);
  await writeFile(join(unborn, 'base.txt'), 'uncommitted source\n');
  let invoked = false;
  const run = await f.engine({ invoke: async () => { invoked = true; return { text: plan }; } })
    .run({ goal: 'safe preview', project: { ...f.project, path: unborn }, dryRun: true });
  assert.equal(invoked, false);
  assert.equal(run.status, 'dry-run');
  assert.ok(run.tasks.length > 0);
  assert.equal(await readFile(join(unborn, 'base.txt'), 'utf8'), 'uncommitted source\n');
  assert.ok((await f.store.readEvents(run.id)).some(event => event.type === 'plan.failed'));
});

test('a repository-free provider plan uses and removes a temporary working directory', async t => {
  const f = await fixture(t);
  let cwd = null;
  const engine = new Orchestrator({
    store: f.store, config: { ...DEFAULT_CONFIG, defaultProvider: 'codex' },
    detect: bin => bin === 'codex',
    invoke: async (_adapter, _prompt, options) => {
      cwd = options.cwd;
      assert.ok(cwd, 'provider planning never inherits the process working directory');
      await writeFile(join(cwd, 'synthetic.txt'), 'temporary only\n');
      return { text: plan, costUsd: 0.2 };
    },
  });
  const run = await engine.run({ goal: 'repository-free preview', dryRun: true });
  assert.equal(run.status, 'dry-run');
  assert.equal(run.costUsd, 0.2);
  assert.notEqual(cwd, process.cwd());
  assert.equal(await readFile(join(cwd, 'synthetic.txt'), 'utf8').catch(() => null), null);
});

for (const apply of [false, true]) {
  test(`an attempted reviewer failure holds verified L3 work, apply=${apply}`, async t => {
    const f = await fixture(t);
    let reviewed = false;
    const run = await f.engine({
      detect: () => true,
      invoke: async (adapter, prompt, { cwd }) => {
        if (adapter.name === 'claude') {
          reviewed = true;
          const error = new Error('Synthetic reviewer timed out after spending $0.04');
          error.costUsd = 0.04;
          throw error;
        }
        if (!prompt.includes('Your single task')) return { text: plan, costUsd: 0.2 };
        await writeFile(join(cwd, 'implemented.txt'), 'verified implementation\n');
        return { text: 'done', costUsd: 0.1 };
      },
    }).run({ goal: 'review before apply', project: f.project, autonomy: 'L3', apply,
      checks: ['node -e "process.exit(0)"'] });
    assert.equal(reviewed, true, 'the second CLI attempted its independent review');
    assert.equal(run.verification.passed, true);
    assert.equal(run.review.passed, false);
    assert.equal(run.review.skipped, false);
    assert.match(run.review.summary, /timed out/);
    assert.equal(run.status, 'awaiting-apply');
    assert.equal((await f.store.readCollection('patches'))[0].status, 'pending');
    assert.equal(await readFile(join(f.origin, 'implemented.txt'), 'utf8').catch(() => null), null);
    assert.equal(await f.checkedGit('status', '--porcelain'), '');
    assert.ok(Math.abs(run.costUsd - 0.34) < 1e-9, 'reported reviewer spend remains in the cost receipt');
    const events = await f.store.readEvents(run.id);
    assert.ok(events.some(event => event.type === 'review.failed' && /timed out/.test(event.error)));
    assert.ok(!events.some(event => event.type === 'run.applied'));
  });
}
