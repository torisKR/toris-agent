//! Native process control for toris.
//!
//! The reason this crate exists: Node's `child_process.exec(cmd, { timeout })`
//! signals only the *direct* child. For any compound command the direct child is
//! the shell, so the real work becomes a grandchild that survives the timeout and
//! is reparented to init. An autonomous agent that runs `npm test` on a budget
//! accumulates orphaned builds that burn CPU and hold file locks.
//!
//! `spawn_captured` puts the child in its own process group (`setsid` on unix,
//! `CREATE_NEW_PROCESS_GROUP` on Windows) and, on timeout, signals the entire
//! group. That also unblocks output capture: grandchildren inherit the stdout
//! pipe, so a reader waiting on EOF hangs until every one of them is gone.

mod capture;
mod process;

use napi::bindgen_prelude::{AsyncTask, Error, Result, Status};
use napi::{Env, Task};
use napi_derive::napi;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use capture::Capture;
use process::{configure_group, kill_group, shell};

/// How long to wait for reader threads after the child has exited.
const DRAIN_GRACE_MS: u64 = 250;

/// How long to wait for a killed group to be reaped before giving up on
/// recovering a real exit code.
const REAP_GRACE_MS: u64 = 500;

/// Reported when the process was terminated by a signal and so has no exit code
/// of its own. Matches the JS fallback, which sees `null` and normalises it the
/// same way.
const SIGNAL_EXIT_CODE: i32 = -1;

const DEFAULT_TIMEOUT_MS: u32 = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES: u32 = 10 * 1024 * 1024;

#[napi(object)]
pub struct SpawnOptions {
    pub cwd: Option<String>,
    pub timeout_ms: Option<u32>,
    pub max_output_bytes: Option<u32>,
}

#[napi(object)]
pub struct SpawnResult {
    /// Exit code, or -1 when the process was terminated by a signal.
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    /// True when the deadline elapsed and the group was signalled.
    pub timed_out: bool,
    /// True when output was clipped at `max_output_bytes`.
    pub truncated: bool,
}

/// Decode captured bytes without a needless copy.
///
/// `String::from_utf8_lossy` borrows when the input is valid and then
/// `into_owned` copies it wholesale — a full extra pass over megabytes of build
/// log in the overwhelmingly common case. `String::from_utf8` reuses the
/// existing allocation instead, so only genuinely invalid output pays.
fn into_string(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(err) => String::from_utf8_lossy(err.as_bytes()).into_owned(),
    }
}

pub struct SpawnTask {
    command: String,
    cwd: Option<String>,
    timeout_ms: u64,
    max_output: usize,
}

impl SpawnTask {
    fn build_command(&self) -> Command {
        let (bin, flag) = shell();
        let mut cmd = Command::new(bin);
        cmd.arg(flag)
            .arg(&self.command)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = &self.cwd {
            cmd.current_dir(dir);
        }
        configure_group(&mut cmd);
        cmd
    }

    /// Block until the child exits, killing its whole group if the deadline
    /// passes first.
    ///
    /// The wait runs on a helper thread so this one can block on a channel with
    /// a timeout. The obvious alternative — a `try_wait()` poll loop — charges
    /// every call up to a full poll interval of latency, which for the short
    /// commands an agent loop issues by the thousand cost more than the commands
    /// themselves.
    ///
    /// Returns `(exit_code, timed_out)`.
    fn await_exit(&self, child: Child, pid: u32) -> Result<(i32, bool)> {
        let (tx, rx) = mpsc::channel();
        // Detached deliberately: after a timeout the waiter may still be inside
        // `wait()`, and joining it would reintroduce the hang we just removed.
        // It owns the `Child` and returns on its own once the kill lands.
        thread::spawn(move || {
            let mut child = child;
            let _ = tx.send(child.wait().map(|s| s.code().unwrap_or(SIGNAL_EXIT_CODE)));
        });

        match rx.recv_timeout(Duration::from_millis(self.timeout_ms)) {
            Ok(Ok(code)) => Ok((code, false)),
            Ok(Err(e)) => Err(Error::new(
                Status::GenericFailure,
                format!("wait failed: {e}"),
            )),
            Err(RecvTimeoutError::Timeout) => {
                // Kill the group *before* collecting output: grandchildren hold
                // the write end of the pipe and the readers will not see EOF
                // until every one of them is gone.
                kill_group(pid);
                let code = match rx.recv_timeout(Duration::from_millis(REAP_GRACE_MS)) {
                    Ok(Ok(code)) => code,
                    _ => SIGNAL_EXIT_CODE,
                };
                Ok((code, true))
            }
            // The waiter cannot drop the sender without sending, but a panic
            // there must not take the whole call down with it.
            Err(RecvTimeoutError::Disconnected) => Ok((SIGNAL_EXIT_CODE, false)),
        }
    }
}

impl Task for SpawnTask {
    type Output = SpawnResult;
    type JsValue = SpawnResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut child = self
            .build_command()
            .spawn()
            .map_err(|e| Error::new(Status::GenericFailure, format!("spawn failed: {e}")))?;
        let pid = child.id();

        let missing = |name: &str| {
            Error::new(
                Status::GenericFailure,
                format!("{name} pipe missing after spawn"),
            )
        };
        let stdout = child.stdout.take().ok_or_else(|| missing("stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| missing("stderr"))?;

        let out = Capture::spawn(stdout, self.max_output);
        let err = Capture::spawn(stderr, self.max_output);

        let (exit_code, timed_out) = self.await_exit(child, pid)?;

        let grace = Duration::from_millis(DRAIN_GRACE_MS);
        let out = out.collect(grace);
        let err = err.collect(grace);

        Ok(SpawnResult {
            exit_code,
            timed_out,
            truncated: out.truncated || err.truncated,
            stdout: into_string(out.bytes),
            stderr: into_string(err.bytes),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Run `command` through the platform shell in its own process group.
///
/// On timeout the entire group is signalled, so no grandchild survives.
#[napi]
pub fn spawn_captured(command: String, options: Option<SpawnOptions>) -> AsyncTask<SpawnTask> {
    let opts = options.unwrap_or(SpawnOptions {
        cwd: None,
        timeout_ms: None,
        max_output_bytes: None,
    });
    AsyncTask::new(SpawnTask {
        command,
        cwd: opts.cwd,
        timeout_ms: opts.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS) as u64,
        max_output: opts.max_output_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES) as usize,
    })
}

/// Probe used by the JS loader to confirm the binding is live.
#[napi]
pub fn native_info() -> String {
    format!(
        "toris-native {} ({})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_utf8_decodes_intact() {
        assert_eq!(into_string("hello ☃".as_bytes().to_vec()), "hello ☃");
    }

    #[test]
    fn invalid_utf8_is_replaced_not_dropped() {
        let decoded = into_string(vec![b'a', 0xff, b'b']);
        assert!(decoded.starts_with('a'));
        assert!(decoded.ends_with('b'));
        assert!(decoded.contains('\u{fffd}'));
    }

    #[test]
    fn empty_input_decodes_to_empty() {
        assert_eq!(into_string(Vec::new()), "");
    }
}

#[cfg(test)]
mod timing {
    use super::*;
    use std::time::Instant;

    /// Times `compute()` directly, bypassing N-API and the libuv threadpool.
    ///
    /// Not a correctness test — it exists to attribute the gap between this
    /// crate and the JS fallback. If Rust-side spawn is already as fast as
    /// Node's, the remaining cost is the binding hop and no amount of tuning
    /// here will recover it.
    ///
    ///   cargo test --release -- --ignored --nocapture bare_spawn_cost
    #[test]
    #[ignore]
    fn bare_spawn_cost() {
        let mut best = f64::MAX;
        for _ in 0..60 {
            let mut task = SpawnTask {
                command: "exit 0".to_owned(),
                cwd: None,
                timeout_ms: 10_000,
                max_output: 1 << 20,
            };
            let started = Instant::now();
            task.compute().expect("spawn");
            best = best.min(started.elapsed().as_secs_f64() * 1000.0);
        }
        println!("bare compute() min: {best:.2} ms");
    }
}
