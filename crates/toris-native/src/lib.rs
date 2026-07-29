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

use napi::bindgen_prelude::{AsyncTask, Error, Result, Status};
use napi::{Env, Task};
use napi_derive::napi;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Poll interval while waiting for the child. Small enough that a timeout is
/// honoured promptly, large enough not to spin a core.
const POLL_INTERVAL_MS: u64 = 10;

/// How long to wait for reader threads after the group has been signalled.
const DRAIN_GRACE_MS: u64 = 250;

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

/// Read a pipe into a byte buffer, keeping at most `cap` bytes.
///
/// Reading continues past the cap (draining, discarding) so the child is never
/// blocked writing into a full pipe — a blocked child would never observe our
/// signal and would sit in an uninterruptible write forever.
fn drain_capped<R: Read + Send + 'static>(
    mut src: R,
    cap: usize,
) -> mpsc::Receiver<(Vec<u8>, bool)> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        let mut truncated = false;
        loop {
            match src.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Keep the tail: the end of a build log carries the error.
                    kept.extend_from_slice(&buf[..n]);
                    if kept.len() > cap {
                        let excess = kept.len() - cap;
                        kept.drain(..excess);
                        truncated = true;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send((kept, truncated));
    });
    rx
}

#[cfg(unix)]
fn configure_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: setsid is async-signal-safe and is the documented way to move the
    // child into a fresh session + process group between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(windows)]
fn configure_group(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

/// Signal every process in the child's group.
#[cfg(unix)]
fn kill_group(child: &mut Child) {
    let pid = child.id() as i32;
    // A negative pid targets the whole process group. `setsid` made the child
    // the group leader, so its pid is the pgid.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    // Fall back to the direct child in case setsid did not take effect.
    let _ = child.kill();
}

#[cfg(windows)]
fn kill_group(child: &mut Child) {
    let pid = child.id();
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(unix)]
fn shell() -> (&'static str, &'static str) {
    ("/bin/sh", "-c")
}

#[cfg(windows)]
fn shell() -> (&'static str, &'static str) {
    ("cmd.exe", "/C")
}

pub struct SpawnTask {
    command: String,
    cwd: Option<String>,
    timeout_ms: u64,
    max_output: usize,
}

impl Task for SpawnTask {
    type Output = SpawnResult;
    type JsValue = SpawnResult;

    fn compute(&mut self) -> Result<Self::Output> {
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

        let mut child = cmd
            .spawn()
            .map_err(|e| Error::new(Status::GenericFailure, format!("spawn failed: {e}")))?;

        let out_rx = drain_capped(child.stdout.take().expect("piped"), self.max_output);
        let err_rx = drain_capped(child.stderr.take().expect("piped"), self.max_output);

        let deadline = Duration::from_millis(self.timeout_ms);
        let started = Instant::now();
        let mut timed_out = false;
        let mut exit_code = -1i32;

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    exit_code = status.code().unwrap_or(-1);
                    break;
                }
                Ok(None) => {
                    if started.elapsed() >= deadline {
                        timed_out = true;
                        // Kill the group *before* collecting output: grandchildren
                        // hold the write end of the pipe and the readers will not
                        // see EOF until every one of them is gone.
                        kill_group(&mut child);
                        let _ = child.wait();
                        break;
                    }
                    thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                }
                Err(e) => {
                    return Err(Error::new(
                        Status::GenericFailure,
                        format!("wait failed: {e}"),
                    ))
                }
            }
        }

        let grace = Duration::from_millis(DRAIN_GRACE_MS);
        let (stdout, trunc_out) = out_rx.recv_timeout(grace).unwrap_or_default();
        let (stderr, trunc_err) = err_rx.recv_timeout(grace).unwrap_or_default();

        Ok(SpawnResult {
            exit_code,
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            timed_out,
            truncated: trunc_out || trunc_err,
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
