import { newRunId, newEventId } from './ids.js';
import { ADAPTERS, oppositeProvider, invokeProvider, detectBinary } from './providers.js';
import { buildPlanPrompt, extractJsonArray, normalizeTasks, fallbackPlan } from './planner.js';
import { resolveAutonomy, gate, withinBudget } from './autonomy.js';
import { verify, inferChecks } from './verifier.js';
import { changedFiles, isRepo } from './git.js';
import { buildReceipt } from './receipt.js';
import { TorisError } from './errors.js';

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
    'Make the change directly in the repository. Keep it minimal and focused.',
    'When finished, reply with a one-paragraph summary of exactly what you changed.',
  ].filter(Boolean).join('\n');
}

/**
 * Executes a run end to end.
 * Injectable deps keep this unit-testable with no provider installed.
 */
export class Orchestrator {
  /**
   * @param {{store:any, config:any, invoke?:Function, detect?:Function, verifyFn?:Function, now?:Function, onEvent?:Function}} deps
   */
  constructor({ store, config, invoke = invokeProvider, detect = detectBinary, verifyFn = verify, now = Date.now, onEvent } = {}) {
    this.store = store;
    this.config = config;
    this.invoke = invoke;
    this.detect = detect;
    this.verifyFn = verifyFn;
    this.now = now;
    this.onEvent = onEvent;
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
    const result = await this.invoke(adapter, prompt, {
      cwd: project?.path,
      timeoutMs: this.config.providerTimeoutMs,
    });
    const tasks = normalizeTasks(extractJsonArray(result.text), { now: this.now });
    if (tasks.length === 0) {
      await this.#emit(run, 'plan.unparsable', { replyPreview: String(result.text).slice(0, 300) });
      return fallbackPlan(run.goal, { now: this.now });
    }
    return tasks;
  }

  /**
   * @param {{goal:string, project?:any, autonomy?:string, budgetUsd?:number, dryRun?:boolean, provider?:string}} opts
   */
  async run(opts) {
    const autonomy = resolveAutonomy(opts.autonomy ?? this.config.defaultAutonomy);
    const preferred = opts.provider ?? this.config.defaultProvider;
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
      budgetUsd: opts.budgetUsd ?? this.config.maxDailyCostUsd,
      costUsd: 0,
      tasks: [],
      artifacts: [],
      verification: { checks: [], passed: null },
      createdAt: nowIso(),
      finishedAt: null,
    };
    await this.store?.saveRun(run);
    await this.#emit(run, 'run.started', { goal: run.goal, autonomy: run.autonomy, provider: run.provider });

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

    // Execute tasks sequentially: each one may depend on the previous edit.
    let current = { ...planned, status: 'running' };
    await this.store?.saveRun(current);
    const executed = [];
    for (const task of current.tasks) {
      const budget = withinBudget(current.costUsd, 0.05, current.budgetUsd);
      if (!budget.ok) {
        executed.push({ ...task, status: 'skipped', note: 'budget exhausted' });
        await this.#emit(current, 'task.skipped', { taskId: task.id, reason: 'budget exhausted' });
        continue;
      }
      await this.#emit(current, 'task.started', { taskId: task.id, title: task.title, agent: task.agent });
      try {
        const result = await this.invoke(adapter, buildTaskPrompt(task, current, opts.project), {
          cwd: current.projectPath ?? undefined,
          timeoutMs: this.config.providerTimeoutMs,
        });
        current = { ...current, costUsd: current.costUsd + (result.costUsd || 0) };
        executed.push({ ...task, status: 'succeeded', summary: String(result.text).slice(0, 2000) });
        await this.#emit(current, 'task.succeeded', { taskId: task.id });
      } catch (err) {
        executed.push({ ...task, status: 'failed', error: err.message });
        await this.#emit(current, 'task.failed', { taskId: task.id, error: err.message });
        break;
      }
    }
    current = { ...current, tasks: executed };

    // Verification + evidence
    const checks = opts.checks ?? [];
    if (checks.length > 0 && current.projectPath) {
      await this.#emit(current, 'verify.started', { checks });
      const verification = await this.verifyFn(checks, { cwd: current.projectPath });
      current = { ...current, verification };
      await this.#emit(current, 'verify.finished', { passed: verification.passed });
    }
    if (current.projectPath && (await isRepo(current.projectPath))) {
      current = { ...current, artifacts: await changedFiles(current.projectPath) };
    }

    const anyFailed = current.tasks.some((t) => t.status === 'failed');
    const verifyFailed = current.verification.passed === false;
    const finished = {
      ...current,
      status: anyFailed || verifyFailed ? 'failed' : 'succeeded',
      finishedAt: nowIso(),
    };
    await this.store?.saveRun(finished);
    await this.#emit(finished, 'run.finished', { status: finished.status });
    return finished;
  }
}

export { buildReceipt, inferChecks };
