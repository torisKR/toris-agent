## `@toris/supervisor` — daemon

```ts
export interface Supervisor { start(): Promise<{ socket: string; pid: number }>; stop(): Promise<void>; }
export function createSupervisor(opts?: { socket?: string; home?: string }): Supervisor;
export interface SupervisorClient {
  call<M extends keyof TorisMethods>(method: M, params: TorisMethods[M]['params']): Promise<TorisMethods[M]['result']>;
  onEvent(cb: (e: TorisEvent) => void): () => void;
  close(): void;
}
export function connect(opts?: { socket?: string; autoStart?: boolean }): Promise<SupervisorClient>;
export function isDaemonRunning(home?: string): Promise<boolean>;
export function socketPath(home?: string): string;
```
