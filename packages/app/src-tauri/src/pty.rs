//! IN-APP-TERMINAL: PTY sessions owned by the app process. Hosting them here rather
//! than in the daemon is deliberate — the shell then runs with exactly the operator's
//! own privileges and adds no new trust boundary on the daemon socket.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const FLUSH_BYTES: usize = 32 * 1024;
// A stuck terminal-open key must not fork-bomb the operator's machine.
pub const MAX_SESSIONS: usize = 8;

#[derive(serde::Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyMsg {
    Output { b64: String },
    Exit { code: Option<i32> },
}

pub struct Session {
    #[allow(dead_code)]
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // Shared with the reader thread: close_session kills through it, and after EOF the reader
    // waits on it to learn the exit code. One owner would force a choice between the two.
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

#[derive(Default)]
pub struct PtyState {
    pub sessions: Mutex<HashMap<String, Session>>,
}

pub fn open_session(
    state: &PtyState,
    cwd: String,
    cols: u16,
    rows: u16,
    sink: impl Fn(PtyMsg) + Send + 'static,
) -> Result<String, String> {
    open_session_with(state, cwd, cols, rows, None, sink)
}

/// TERMINAL-RUNTIME: same PTY, but running a GIVEN command instead of the operator's login shell.
///
/// `command` is the argv of the thing to run — for an agent terminal that is
/// `tmux attach -t =chimera-<id>`, i.e. a VIEW onto a session the daemon owns. The agent process
/// itself is never a child of this app: closing the window, or the app, detaches rather than kills.
/// That split is the whole reason the runtime is tmux-hosted (see core/src/terminal-runtime.ts).
///
/// CHIMERA_* stays stripped here exactly as it is for the operator shell. It would be actively
/// wrong to pass it: the agent's identity is set on the tmux SESSION by the daemon, and leaking
/// this app's own vars into an attaching client is how a terminal ends up claiming to be an agent
/// it is not.
pub fn open_session_with(
    state: &PtyState,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<Vec<String>>,
    sink: impl Fn(PtyMsg) + Send + 'static,
) -> Result<String, String> {
    {
        let sessions = state.sessions.lock().map_err(|_| "pty registry poisoned".to_string())?;
        if sessions.len() >= MAX_SESSIONS {
            return Err(format!("terminal limit reached ({MAX_SESSIONS} open)"));
        }
    }
    let cwd = usable_cwd(cwd);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = match command {
        Some(argv) if !argv.is_empty() => {
            let mut c = CommandBuilder::new(&argv[0]);
            for a in &argv[1..] {
                c.arg(a);
            }
            c
        }
        // No command (or an empty one) is the operator's own shell, unchanged.
        _ => {
            let mut c = CommandBuilder::new(resolve_shell());
            #[cfg(not(windows))]
            c.arg("-l");
            c
        }
    };
    cmd.cwd(cwd);
    // The app process may carry CHIMERA_* (agent identity). A leaked CHIMERA_TEAM makes the
    // mcp tests fail spuriously — see CLAUDE.md. The operator's shell must start clean.
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if k.starts_with("CHIMERA_") {
            continue;
        }
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>> =
        Arc::new(Mutex::new(pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?));
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = format!("term-{}", uuid_like());

    let child_for_exit = child.clone();
    std::thread::spawn(move || {
        let mut raw = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let mut last = Instant::now();
        loop {
            match reader.read(&mut raw) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&raw[..n]);
                    if pending.len() >= FLUSH_BYTES || last.elapsed() >= FLUSH_INTERVAL {
                        sink(PtyMsg::Output {
                            b64: base64::engine::general_purpose::STANDARD.encode(&pending),
                        });
                        pending.clear();
                        last = Instant::now();
                    }
                }
            }
        }
        if !pending.is_empty() {
            sink(PtyMsg::Output {
                b64: base64::engine::general_purpose::STANDARD.encode(&pending),
            });
        }
        // EOF on the master means the shell is gone. Emitting the code on the SAME channel
        // keeps ordering: every byte the shell wrote is delivered before its exit.
        let code = child_for_exit.lock().ok().and_then(|mut c| c.wait().ok()).map(|s| s.exit_code() as i32);
        sink(PtyMsg::Exit { code });
    });

    state
        .sessions
        .lock()
        .map_err(|_| "pty registry poisoned".to_string())?
        .insert(id.clone(), Session { master: pair.master, writer, child });
    Ok(id)
}

pub fn write_session(state: &PtyState, id: &str, data: &str) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "pty registry poisoned".to_string())?;
    let s = sessions.get_mut(id).ok_or_else(|| "no such terminal".to_string())?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

pub fn resize_session(state: &PtyState, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "pty registry poisoned".to_string())?;
    let s = sessions.get(id).ok_or_else(|| "no such terminal".to_string())?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

fn usable_cwd(requested: String) -> String {
    if std::path::Path::new(&requested).is_dir() {
        return requested;
    }
    // A landed agent's worktree is removed by its own workflow; the daemon already falls back
    // to spec.cwd, so reaching here means even that is gone. Home is always better than failing.
    if let Ok(home) = std::env::var("HOME") {
        if std::path::Path::new(&home).is_dir() {
            return home;
        }
    }
    "/".to_string()
}

pub fn close_session(state: &PtyState, id: &str) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "pty registry poisoned".to_string())?;
    if let Some(s) = sessions.remove(id) {
        if let Ok(mut c) = s.child.lock() {
            let _ = c.kill(); // an already-exited child is not an error
            let _ = c.wait();
        }
    }
    Ok(())
}

fn resolve_shell() -> String {
    #[cfg(windows)]
    { return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()); }
    #[cfg(not(windows))]
    {
    for candidate in [std::env::var("SHELL").unwrap_or_default(), "/bin/zsh".into(), "/bin/sh".into()] {
        if !candidate.is_empty() && std::path::Path::new(&candidate).exists() {
            return candidate;
        }
    }
    "/bin/sh".into()
    }
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    format!("{n:x}")
}

#[tauri::command]
pub fn term_open(
    state: tauri::State<'_, PtyState>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_output: tauri::ipc::Channel<PtyMsg>,
) -> Result<String, String> {
    open_session(&state, cwd, cols, rows, move |msg| {
        let _ = on_output.send(msg);
    })
}

/// TERMINAL-RUNTIME: attach a view to an agent's tmux session. Separate from `term_open` so the
/// operator-shell path keeps its exact signature and no caller can pass a command by accident.
#[tauri::command]
pub fn term_open_command(
    state: tauri::State<'_, PtyState>,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Vec<String>,
    on_output: tauri::ipc::Channel<PtyMsg>,
) -> Result<String, String> {
    open_session_with(&state, cwd, cols, rows, Some(command), move |msg| {
        let _ = on_output.send(msg);
    })
}

#[tauri::command]
pub fn term_write(state: tauri::State<'_, PtyState>, term_id: String, data: String) -> Result<(), String> {
    write_session(&state, &term_id, &data)
}

#[tauri::command]
pub fn term_resize(state: tauri::State<'_, PtyState>, term_id: String, cols: u16, rows: u16) -> Result<(), String> {
    resize_session(&state, &term_id, cols, rows)
}

#[tauri::command]
pub fn term_close(state: tauri::State<'_, PtyState>, term_id: String) -> Result<(), String> {
    close_session(&state, &term_id)
}
