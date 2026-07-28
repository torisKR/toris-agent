## `@toris/core` — orchestration engine

```ts
export interface PlanInput { goal: string; project: Project; config: TorisConfig; gitInfo: GitInfo }
export interface ExecutionPlan { tasks: Task[]; summary: string; estimatedCostUsd: number; risk: RiskLevel }
export function buildPlan(input: PlanInput, adapter: AgentAdapter): Promise<ExecutionPlan>;
export function buildFallbackPlan(input: PlanInput): ExecutionPlan;   // deterministic, no LLM — used by --dry-run and tests

// DAG
export function topoSort(tasks: Task[]): string[][];      // waves of parallel-safe task ids; throws on cycle
export function detectCycle(tasks: Task[]): string[] | null;
export function readyTasks(tasks: Task[]): Task[];
export function serializeConflicts(tasks: Task[]): Task[]; // adds dependsOn edges where ownedPaths overlap

// Plan gate
export interface GateVerdict { allowed: boolean; requiresApproval: boolean; reasons: string[]; risk: RiskLevel }
export function evaluatePlanGate(plan: ExecutionPlan, config: TorisConfig, project: Project): GateVerdict;
export function classifyRisk(task: Task, config: TorisConfig): RiskLevel;

// routing
export function resolveProfile(role: AgentRole, config: TorisConfig, opts?: { implementerProvider?: string }): { provider: string; model: string; profileKey: string };

// budget
export function checkBudget(spent: number, budget: number | undefined, config: TorisConfig): { ok: boolean; reason?: string };

// orchestrator
export interface OrchestratorDeps {
  db: Database; config: TorisConfig; log: EventLog;
  worktrees: WorktreeManager; getAdapter: (provider: string) => AgentAdapter;
  onEvent?: (e: TorisEvent) => void;
  requestApproval?: (a: Approval) => Promise<boolean>;
}
export interface Orchestrator {
  createRun(projectId: string, goal: string, opts?: { autonomy?: AutonomyLevel; budgetUsd?: number; dryRun?: boolean }): Promise<{ run: Run; tasks: Task[] }>;
  execute(runId: string): Promise<Run>;
  cancel(runId: string, reason?: string): Promise<Run>;
  receipt(runId: string): Promise<RunReceipt>;
}
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator;
```
