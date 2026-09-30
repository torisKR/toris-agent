//! toris desktop — Tauri backend.
//!
//! This process is a thin, robust host around the REAL toris chat engine. It
//! spawns a Node "bridge" sidecar (`src/desktop/bridge.js`) that speaks NDJSON
//! over stdio, forwards every line the sidecar prints to the webview as a
//! `bridge-event`, and exposes a single `bridge_write` command the frontend
//! uses to send commands (send / approval / abort / reset) back to the sidecar.
//!
//! Keeping the agent logic in Node means the desktop app reuses the exact same
//! providers, tools and autonomy gating as the `toris` CLI — the Rust side owns
//! only process lifecycle and message plumbing.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

/// Shared handle to the sidecar's stdin, guarded so commands from the webview
/// can be written serially from any thread.
struct BridgeState {
    stdin: Mutex<Option<ChildStdin>>,
    #[allow(dead_code)]
    child: Mutex<Option<Child>>,
}

/// Locate the Node bridge script and the directory the agent's file tools
/// should default to.
///
/// Resolution order:
///   1. `TORIS_BRIDGE_PATH` env override (used by tests / power users).
///   2. The bundled resource copy shipped inside the installed app
///      (`<resource_dir>/toris/src/desktop/bridge.js`).
///   3. The in-repo path from the compile-time manifest dir (dev / `tauri dev`).
///
/// Returns `(bridge_script, working_dir)`.
fn resolve_bridge(app: &AppHandle) -> (PathBuf, PathBuf) {
    let home = dirs_home();

    if let Ok(p) = std::env::var("TORIS_BRIDGE_PATH") {
        let cwd = std::env::var("TORIS_DESKTOP_CWD")
            .map(PathBuf::from)
            .unwrap_or(home);
        return (PathBuf::from(p), cwd);
    }

    // Bundled: the whole repo `src/` tree is shipped under `toris/` so the
    // sidecar's relative imports (`../core/...`) resolve unchanged.
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("toris").join("src").join("desktop").join("bridge.js");
        if bundled.exists() {
            let cwd = std::env::var("TORIS_DESKTOP_CWD")
                .map(PathBuf::from)
                .unwrap_or(home);
            return (bundled, cwd);
        }
    }

    // Dev fallback: run straight from the working tree, with file tools rooted
    // at the repo so "list the files in this project" is meaningful.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let bridge = manifest.join("..").join("src").join("desktop").join("bridge.js");
    let cwd = std::env::var("TORIS_DESKTOP_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest.join(".."));
    (bridge, cwd)
}

/// The user's home directory, or `.` if it cannot be determined.
fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn node_bin() -> String {
    std::env::var("TORIS_NODE_BIN").unwrap_or_else(|_| "node".to_string())
}

/// Spawn the Node sidecar and wire its stdout/stderr to the webview.
fn spawn_bridge(app: &AppHandle) -> Result<(Child, ChildStdin), String> {
    let (bridge, cwd) = resolve_bridge(app);
    let mut cmd = Command::new(node_bin());
    cmd.arg(&bridge)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn node bridge at {:?}: {e}", bridge))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "bridge stdin unavailable".to_string())?;

    // stdout: one JSON event per line -> `bridge-event`.
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(value) => {
                        let _ = app.emit("bridge-event", value);
                    }
                    Err(_) => {
                        let _ = app.emit(
                            "bridge-event",
                            serde_json::json!({ "type": "raw", "line": line }),
                        );
                    }
                }
            }
            let _ = app.emit("bridge-event", serde_json::json!({ "type": "bridge-closed" }));
        });
    }

    // stderr: diagnostics -> `bridge-log` (and the host console).
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                eprintln!("{line}");
                let _ = app.emit("bridge-log", line);
            }
        });
    }

    Ok((child, stdin))
}

/// Send one command (a JSON object) to the sidecar's stdin.
#[tauri::command]
fn bridge_write(payload: Value, state: State<'_, BridgeState>) -> Result<(), String> {
    let mut guard = state.stdin.lock().map_err(|_| "stdin lock poisoned")?;
    let stdin = guard.as_mut().ok_or("bridge not started")?;
    let mut line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("write to bridge failed: {e}"))?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BridgeState {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle();
            match spawn_bridge(handle) {
                Ok((child, stdin)) => {
                    let state = app.state::<BridgeState>();
                    *state.stdin.lock().unwrap() = Some(stdin);
                    *state.child.lock().unwrap() = Some(child);
                }
                Err(e) => {
                    eprintln!("[toris-desktop] {e}");
                    let _ = handle.emit(
                        "bridge-event",
                        serde_json::json!({ "type": "error", "message": e, "code": "E_BRIDGE_SPAWN" }),
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bridge_write])
        .run(tauri::generate_context!())
        .expect("error while running toris desktop");
}
