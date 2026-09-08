import { newRunId, newEventId } from './ids.js';
import { ADAPTERS, oppositeProvider, invokeProvider, detectBinary } from './providers.js';
import { buildPlanPrompt, extractJsonArray, normalizeTasks, fallbackPlan } from './planner.js';
import { resolveAutonomy, gate, withinBudget, RECOMMENDED_AUTONOMY } from './autonomy.js';
import { verify, inferChecks, detectChecks } from './verifier.js';
import { changedFiles, isRepo } from './git.js';
import { buildReceipt } from './receipt.js';
import { TorisError } from './errors.js';
import { openIsolation, settleIsolation } from './isolation.js';
import { formatPatchNotice, notifyChannels } from './channels.js';

const nowIso = () => new Date().toISOString();

/** Prompt for a single task, scoped so the agent edits only what it owns. */
export function buildTaskPrompt(task, run, project) {
  return [
    `You are the "${task.agent}" agent on an autonomous run.`,
    project ? `Repository: ${project.path}` : '',
    `Overall goal: ${run.goal}`,
    '',
    `Your single task: ${task.title}`,
    task.detail ? `Details: ${task.detail}` : '',
    task.verify ? `Definition of done: ${task.verify}` : '',
    '',
    'Make the change in this isolated worktree only. Do not edit, commit or push the original checkout.',
    'The original repository is off-limits. Toris will apply your diff later if the operator approves.',
    `This run is autonomy ${run.autonomy}. Do not ask for confirmation; if a detail is ambiguous, choose the smallest reasonable option and say so in your summary.`,
    'When finished, reply with a one-paragraph summary of exactly what you changed.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Executes a run end to end.
 * Injectable deps keep this unit-testable with no provider installed.
 */
export class Orchestrator {
  /**
   * @param {{store:any, config:any, invoke?:Function, detect?:Function, verifyFn?:Function, now?:Function, onEvent?:Function}} deps
   */
  constructor({
    store,
    config,
    invoke = invokeProvider,
    detect = detectBinary,
    verifyFn = verify,
    detectChecksFn = detectChecks,
    now = Date.now,
    onEvent,
    notify,
  } = {}) {
    this.store = store;
    this.config = config;
    this.invoke = invoke;
    this.detect = detect;
    this.verifyFn = verifyFn;
    this.detectChecksFn = detectChecksFn;
    this.now = now;
    this.onEvent = onEvent;
    this.notify = notify ?? ((text) => notifyChannels(this.config, text));
  }

  async #emit(run, type, data = {}) {
    const event = { id: newEventId(this.now), runId: run.id, type, at: nowIso(), ...data };
    if (this.store) await this.store.appendEvent(run.id, event);
    if (this.onEvent) this.onEvent(event);
    return event;
  }

  /** Pick a usable provider, falling back to the other one if the first is absent. */
  async resolveProvider(preferred) {
    const order = [preferred, oppositeProvider(preferred)];
    for (const name of order) {
      const adapter = ADAPTERS[name];
      if (adapter && (await this.detect(adapter.bin))) return { adapter, available: true };
    }
    return { adapter: ADAPTERS[preferred] ?? ADAPTERS.claude, available: false };
  }

  async plan(run, project, adapter, available) {
    if (!available) {
      await this.#emit(run, 'plan.fallback', { reason: 'no provider binary on PATH' });
      return fallbackPlan(run.goal, { now: this.now });
    }
    const prompt = buildPlanPrompt(run.goal, project);
    let result;
    try {
      result = await this.invoke(adapter, prompt, {
        cwd: project?.path,
        timeoutMs: this.config?.providerTimeoutMs,
      });
    } catch (err) {
      // A provider that is installed but refuses to run (untrusted directory,
      // expired auth, network failure, timeout) is no more fatal than one that
      // is missing entirely: degrade to the deterministic plan so the user still
      // gets something actionable instead of a stack trace.
      await this.#emit(run, 'plan.failed', { reason: err?.message ?? String(err) });
      return fallbackPlan(run.goal, { now: this.now });
    }
    const tasks = normalizeTasks(extractJsonArray(result.text), { now: this.now });
    if (tasks.length === 0) {
      await this.#emit(run, 'plan.unparsable', { replyPreview: String(result.text).slice(0, 300) });
      return fallbackPlan(run.goal, { now: this.now });
    }
    return tasks;
  }

  /**
   * Which commands prove this run. Explicit checks win; otherwise the project is
   * sniffed on disk, because a project registered before its test script existed
   * would otherwise verify nothing and still report "succeeded".
   */
  async #resolveChecks(run, opts) {
    if (Array.isArray(opts.checks) && opts.checks.length > 0) {
      return { checks: opts.checks, inferred: false };
    }
    if (!run.projectPath) return { checks: [], inferred: false };
    const checks = await this.detectChecksFn(run.projectPath);
    return { checks, inferred: checks.length > 0 };
  }

  /** Run the checks and fold the evidence into the run. Never throws. */
  async #verifyRun(run, opts, cwd = run.projectPath) {
    const { checks, inferred } = await this.#resolveChecks(run, opts);
    if (checks.length === 0) {
      // Saying so out loud matters: "no checks" and "checks passed" are very
      // different receipts, and only one of them is evidence.
      await this.#emit(run, 'verify.skipped', {
        reason: run.projectPath
          ? 'no checks configured and none could be detected for this project'
          : 'run has no project path, so there is nothing to verify against',
      });
      return run;
    }
    await this.#emit(run, 'verify.started', { checks, inferred });
    const verification = await this.verifyFn(checks, { cwd: cwd ?? run.projectPath });
    const verified = { ...run, verification };
    await this.#emit(verified, 'verify.finished', {
      passed: verification.passed,
      failed: verification.checks.filter((c) => !c.passed).map((c) => c.command),
    });
    return verified;
  }

  /**
   * @param {{goal:string, project?:any, autonomy?:string, budgetUsd?:number, dryRun?:boolean, provider?:string}} opts
   */
  async run(opts) {
    // A programmatic caller with no config should get the recommended solo
    // default rather than a "Unknown autonomy level undefined" error.
    const autonomy = resolveAutonomy(
      opts.autonomy ?? this.config?.defaultAutonomy ?? RECOMMENDED_AUTONOMY,
    );
    const preferred = opts.provider ?? this.config?.defaultProvider;
    const { adapter, available } = await this.resolveProvider(preferred);

    const run = {
      id: newRunId(this.now),
      goal: opts.goal,
      projectId: opts.project?.id ?? null,
      projectPath: opts.project?.path ?? null,
      autonomy: autonomy.level,
      provider: adapter.name,
      providerAvailable: available,
      status: 'planning',
      dryRun: Boolean(opts.dryRun),
      budgetUsd: opts.budgetUsd ?? this.config?.maxDailyCostUsd,
      costUsd: 0,
      tasks: [],
      artifacts: [],
      verification: { checks: [], passed: null },
      createdAt: nowIso(),
      finishedAt: null,
    };
    await this.store?.saveRun(run);
    await this.#emit(run, 'run.started', {
      goal: run.goal,
      autonomy: run.autonomy,
      provider: run.provider,
    });

    const tasks = await this.plan(run, opts.project, adapter, available);
    const planned = { ...run, tasks, status: 'planned' };
    await this.store?.saveRun(planned);
    await this.#emit(planned, 'run.planned', { taskCount: tasks.length });

    if (opts.dryRun) {
      const finished = { ...planned, status: 'dry-run', finishedAt: nowIso() };
      await this.store?.saveRun(finished);
      await this.#emit(finished, 'run.finished', { status: finished.status });
      return finished;
    }

    const writeGate = gate(autonomy.level, 'write');
    if (!writeGate.allowed) {
      const blocked = {
        ...planned,
        status: 'awaiting-approval',
        blockedReason: writeGate.reason,
        finishedAt: nowIso(),
      };
      await this.store?.saveRun(blocked);
      await this.#emit(blocked, 'run.blocked', { reason: writeGate.reason });
      return blocked;
    }

    if (!available) {
      throw new TorisError(
        `No provider CLI found. Install "claude" or "codex", or set TORIS_CLAUDE_BIN / TORIS_CODEX_BIN.`,
        'E_NO_PROVIDER',
      );
    }

    let isolation = null;
    const originPath = opts.project?.path ?? run.projectPath;
    if (originPath && this.store?.home && (await isRepo(originPath))) {
      isolation = await openIsolation({ origin: originPath, home: this.store.home, id: run.id });
      await this.#emit(planned, 'run.isolated', { worktree: isolation.session.path });
    } else if (originPath) {
      await this.#emit(planned, 'run.unisolated', {
        reason: 'project is not a git repository, so the coding CLI cannot be fenced off',
      });
    }

    const execCwd = isolation?.session.path ?? originPath ?? undefined;

    // Execute tasks sequentially: each one may depend on the previous edit.
    let current = { ...planned, status: 'running' };
    await this.store?.saveRun(current);
    const executed = [];
    for (const task of current.tasks) {
      const budget = withinBudget(current.costUsd, 0.05, current.budgetUsd);
      if (!budget.ok) {
        executed.push({ ...task, status: 'skipped', note: 'budget exhausted' });
        await this.#emit(current, 'task.skipped', {
          taskId: task.id,
          title: task.title,
          reason: `budget exhausted ($${Number(current.budgetUsd).toFixed(2)} cap reached)`,
        });
        continue;
      }
      await this.#emit(current, 'task.started', {
        taskId: task.id,
        title: task.title,
        agent: task.agent,
      });
      try {
        const result = await this.invoke(adapter, buildTaskPrompt(task, current, opts.project), {
          cwd: execCwd,
          timeoutMs: this.config?.providerTimeoutMs,
        });
        current = { ...current, costUsd: current.costUsd + (result.costUsd || 0) };
        executed.push({
          ...task,
          status: 'succeeded',
          summary: String(result.text).slice(0, 2000),
        });
        await this.#emit(current, 'task.succeeded', {
          taskId: task.id,
          title: task.title,
          costUsd: result.costUsd || 0,
        });
      } catch (err) {
        executed.push({ ...task, status: 'failed', error: err.message });
        await this.#emit(current, 'task.failed', {
          taskId: task.id,
          title: task.title,
          error: err.message,
        });
        break;
      }
    }
    current = { ...current, tasks: executed };

    current = await this.#verifyRun(current, opts, execCwd);
    if (execCwd && (await isRepo(execCwd))) {
      current = { ...current, artifacts: await changedFiles(execCwd) };
    }

    let pendingApply = false;
    if (isolation) {
      const settled = await settleIsolation({
        store: this.store,
        session: isolation.session,
        before: isolation.before,
        source: 'run',
        autonomy: autonomy.level,
        runId: current.id,
        forceApply: Boolean(opts.apply),
      });
      pendingApply = Boolean(settled.patch && !settled.applied);
      current = {
        ...current,
        patchId: settled.patch?.id ?? null,
        originTouched: settled.leaked,
        artifacts: settled.patch?.files ?? current.artifacts,
      };
      if (settled.leaked) {
        await this.#emit(current, 'run.origin-touched', {
          reason: 'the original checkout changed while the coding CLI ran; apply is blocked',
        });
      }
      if (pendingApply) {
        await this.#emit(current, 'run.awaiting-apply', { patchId: settled.patch.id });
        await this.notify?.(formatPatchNotice(settled.patch, `run ${current.id}`)).catch(() => undefined);
      }
      if (settled.applied) {
        await this.#emit(current, 'run.applied', { patchId: settled.patch.id });
        await this.notify?.(formatPatchNotice(settled.patch, `applied for run ${current.id}`)).catch(
          () => undefined,
        );
      }
    }

    const anyFailed = current.tasks.some((t) => t.status === 'failed');
    const verifyFailed = current.verification.passed === false;
    const finished = {
      ...current,
      status: anyFailed || verifyFailed ? 'failed' : pendingApply ? 'awaiting-apply' : 'succeeded',
      finishedAt: nowIso(),
    };
    await this.store?.saveRun(finished);
    await this.#emit(finished, 'run.finished', { status: finished.status });
    return finished;
  }
}

export { buildReceipt, inferChecks };
