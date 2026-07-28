## `@toris/verifier` — deterministic verification

```ts
export interface CommandResult { command: string; exitCode: number; durationMs: number; stdout: string; stderr: string; timedOut: boolean }
export function runCommand(cmd: string, opts: { cwd: string; timeoutMs?: number; env?: Record<string,string> }): Promise<CommandResult>;

export interface VerifyOutcome { passed: boolean; results: Verification[] }
export function verify(opts: { runId: string; taskId?: string; cwd: string; commands: string[]; timeoutMs?: number }): Promise<VerifyOutcome>;

// secret scanning — blocks completion when secrets appear in a diff
export interface SecretHit { rule: string; file: string; line: number; preview: string }
export function scanSecrets(diff: string): SecretHit[];
export function redact(text: string): string;    // used by ALL log paths
```
