## `@toris/providers` — agent adapters

```ts
export interface AgentInput {
  role: AgentRole; prompt: string; systemPrompt?: string;
  cwd: string; permissionMode: PermissionMode;
  model: string; timeoutMs?: number; resumeSessionId?: string;
}
export interface AgentChunk { type: 'text'|'tool'|'usage'|'error'|'done'; text?: string; data?: Record<string, unknown> }
export interface AgentResult {
  ok: boolean; text: string; sessionId?: string;
  inputTokens: number; outputTokens: number; costUsd: number;
  error?: string; exitCode?: number;
}
export interface AgentAdapter {
  readonly provider: string;
  isAvailable(): Promise<boolean>;
  version(): Promise<string | null>;
  run(input: AgentInput, onChunk?: (c: AgentChunk) => void): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}
export function claudeAdapter(): AgentAdapter;   // provider: 'anthropic'
export function codexAdapter(): AgentAdapter;    // provider: 'openai-codex'
export function mockAdapter(script?: Partial<AgentResult>): AgentAdapter; // provider: 'mock' — used by tests
export function getAdapter(provider: string): AgentAdapter;
export function oppositeProvider(provider: string): string;
```
