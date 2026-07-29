/**
 * Type declarations for the native process-group layer.
 *
 * This module has two interchangeable backends behind one API:
 *  - the Rust addon (`@toris-agent/native-*`), loaded when a prebuilt binary
 *    for the host triple is installed and `TORIS_DISABLE_NATIVE` is unset;
 *  - a pure-JS fallback built on `node:child_process`.
 *
 * Both backends satisfy `SpawnResult` identically, so callers never branch on
 * which one is active. Prefer `spawnCaptured`; `spawnCapturedJs` is exported
 * only so tests can pin the fallback path.
 */

/**
 * Triples the prebuilt addon is published for. `platformTriple()` is not
 * limited to these — it derives a name for any host — so it returns the wider
 * `PlatformTriple` below. These are the values a prebuild actually exists for.
 */
export type KnownPlatformTriple =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64-gnu'
  | 'linux-arm64-gnu'
  | 'linux-x64-musl'
  | 'linux-arm64-musl'
  | 'win32-x64-msvc';

/**
 * Any host triple. Modelled as the known set widened with `string`, so editors
 * still autocomplete the published triples without rejecting hosts that have
 * no prebuild (e.g. `freebsd-x64`).
 */
export type PlatformTriple = KnownPlatformTriple | (string & {});

export interface SpawnOptions {
  /** Working directory for the child. Defaults to the current process cwd. */
  cwd?: string;
  /**
   * Extra environment variables merged over the parent environment.
   * A key set to `undefined` is ignored rather than unset.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Wall-clock budget in milliseconds. On expiry the whole process group is
   * signalled, not just the direct child, so orphaned grandchildren cannot
   * outlive the run. Defaults to 120_000.
   */
  timeoutMs?: number;
  /**
   * Cap on captured bytes per stream. Output beyond the cap is dropped from
   * the middle and `truncated` is set. Defaults to 1_048_576 (1 MiB).
   */
  maxOutputBytes?: number;
}

export interface SpawnResult {
  /**
   * Process exit code, or `null` when the child was terminated by a signal
   * before producing one.
   */
  exitCode: number | null;
  /** Captured stdout, decoded as UTF-8 with invalid sequences replaced. */
  stdout: string;
  /** Captured stderr, decoded as UTF-8 with invalid sequences replaced. */
  stderr: string;
  /** True when the timeout elapsed and the process group was signalled. */
  timedOut: boolean;
  /** True when either stream exceeded `maxOutputBytes` and was clipped. */
  truncated: boolean;
}

/**
 * The host's platform triple, e.g. `"darwin-arm64"`. Always returns a string:
 * a host with no prebuild still gets a derived name, and the loader simply
 * falls back to JS. Linux triples always carry a `-gnu` or `-musl` suffix
 * because the two are not interchangeable.
 */
export function platformTriple(): PlatformTriple;

/** True when the Rust addon loaded and is serving `spawnCaptured`. */
export function isNativeActive(): boolean;

/**
 * Human-readable backend description for `toris doctor` and `toris version`,
 * e.g. `"toris-native 0.1.0 (macos)"` when native, or
 * `"javascript fallback (darwin-arm64)"` otherwise.
 */
export function backendInfo(): string;

/**
 * Run `command` through the platform shell, capturing both streams.
 *
 * Dispatches to the native addon when active and to `spawnCapturedJs`
 * otherwise. Rejects only on spawn failure; a non-zero exit is reported
 * through `SpawnResult.exitCode`, and a timeout through `timedOut`.
 */
export function spawnCaptured(command: string, options?: SpawnOptions): Promise<SpawnResult>;

/**
 * The pure-JS backend, exported so tests can exercise the fallback path even
 * on a host where the native addon is installed.
 */
export function spawnCapturedJs(command: string, options?: SpawnOptions): Promise<SpawnResult>;
