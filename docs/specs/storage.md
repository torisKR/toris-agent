## `@toris/storage` — SQLite persistence (better-sqlite3)

```ts
export interface Database { close(): void; raw: unknown; }
export function openDatabase(file?: string): Database;   // default torisHome()/toris.db; runs migrations
export function migrate(db: Database): { applied: string[]; version: number };

export interface Repository<T> {
  create(entity: T): T;
  update(id: string, patch: Partial<T>): T;    // MUST return a NEW object, never mutate input
  findById(id: string): T | null;
  findAll(filter?: Partial<T>): T[];
  delete(id: string): boolean;
}
export function projectRepo(db: Database): Repository<Project> & { findByPath(p: string): Project | null };
export function runRepo(db: Database): Repository<Run>;
export function taskRepo(db: Database): Repository<Task> & { findByRun(runId: string): Task[] };
export function sessionRepo(db: Database): Repository<Session>;
export function approvalRepo(db: Database): Repository<Approval> & { findPending(runId?: string): Approval[] };
export function verificationRepo(db: Database): Repository<Verification> & { findByRun(runId: string): Verification[] };
export function findingRepo(db: Database): Repository<ReviewFinding> & { findByRun(runId: string): ReviewFinding[] };

// append-only event log
export interface EventLog {
  append(e: Omit<TorisEvent,'id'|'seq'|'at'> & Partial<Pick<TorisEvent,'at'>>): TorisEvent;
  tail(opts: { runId?: string; sinceSeq?: number; limit?: number }): TorisEvent[];
}
export function eventLog(db: Database): EventLog;
```
