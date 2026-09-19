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

export class BudgetExceededError extends TorisError {
  constructor(message: string, extras?: { runId?: string | null });
  runId: string | null;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentCategory = 'core' | 'plan' | 'build' | 'review' | 'verify' | 'ship';

export interface AgentProfile {
  id: string;
  category: AgentCategory;
  title: string;
  summary: string;
  /** True when the role is allowed to modify files. */
  writes: boolean;
  /** Optional specialist system prompt from a project/home overlay file. */
  system?: string;
  /** Where this profile was loaded from when overlays are merged. */
  source?: 'builtin' | 'home' | 'project';
}

/** Live catalogue after merging builtins with optional home/project overlays. */
export interface AgentCatalogue {
  readonly surface: AgentProfile;
  readonly profiles: readonly AgentProfile[];
}

export const AGENT_PROFILES: readonly AgentProfile[];
export const SURFACE_AGENT: AgentProfile;
export const BUILTIN_CATALOGUE: AgentCatalogue;

/** Orchestrator task roles when `category` is omitted, otherwise those in that category. */
export function listAgents(
  category?: Exclude<AgentCategory, 'core'>,
  catalogue?: AgentCatalogue,
): readonly AgentProfile[];

/** TUI/GUI picker: the chat persona first, then every task role. */
export function listSurfaceAgents(category?: AgentCategory, catalogue?: AgentCatalogue): readonly AgentProfile[];

/** The profile with this id, or `null` when unknown. */
export function getAgent(id: string, catalogue?: AgentCatalogue): AgentProfile | null;

/** Blank resolves to the default chat persona; unknown ids throw. */
export function resolveSurfaceAgent(id?: string | null, catalogue?: AgentCatalogue): AgentProfile;

/** Overlay search paths, lowest precedence first: `~/.toris/agents`, `<repo>/.toris/agents`. */
export function agentSearchPaths(roots?: { home?: string; projectPath?: string }): string[];

/** Strict parse of one on-disk profile object. Throws TorisError on invalid shape. */
export function parseAgentProfile(
  raw: unknown,
  meta?: { file?: string; source?: 'home' | 'project'; stem?: string },
): AgentProfile;

/** Merge overlays onto the built-in catalogue. Same id replaces the built-in. */
export function composeAgentCatalogue(overlays?: readonly AgentProfile[]): AgentCatalogue;

/** Load `<repo>/.toris/agents/*.json` and `~/.toris/agents/*.json` into the live catalogue. */
export function loadAgentCatalogue(roots?: { home?: string; projectPath?: string }): Promise<AgentCatalogue>;

export function studioAgentUrl(port?: number): string;
export function studioDesignUrl(port?: number): string;
export function studioPatchesUrl(port?: number): string;
export function studioKnowledgeUrl(port?: number): string;
export function studioDaemonUrl(port?: number): string;
export function studioBriefUrl(port?: number): string;
export function studioAndroidUrl(port?: number): string;
export function renderStudioAccess(info?: { running?: boolean; port?: number }): string;
export function tuiAgentHint(agentId?: string): string;
export function isLoopbackHttpUrl(value: unknown): boolean;
export function openLocalCommand(platform?: string): { command: string; args: string[] };
export function openLocalUrl(
  url: string,
  deps?: {
    opener?: (url: string) => unknown;
    spawn?: (...args: unknown[]) => unknown;
    platform?: string;
  },
): Promise<{ ok: boolean; error?: string }>;

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

/**
 * Cross-run / daily budget guard. A missing or non-positive cap is unlimited.
 * Reaching a positive cap (`spent >= cap`) refuses more work.
 */
export function checkBudget(
  spent: number,
  budget: number | undefined,
  config: Pick<TorisConfig, 'maxDailyCostUsd'> | TorisConfig,
): { ok: boolean; reason?: string };

export function dayKey(when?: Date | string | number): string;
export function formatUsd(value: number, digits?: number): string;
export function recordRunCost(home: string, run: Pick<Run, 'id' | 'costUsd' | 'goal' | 'status' | 'createdAt' | 'finishedAt'>): Promise<unknown>;
export function loadCostLedger(home: string): Promise<{ version: number; days: Record<string, unknown> }>;
export function summarizeCost(options: {
  home?: string;
  store?: Store;
  config?: Pick<TorisConfig, 'maxDailyCostUsd'>;
  now?: number | Date | (() => number);
  limitDays?: number;
  limitRuns?: number;
}): Promise<{
  timezone: 'local';
  today: {
    day: string;
    spentUsd: number;
    capUsd: number | null;
    remainingUsd: number | null;
    runCount: number;
    entries: ReadonlyArray<{ runId: string; costUsd: number; goal: string; status: string; at: string }>;
  };
  days: ReadonlyArray<{ day: string; spentUsd: number; capUsd: number | null; remainingUsd: number | null; runCount: number }>;
  runs: ReadonlyArray<{ id: string; runId: string; costUsd: number; status: string; goal: string; at: string | null }>;
}>;
export function budgetHeadroom(input: {
  spentUsd?: number;
  dailySpentUsd?: number;
  budgetUsd?: number;
  maxDailyCostUsd?: number;
}): { runRemaining: number; dailyRemaining: number; remaining: number };

export type BriefPeriod = 'today';
export type BriefVerify = 'pass' | 'fail' | null;

export interface BriefDigest {
  period: BriefPeriod;
  day: string;
  timezone: 'local';
  generatedAt: string;
  spend: {
    day: string;
    spentUsd: number;
    capUsd: number | null;
    remainingUsd: number | null;
    runCount: number;
  };
  runs: ReadonlyArray<{
    id: string;
    goal: string;
    status: string;
    verify: BriefVerify;
    at: string | null;
  }>;
  daemon: {
    running: boolean;
    pid: number | null;
    nextDueAt: string | null;
    nextId: string | null;
    scheduleCount: number;
    schedulesEnabled: number;
  };
  knowledge: {
    available: boolean;
    headlines: ReadonlyArray<{
      kind: string;
      id: string;
      domain: string | null;
      title: string;
      score: number | null;
    }>;
  };
}

/** Read-only local digest. Reuses cost, runs, daemon status, and knowledge index. */
export function buildBrief(options: {
  home?: string;
  store?: Store;
  config?: Pick<TorisConfig, 'maxDailyCostUsd'>;
  cwd?: string;
  period?: string;
  now?: number | Date | (() => number);
  limitRuns?: number;
  limitKnowledge?: number;
}): Promise<BriefDigest>;

export function looksLikeBriefGoal(goal: unknown): boolean;
export function resolveBriefPeriod(period?: string | null): BriefPeriod;
export function verifyOutcome(run: { verification?: { passed?: boolean | null } } | null | undefined): BriefVerify;

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
  /** Chat auto-retrieves local domain nodes + tacit. Default true. */
  knowledge?: { autoRetrieve?: boolean };
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

export interface AndroidDevice {
  serial: string;
  state: string;
  [key: string]: string;
}

export interface AndroidTools {
  adb: string | null;
  emulator: string | null;
  ready: boolean;
}

export interface DoctorCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

/** Resolve adb/emulator on PATH without executing them. */
export function inspectAndroidTools(options?: {
  detect?: typeof detectBinary;
  env?: Record<string, string | undefined>;
}): AndroidTools;

export function androidDoctorChecks(options?: {
  detect?: typeof detectBinary;
  env?: Record<string, string | undefined>;
}): DoctorCheck[];

export function parseAdbDevices(stdout: string): AndroidDevice[];

export function runAndroidAction(
  action: 'status' | 'devices' | 'screenshot' | 'logcat' | 'install',
  options?: Record<string, unknown>,
): Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Knowledge (local secretary store)
// ---------------------------------------------------------------------------

export type KnowledgeEdgeKind = 'prerequisite' | 'supports' | 'conflicts' | 'derived-from';

export const EDGE_KINDS: readonly KnowledgeEdgeKind[];
export const STARTER_DOMAIN_SLUGS: readonly string[];
export const KNOWLEDGE_PACK_SLUGS: readonly string[];
export const USER_MD_LIMIT: number;
export const MEMORY_MD_LIMIT: number;

export function listKnowledgePacks(store: KnowledgeStore): Promise<{
  packs: Array<Record<string, unknown>>;
  root: string;
}>;
export function installKnowledgePack(
  store: KnowledgeStore,
  slug: string,
  options?: { force?: boolean },
): Promise<Record<string, unknown>>;

export interface KnowledgeEdge {
  from: string;
  to: string;
  kind: KnowledgeEdgeKind;
}

export interface KnowledgeSearchHit {
  kind: string;
  domain: string | null;
  id: string;
  title: string;
  tags: string[];
  path: string;
  source?: string;
  excerpt?: string;
  score: number;
}

export interface KnowledgeStatus {
  ok: boolean;
  root: string;
  projectRoot: string | null;
  domains: number;
  domainSlugs: string[];
  inbox: number;
  userBytes: number;
  memoryBytes: number;
  userLimit: number;
  memoryLimit: number;
}

export class KnowledgeStore {
  constructor(options: { home: string; projectPath?: string | null; now?: () => Date });
  readonly home: string;
  readonly root: string;
  init(options?: { seed?: boolean }): Promise<KnowledgeStatus>;
  status(): Promise<KnowledgeStatus>;
  search?(query: string): Promise<KnowledgeSearchHit[]>;
  listDomains(): Promise<Array<Record<string, unknown>>>;
  addDomain(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  inspectDomain(slug: string, source?: string): Promise<Record<string, unknown>>;
  addNode(slug: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  removeNode(slug: string, id: string, source?: string): Promise<Record<string, unknown>>;
  getNode(slug: string, id: string, source?: string): Promise<Record<string, unknown>>;
  listNodes(slug: string, source?: string): Promise<Array<Record<string, unknown>>>;
  link(slug: string, input: { from: string; to: string; kind?: string; source?: string }): Promise<Record<string, unknown>>;
  addTacit(slug: string | null, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  promoteTacit(id: string, input: { domain: string; source?: string }): Promise<Record<string, unknown>>;
  rebuildIndex(): Promise<{ version: number; updatedAt: string; entries: unknown[] }>;
  loadIndex(): Promise<{ version: number; updatedAt: string; entries: unknown[] }>;
}

export function searchIndex(
  index: { entries?: readonly unknown[] } | readonly unknown[],
  query: string,
  options?: { limit?: number; kind?: string; domain?: string },
): KnowledgeSearchHit[];

export function detectCycles(edges: readonly KnowledgeEdge[]): string[][];
export function addDagEdge(
  edges: readonly KnowledgeEdge[],
  input: { from: string; to: string; kind?: string },
): readonly KnowledgeEdge[];
export function proposeReflections(input?: Record<string, unknown>): {
  notable: boolean;
  reason: string;
  proposals: Array<Record<string, unknown>>;
  source?: Record<string, unknown>;
};
export function proposeReflectionsFromReceipt(
  receipt: Record<string, unknown>,
  options?: { domain?: string; domains?: Array<Record<string, unknown>> },
): {
  notable: boolean;
  reason: string;
  proposals: Array<Record<string, unknown>>;
  source?: Record<string, unknown>;
};
export function proposeFromRun(
  store: { getRun?(id: string): Promise<unknown>; listRuns?(): Promise<unknown[]> } | null,
  options?: { runId?: string; domain?: string; domains?: Array<Record<string, unknown>> },
): Promise<{
  notable: boolean;
  reason: string;
  proposals: Array<Record<string, unknown>>;
  source?: Record<string, unknown>;
}>;
export function looksLikeRunId(value?: string): boolean;
export function isVerifiedSuccess(receiptOrRun?: { verification?: { passed?: boolean | null } }): boolean;
export function acceptReflections(
  store: KnowledgeStore,
  result: { proposals?: Array<Record<string, unknown>> },
): Promise<Array<Record<string, unknown>>>;
export function knowledgeDoctorCheck(options?: { home?: string; projectPath?: string }): Promise<DoctorCheck>;
export function createKnowledgeTools(options?: {
  home?: string;
  projectPath?: string;
  session?: { activeDomains?: string[] };
}): Array<Record<string, unknown>>;

export interface KnowledgeRetrievalHit {
  kind: string;
  domain: string | null;
  id: string;
  title: string;
  score: number;
}

export interface KnowledgeRetrieval {
  enabled: boolean;
  query: string;
  briefing: string;
  retrieved: KnowledgeRetrievalHit[];
  domains: string[];
  chars: number;
  truncated: boolean;
}

/** Read-only keyword/tag recall of domain nodes + tacit for one chat turn. */
export function retrieveForTurn(
  store: KnowledgeStore,
  options?: {
    query?: string;
    history?: Array<{ role: string; content?: string }>;
    session?: { activeDomains?: string[] };
    includeProfile?: boolean;
    enabled?: boolean;
    budget?: { maxChars?: number; maxNodes?: number; maxTacit?: number };
  },
): Promise<KnowledgeRetrieval>;

export function knowledgeAutoRetrieveEnabled(
  config?: { knowledge?: { autoRetrieve?: boolean } },
  flags?: Record<string, unknown>,
): boolean;

export function composeKnowledgeTurn(message: string, briefing: string): string;

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
// Second-pass review
// ---------------------------------------------------------------------------

export type ReviewVerdict = 'pass' | 'fail';
export type ReviewFindingSeverity = 'blocker' | 'warning' | 'note';

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  title: string;
  detail: string;
}

export interface ReviewResult {
  provider: string | null;
  passed: boolean | null;
  skipped: boolean;
  unparsable?: boolean;
  verdict?: ReviewVerdict;
  reason?: string;
  summary: string;
  findings: readonly ReviewFinding[];
}

export function buildReviewPrompt(input: {
  goal: string;
  implementer: string;
  reviewer: string;
  files?: readonly string[];
  patch?: string;
  summaries?: readonly string[];
}): string;

export function parseReview(text: string, options?: { provider?: string }): ReviewResult;

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
  budgetUsd?: number | null;
  budgetNote?: string | null;
  dailyCostUsd?: number | null;
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
  budgetUsd?: number;
  budgetNote?: string | null;
  budgetBlocked?: boolean;
  dailyCostUsd?: number;
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
  budgetUsd?: number;
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
// Local daemon (pid/lock under $TORIS_HOME; no remote, no cloud)
// ---------------------------------------------------------------------------

export interface DaemonJobCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
}

export interface DaemonRecentJob {
  id: string;
  type: string;
  status: string;
  goal: string | null;
  runId: string | null;
  scheduleId: string | null;
  dryRun?: boolean;
  error?: string | null;
  createdAt?: string | null;
  updatedAt: string | null;
}

export interface DaemonScheduleSummary {
  count: number;
  enabled: number;
  nextDueAt: string | null;
  nextId: string | null;
  overdue?: boolean;
}

export interface DaemonSchedule {
  id: string;
  expr: string;
  goal: string;
  enabled: boolean;
  autonomy: string | null;
  budgetUsd: number | null;
  dryRun: boolean;
  apply: boolean;
  review: boolean;
  provider: string | null;
  cwd: string | null;
  project: { id: string; name: string; path: string; checks?: string[] } | null;
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  nextDueAt: string | null;
}

export interface DaemonStatus {
  running: boolean;
  supported: true;
  pid: number | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  uptimeMs: number;
  home: string;
  version: string;
  socket: null;
  jobs: DaemonJobCounts;
  recentJobs: DaemonRecentJob[];
  schedules: DaemonScheduleSummary;
}

export function daemonPaths(home: string): {
  home: string;
  lock: string;
  state: string;
  inbox: string;
  schedules: string;
  jobs: string;
  log: string;
};

export function parseScheduleExpr(input: string): { kind: 'cron' | 'every'; source: string; everyMs?: number };
export function addSchedule(home: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<DaemonSchedule>;
export function listSchedules(home: string): Promise<DaemonSchedule[]>;
export function listRecentDaemonJobs(home: string, options?: { limit?: number; store?: unknown }): Promise<DaemonRecentJob[]>;
export function tickSchedules(home: string, queue: unknown, options?: Record<string, unknown>): Promise<Array<{ scheduleId: string; jobId: string }>>;

export function isPidAlive(pid: number, killer?: (pid: number, signal?: number | string) => boolean): boolean;
export function isDaemonRunning(home: string): Promise<boolean>;
export function readDaemonStatus(home: string, now?: number | (() => number)): Promise<DaemonStatus>;
export function startDaemon(home: string, options?: Record<string, unknown>): Promise<DaemonStatus | void>;
export function stopDaemon(home: string, options?: Record<string, unknown>): Promise<DaemonStatus & { stopped: boolean; reason?: string }>;
export function submitDaemonJob(home: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** CLI entry point. Resolves to the process exit code rather than exiting. */
export function main(argv?: readonly string[], deps?: Record<string, unknown>): Promise<number>;

export const DESIGN_STYLE_KEYS: readonly string[];

export interface DesignCapture {
  url: string;
  selector: string;
  outerHTML: string;
  computedStyle: Record<string, string>;
  text: string;
  tagName: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  screenshotDataUrl: string | null;
  screenshotPath?: string | null;
  note?: string;
  id?: string;
}

export function assertSafeHttpUrl(value: string, label?: string): URL;
export function buildCssPath(node: {
  nodeType: number;
  tagName?: string;
  id?: string;
  parentElement?: unknown;
  children?: unknown[];
}): string;
export function normalizeDesignCapture(input?: Record<string, unknown>): DesignCapture;
export function formatDesignContext(
  capture: DesignCapture | Record<string, unknown>,
  options?: { index?: number; total?: number },
): string;
export function listDesignCaptures(
  capture?: DesignCapture | DesignCapture[] | null,
): DesignCapture[];
export function composeDesignTurnMessage(
  message: string,
  capture?: DesignCapture | DesignCapture[] | null,
): string;
export function buildBookmarklet(origin: string): string;
export function injectPickerMarkup(
  html: string,
  options?: { pickerSrc?: string; baseHref?: string },
): string;
