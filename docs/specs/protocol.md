## `@toris/protocol` — wire contracts (JSON-RPC 2.0 over unix socket)

```ts
export const PROTOCOL_VERSION = '1';
export type RpcRequest  = { jsonrpc: '2.0'; id: string|number; method: string; params?: unknown };
export type RpcResponse = { jsonrpc: '2.0'; id: string|number; result?: unknown; error?: RpcError };
export type RpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown };
export type RpcError = { code: number; message: string; data?: unknown };
export const RPC_ERRORS: { PARSE:-32700; INVALID_REQUEST:-32600; METHOD_NOT_FOUND:-32601; INVALID_PARAMS:-32602; INTERNAL:-32603; UNAUTHORIZED:-32001; NOT_FOUND:-32004; CONFLICT:-32009 };

// Method map — supervisor implements, cli calls. Params/results are schemas-typed.
export interface TorisMethods {
  'health.check':      { params: {};                          result: { ok: boolean; version: string; uptimeMs: number; pid: number } };
  'project.add':       { params: { path: string; name?: string }; result: { project: Project } };
  'project.list':      { params: {};                          result: { projects: Project[] } };
  'project.remove':    { params: { id: string };              result: { removed: boolean } };
  'project.inspect':   { params: { id: string };              result: { project: Project; runs: Run[] } };
  'run.create':        { params: { projectId: string; goal: string; autonomy?: AutonomyLevel; budgetUsd?: number; dryRun?: boolean }; result: { run: Run; tasks: Task[] } };
  'run.list':          { params: { projectId?: string; status?: RunStatus; limit?: number }; result: { runs: Run[] } };
  'run.get':           { params: { id: string };              result: { run: Run; tasks: Task[] } };
  'run.cancel':        { params: { id: string; reason?: string }; result: { run: Run } };
  'run.receipt':       { params: { id: string };              result: { receipt: RunReceipt } };
  'approval.list':     { params: { runId?: string };          result: { approvals: Approval[] } };
  'approval.decide':   { params: { id: string; approve: boolean; reason?: string }; result: { approval: Approval } };
  'event.tail':        { params: { runId?: string; sinceSeq?: number; limit?: number }; result: { events: TorisEvent[] } };
  'daemon.shutdown':   { params: {};                          result: { ok: boolean } };
}
// Server -> client push notification (method name is binding)
export type EventNotification = { jsonrpc:'2.0'; method:'event'; params: TorisEvent };

// Framing: newline-delimited JSON (NDJSON), one message per line, UTF-8.
export function encodeMessage(msg: unknown): string;          // returns JSON + '\n'
export function createMessageDecoder(): (chunk: Buffer, onMessage: (m: unknown) => void) => void;
```
