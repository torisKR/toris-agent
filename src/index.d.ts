/**
 * Public type surface for `toris-agent`.
 *
 * Hand-written to match `src/index.js` — there is no TS build step and no
 * dependency behind these declarations. Keep this file in step with the
 * re-export list in `src/index.js` when that list changes.
 */

// ---------------------------------------------------------------------------
// Errors and exit codes
// ---------------------------------------------------------------------------

/** Exit codes are part of the public CLI contract (docs/specs/cli.md). */
export const EXIT: Readonly<{
  OK: 0;
  FAILURE: 1;
  USAGE: 2;
  VERIFICATION_FAILED: 3;
  APPROVAL_DENIED: 4;
  DAEMON_UNAVAILABLE: 5;
}>;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class TorisError extends Error {
  constructor(message: string, code?: string, exitCode?: number);
  code: string;
  exitCode: number;
}

export class UsageError extends TorisError {
  constructor(message: string);
}

export class VerificationError extends TorisError {
  constructor(message: string, failures?: readonly CheckResult[]);
  failures: readonly CheckResult[];
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentCategory = 'plan' | 'build' | 'review' | 'verify' | 'ship';

export interface AgentProfile {
  id: string;
  category: AgentCategory;
  title: string;
  summary: string;
  /** True when the role is allowed to modify files. */
  writes: boolean;
}

export const AGENT_PROFILES: readonly AgentProfile[];

/** All profiles when `category` is omitted, otherwise those in that category. */
export function listAgents(category?: AgentCategory): readonly AgentProfile[];

/** The profile with this id, or `null` when unknown. */
export function getAgent(id: string): AgentProfile | null;

// ---------------------------------------------------------------------------
// Autonomy
// ---------------------------------------------------------------------------

export type AutonomyLevelName = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface AutonomyPolicy {
  level: AutonomyLevelName;
  /** 1..5; higher permits strictly more. */
  rank: number;
  plans: boolean;
  writes: boolean;
  commits: boolean;
  pushes: boolean;
  pushesDefaultBranch: boolean;
  autoApproves: boolean;
  label: string;
  detail: string;
}

export const AUTONOMY_LEVELS: Readonly<Record<AutonomyLevelName, AutonomyPolicy>>;

/**
 * Look up a policy by name, case-insensitively.
 * @throws ApprovalDeniedError when the level is not L1..L5.
 */
export function resolveAutonomy(level: string): AutonomyPolicy;

export interface GateDecision {
  allowed: boolean;
  /** True when a human approval could unblock the action at this level. */
  needsApproval: boolean;
  reason: string;
}

/** Decide whether `action` is permitted under `autonomy`. */
export function gate(autonomy: string | AutonomyPolicy, action: string): GateDecision;

/**
 * Budget guard. A non-positive or non-numeric `budgetUsd` means "unlimited",
 * reported as `remaining: Infinity`.
 */
export function withinBudget(
  spentUsd: number,
  estimateUsd: number,
  budgetUsd: number,
): { ok: boolean; remaining: number };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  bin: string;
  enabled: boolean;
}

export interface TorisConfig {
  version: number;
  defaultAutonomy: AutonomyLevelName;
  maxParallelAgents: number;
  maxDailyCostUsd: number;
  maxRetriesPerTask: number;
  providerTimeoutMs: number;
  defaultProvider: ProviderName;
  providers: Record<string, ProviderConfig>;
  models: {
    profiles: Record<string, unknown>;
    routing: Record<string, unknown>;
  };
  /** Unknown keys are preserved so a newer config survives an older binary. */
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: Readonly<TorisConfig>;

/** Resolve the toris home dir. Order: explicit arg > `TORIS_HOME` > `~/.toris`. */
export function resolveHome(explicit?: string): string;

/** Deep-merge defaults with stored config. Never mutates either input. */
export function mergeConfig(base: TorisConfig, override: unknown): TorisConfig;

/** @returns the list of problems; empty means valid. */
export function validateConfig(config: unknown): string[];

export function loadConfig(home: string): Promise<TorisConfig>;
export function saveConfig(home: string, config: TorisConfig): Promise<void>;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type ProviderName = 'claude' | 'codex';

export interface ProviderAdapter {
  name: ProviderName;
  bin: string;
  args(prompt: string): string[];
  parse(raw: string): { text: string; costUsd?: number };
}

export const ADAPTERS: Readonly<Record<ProviderName, ProviderAdapter>>;

/** The other provider, so a model never grades its own homework. */
export function oppositeProvider(name: ProviderName): ProviderName;

/**
 * Node's `process.platform` values, spelled out locally so these declarations
 * stay dependency-free (no `@types/node` required to consume them).
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

/** Resolve a binary on PATH without executing it. `null` when not found. */
export function detectBinary(
  bin: string,
  options?: { env?: Record<string, string | undefined>; platform?: Platform },
): string | null;

export interface ProviderResponse {
  text: string;
  costUsd: number;
  raw: string;
}

export function invokeProvider(
  adapter: ProviderAdapter,
  prompt: string,
  options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ProviderResponse>;

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface Task {
  id: string;
  order: number;
  title: string;
  agent: string;
  detail: string;
  /** Proposed proof the harness can actually run. */
  verify: string;
  status: TaskStatus;
  error?: string | null;
}

export interface ProjectContext {
  name: string;
  path: string;
  checks?: readonly string[];
}

export function buildPlanPrompt(goal: string, project?: ProjectContext | null): string;

/** Pull the first JSON array out of model prose or a fenced block. */
export function extractJsonArray(text: string): unknown[] | null;

/** Coerce raw model output into at most 12 well-formed tasks. */
export function normalizeTasks(raw: unknown, options?: { now?: () => number }): Task[];

/** Deterministic single-task plan, used when no provider is available. */
export function fallbackPlan(goal: string, options?: { now?: () => number }): Task[];

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface CheckResult {
  command: string;
  /** 124 on timeout, 127 on spawn failure. */
  exitCode: number;
  passed: boolean;
  durationMs: number;
  /** Tail-truncated to the last 4000 characters. */
  stdout: string;
  stderr: string;
  note?: string;
}

export function runCheck(
  command: string,
  options?: { cwd?: string; timeoutMs?: number },
): Promise<CheckResult>;

/** Runs checks in order, stopping at the first failure. */
export function verify(
  commands: readonly string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<{ checks: CheckResult[]; passed: boolean }>;

/** Derive check commands from a package.json's `scripts`. */
export function inferChecks(packageJson: unknown): string[];

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export type RunStatus = 'succeeded' | 'failed' | 'dry-run' | 'awaiting-approval' | 'unknown';

export interface Receipt {
  schemaVersion: number;
  runId: string;
  goal: string;
  project: string | null;
  status: RunStatus;
  autonomy: AutonomyLevelName;
  provider: ProviderName;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  verdict: string;
  tasks: { total: number; succeeded: number; failed: number; skipped: number };
  taskList: ReadonlyArray<{
    id: string;
    title: string;
    agent: string | null;
    status: string;
    error: string | null;
  }>;
  verification: {
    passed: boolean | null;
    total: number;
    failed: number;
    checks: readonly CheckResult[];
  };
  failures: readonly string[];
  costUsd: number;
  eventCount: number;
  artifacts: readonly string[];
}

export function buildReceipt(run: Run, events?: readonly RunEvent[]): Receipt;
export function receiptToMarkdown(receipt: Receipt): string;

// ---------------------------------------------------------------------------
// Runs and storage
// ---------------------------------------------------------------------------

export interface Run {
  id: string;
  goal: string;
  status: RunStatus;
  autonomy: AutonomyLevelName;
  provider: ProviderName;
  createdAt: string;
  finishedAt?: string | null;
  projectId?: string | null;
  tasks?: Task[];
  verification?: { passed: boolean | null; checks: CheckResult[] };
  costUsd?: number;
  artifacts?: string[];
}

export interface RunEvent {
  type: string;
  at: string;
  [key: string]: unknown;
}

/** JSON-file-backed store rooted at the toris home dir. */
export class Store {
  constructor(home: string);
  readonly home: string;
  init(): Promise<void>;
  readCollection<T = unknown>(name: string): Promise<T[]>;
  writeCollection<T = unknown>(name: string, items: readonly T[]): Promise<void>;
  updateCollection<T = unknown>(name: string, updater: (items: T[]) => T[]): Promise<T[]>;
  saveRun(run: Run): Promise<Run>;
  getRun(runId: string): Promise<Run | null>;
  listRuns(): Promise<Run[]>;
  appendEvent(runId: string, event: RunEvent): Promise<void>;
  readEvents(runId: string): Promise<RunEvent[]>;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function buildTaskPrompt(task: Task, run: Run, project?: ProjectContext | null): string;

export interface OrchestratorOptions {
  store: Store;
  config: TorisConfig;
  /** Injection points for tests; each defaults to the real implementation. */
  invoke?: typeof invokeProvider;
  detect?: typeof detectBinary;
  verifyFn?: typeof verify;
  now?: () => number;
  onEvent?: (event: RunEvent) => void;
}

export interface RunOptions {
  goal: string;
  autonomy?: AutonomyLevelName;
  provider?: ProviderName;
  project?: ProjectContext | null;
  cwd?: string;
  checks?: readonly string[];
  signal?: AbortSignal;
}

export class Orchestrator {
  constructor(options: OrchestratorOptions);
  /** Pick a usable provider, falling back when `preferred` is unavailable. */
  resolveProvider(preferred?: ProviderName): Promise<ProviderAdapter | null>;
  plan(
    run: Run,
    project: ProjectContext | null,
    adapter: ProviderAdapter | null,
    available: boolean,
  ): Promise<Task[]>;
  run(opts: RunOptions): Promise<Run>;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** CLI entry point. Resolves to the process exit code rather than exiting. */
export function main(argv?: readonly string[], deps?: Record<string, unknown>): Promise<number>;
