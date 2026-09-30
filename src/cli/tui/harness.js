import { relative, isAbsolute, sep } from 'node:path';
import { detectChecks, verify, failureExcerpt } from '../../core/verifier.js';
import { listPatches, getPatch, readPatchDiff } from '../../core/patches.js';
import { cmdRun, cmdReceipt } from '../commands/run.js';
import { c } from '../output.js';

/** Connect local harness operations to the same project, checks and receipts as the CLI. */
export function createHarnessHandlers(ctx, {
  log,
  workingDirectory = () => ctx.cwd,
  liveDiff = async () => null,
  autonomy = () => ctx.config.defaultAutonomy,
  offline = false,
  runCommand = cmdRun,
} = {}) {
  let runTarget = null;
  let receiptTarget = null;
  const project = async () => {
    const items = await ctx.store.readCollection('projects');
    return items.filter(item => {
      const path = relative(item.path, ctx.cwd);
      return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    }).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  };
  const editingDirectory = async () => {
    if (!runTarget) return workingDirectory();
    const patch = runTarget.patchId ? await getPatch(ctx.store, runTarget.patchId) : null;
    return patch?.status === 'pending' && patch.worktreePath
      ? patch.worktreePath : (await project())?.path ?? ctx.cwd;
  };
  const runGoal = async (args, dryRun) => {
    if (args.length === 0) throw new Error(`Usage: /${dryRun ? 'plan' : 'run'} <goal>`);
    if (offline && !dryRun) throw new Error('Offline session: use /plan, or restart toris with a connected provider to /run.');
    const selected = await project();
    if (!selected && !dryRun) throw new Error('Register this project with `toris init --solo` before /run.');
    let commandRun = null;
    const exitCode = await runCommand({ ...ctx, json: false, onRunResult: run => { commandRun = run; } }, args, {
      'dry-run': dryRun,
      autonomy: autonomy(),
      offline,
      ...(selected ? { project: selected.id } : {}),
    });
    if (commandRun) receiptTarget = commandRun;
    if (!dryRun) runTarget = commandRun;
    if (exitCode === 4) log(c.yellow('Run paused. /patches → /diff <id> → /apply <id> or /discard <id>.'));
    else if (exitCode !== 0) log(c.red(`Run stopped (exit ${exitCode}). /receipt shows the evidence.`));
    return exitCode;
  };
  return {
    onChatTurn: () => { runTarget = null; },
    status: async () => {
      const selected = await project();
      const pending = await listPatches(ctx.store, { status: 'pending' });
      const checks = selected?.checks?.length ? selected.checks : await detectChecks(ctx.cwd);
      const cap = ctx.config.maxDailyCostUsd;
      log(c.bold('Solo workspace'));
      log(`  project   ${selected?.name ?? 'unregistered — toris init --solo'}`);
      log(`  directory ${ctx.cwd}`);
      log(`  editing   ${await editingDirectory()}`);
      log(`  autonomy  ${autonomy()}`);
      log(`  agents    ${ctx.config.maxParallelAgents}`);
      log(`  daily cap ${cap > 0 ? `$${cap}` : 'unlimited'}`);
      log(`  checks    ${checks.length ? checks.join(' · ') : 'none detected — unverified'}`);
      log(`  patches   ${pending.length} pending`);
      log(c.dim('  /plan <goal> → /run <goal> → /check → /diff → /receipt'));
    },
    plan: args => runGoal(args, true),
    run: args => runGoal(args, false),
    check: async () => {
      const selected = await project();
      const cwd = await editingDirectory();
      const checks = selected?.checks?.length ? selected.checks : await detectChecks(cwd);
      if (!checks.length) {
        log(c.yellow('No checks detected. This workspace is unverified; configure project checks first.'));
        return { checks: [], passed: null };
      }
      log(c.bold(`Checking ${cwd}`));
      const result = await verify(checks, { cwd });
      for (const check of result.checks) {
        log(`${check.passed ? c.green('PASS') : c.red('FAIL')}  ${check.command}  (exit ${check.exitCode})`);
        const excerpt = failureExcerpt(check);
        if (excerpt) log(excerpt);
      }
      log(c.dim('These checks validate the current files; /receipt reports checks performed by a run.'));
      return result;
    },
    diff: async args => {
      if (!args[0]) {
        if (runTarget?.patchId) args = [runTarget.patchId];
      }
      if (!args[0]) {
        const live = await liveDiff();
        if (live !== null) {
          log(live || 'No changes in the live isolated session.');
          return;
        }
        const [latest] = await listPatches(ctx.store, { status: 'pending' });
        if (!latest) { log('No pending patch.'); return; }
        args = [latest.id];
      }
      const saved = await getPatch(ctx.store, args[0]);
      if (!saved) throw new Error(`No patch matching "${args[0]}". /patches lists saved patches.`);
      log(c.bold(`Diff ${saved.id} · ${saved.status}`));
      log(await readPatchDiff(saved) || '(empty diff)');
    },
    receipt: async args => {
      const id = args[0] ?? receiptTarget?.id ?? (await ctx.store.listRuns())[0]?.id;
      if (!id) { log('No run receipt yet. Start with /plan <goal>.'); return 0; }
      return cmdReceipt({ ...ctx, json: false }, [id], {});
    },
  };
}
