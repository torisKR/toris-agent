## `@toris/schemas` — owns all domain types (Zod + inferred TS)

Exports (names are binding):

```ts
// --- primitives
export function newId(prefix: 'run'|'task'|'prj'|'sess'|'apr'|'evt'): string;
export function torisHome(): string;
export const ISO: z.ZodString; // ISO-8601 UTC string, e.g. "2026-07-29T12:00:00.000Z"

// --- enums (z.enum + exported TS union)
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type AutonomyLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export type PermissionMode = 'read-only' | 'workspace-write' | 'isolated-full' | 'danger-full-access';
export type RunStatus = 'pending'|'planning'|'awaiting_approval'|'running'|'verifying'|'integrating'|'completed'|'failed'|'cancelled';
export type TaskStatus = 'pending'|'blocked'|'ready'|'running'|'review'|'verifying'|'completed'|'failed'|'cancelled'|'skipped';
export type AgentRole = 'orchestrator'|'architect'|'implementer'|'reviewer'|'verifier'|'arbiter';
export type ApprovalStatus = 'pending'|'approved'|'rejected'|'expired';

// --- entities (Zod schema + inferred type, both exported)
export const ProjectSchema; export type Project = {
  id: string; name: string; path: string; defaultBranch: string;
  buildCommand?: string; testCommand?: string; lintCommand?: string; typecheckCommand?: string;
  protectedPaths: string[]; createdAt: string; updatedAt: string;
};
export const RunSchema; export type Run = {
  id: string; projectId: string; goal: string; status: RunStatus;
  autonomy: AutonomyLevel; risk: RiskLevel;
  baseCommit?: string; branch?: string;
  costUsd: number; budgetUsd?: number;
  startedAt?: string; finishedAt?: string; createdAt: string; updatedAt: string;
  error?: string;
};
export const TaskSchema; export type Task = {
  id: string; runId: string; title: string; description: string;
  role: AgentRole; agentProfile?: string; status: TaskStatus;
  dependsOn: string[]; ownedPaths: string[];
  permissionMode: PermissionMode;
  acceptanceCriteria: string[]; verifyCommands: string[];
  worktreePath?: string; branch?: string; commitSha?: string;
  attempt: number; maxAttempts: number;
  costUsd: number; error?: string;
  createdAt: string; updatedAt: string;
};
export const SessionSchema; export type Session = {
  id: string; runId: string; taskId?: string; provider: string; model: string;
  role: AgentRole; status: 'active'|'closed'|'failed'; externalSessionId?: string;
  inputTokens: number; outputTokens: number; costUsd: number;
  startedAt: string; endedAt?: string;
};
export const ApprovalSchema; export type Approval = {
  id: string; runId: string; taskId?: string; kind: string; summary: string;
  detail?: string; risk: RiskLevel; status: ApprovalStatus;
  requestedAt: string; decidedAt?: string; decidedBy?: string; reason?: string;
  expiresAt?: string;
};
export const EventSchema; export type TorisEvent = {
  id: string; seq?: number; runId?: string; taskId?: string; sessionId?: string;
  type: string; level: 'debug'|'info'|'warn'|'error';
  message: string; data?: Record<string, unknown>; at: string;
};
export const VerificationSchema; export type Verification = {
  id: string; runId: string; taskId?: string; command: string;
  exitCode: number; durationMs: number; passed: boolean;
  stdoutTail: string; stderrTail: string; at: string;
};
export const ReviewFindingSchema; export type ReviewFinding = {
  id: string; runId: string; taskId: string; reviewer: string;
  severity: 'critical'|'high'|'medium'|'low'; category: string;
  file?: string; line?: number; summary: string; recommendation: string;
  resolved: boolean;
};
export const RunReceiptSchema; export type RunReceipt = {
  runId: string; projectId: string; goal: string; status: RunStatus;
  startedAt: string; finishedAt: string; durationMs: number;
  tasks: Array<{ id: string; title: string; status: TaskStatus; role: AgentRole; commitSha?: string }>;
  verifications: Verification[]; findings: ReviewFinding[];
  approvals: Approval[]; costUsd: number;
  commits: string[]; filesChanged: string[]; baseCommit?: string;
  models: Array<{ provider: string; model: string; role: AgentRole; costUsd: number }>;
};

// --- config
export const ConfigSchema; export type TorisConfig = {
  version: 1;
  models: { profiles: Record<string, { provider: string; model: string; reasoning?: string }> };
  routing: Record<AgentRole, string>;         // role -> profile key ('opposite-provider' allowed for reviewer)
  policy: {
    autonomy: AutonomyLevel;
    maxParallelAgents: number;
    maxRunCostUsd: number;
    maxDailyCostUsd: number;
    requireApprovalFor: string[];             // e.g. ['push','merge','deploy','dependency','migration']
    protectedPaths: string[];
    networkAccess: boolean;
  };
  telemetry: { enabled: boolean };
};
export const DEFAULT_CONFIG: TorisConfig;
export function parseConfig(raw: unknown): TorisConfig;   // throws ZodError
```
