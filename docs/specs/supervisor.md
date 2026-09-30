## `@toris/supervisor` — historical package contract

The frozen TypeScript signatures below record the earlier package specification.
They do not describe the implemented transport in the current `toris-agent`
repository.

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

### Current local daemon

The terminal commands `toris daemon start|stop|status`, `toris daemon run` and
`toris daemon schedule` use the implementation in `src/daemon/`. Its exported
helpers include `startDaemon`, `stopDaemon`, `readDaemonStatus` and
`enqueueDaemonRun`; there is no socket client behind the CLI.

All daemon state lives under the configured Toris home (`~/.toris` by default):

| Path | Purpose |
| --- | --- |
| `daemon.lock` | Worker ownership and pid |
| `daemon.json` | Status and heartbeat |
| `daemon/inbox/` | JSON job submissions from other local Toris processes |
| `daemon-jobs.json` | Job collection maintained by the worker |
| `daemon/schedules/` | Local schedule records |
| `logs/daemon.log` | Detached worker output |

The worker drains the file inbox and executes `run` jobs through the same
orchestrator as `toris run`. Clients submit jobs to the inbox instead of writing
the worker's job collection. Status comes from the local state and pid checks;
`toris daemon run` exits `5` when the daemon is unavailable.

`daemon schedule list|add|remove|enable|disable` manages local cron schedules.
The running worker evaluates them on its heartbeat in the host timezone and
queues due runs. Run options, including project, autonomy, budget, dry run,
provider, apply and review policy, are retained in queued and scheduled jobs.

Unix socket RPC, the historical `SupervisorClient` event connection,
multi-machine execution and cloud calendars are not implemented.
