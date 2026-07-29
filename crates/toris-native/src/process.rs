//! Platform primitives for running a command in its own process group.
//!
//! The group is the entire point of this crate. Node signals only the direct
//! child, which for `sh -c "..."` is the shell; the real work is a grandchild
//! that survives and is reparented to init. Putting the child in a fresh group
//! makes "kill everything this command started" a single syscall.

use std::process::Command;

/// The shell and its "run this string" flag, per platform.
#[cfg(unix)]
pub fn shell() -> (&'static str, &'static str) {
    ("/bin/sh", "-c")
}

#[cfg(windows)]
pub fn shell() -> (&'static str, &'static str) {
    ("cmd.exe", "/C")
}

/// Arrange for the spawned child to lead a new process group.
#[cfg(unix)]
pub fn configure_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: pre_exec runs between fork and exec, where only async-signal-safe
    // calls are permitted. setsid is on that list and is the documented way to
    // start a new session and process group.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(windows)]
pub fn configure_group(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

/// Kill every process in the group led by `pid`.
///
/// Takes a pid rather than a `&mut Child` so the `Child` can be owned by the
/// thread blocking in `wait()` while this runs on another.
#[cfg(unix)]
pub fn kill_group(pid: u32) {
    let pid = pid as i32;
    // SAFETY: kill(2) is safe to call with any pid; an unknown or already-reaped
    // target returns ESRCH rather than misbehaving. A negative pid addresses the
    // process group, which setsid made the child the leader of. The second call
    // covers the case where setsid did not take effect, leaving the child in our
    // own group where the negative form would not have reached it.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
        libc::kill(pid, libc::SIGKILL);
    }
}

#[cfg(windows)]
pub fn kill_group(pid: u32) {
    use std::process::Stdio;
    // Windows has no POSIX process groups to signal; taskkill /T walks the tree.
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_flag_pairs_with_its_binary() {
        let (bin, flag) = shell();
        assert!(!bin.is_empty());
        assert!(flag.starts_with(['-', '/']));
    }

    #[cfg(unix)]
    #[test]
    fn killing_an_unknown_group_is_a_no_op() {
        // Must not panic or abort: by the time a timeout fires the group may
        // already be gone, and that is the ordinary case, not an error.
        kill_group(u32::MAX / 2);
    }
}
