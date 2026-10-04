//! Tauri command surface — the ONLY door between the webview and the daemon
//! socket (CSP is self-only; the webview never touches the fd). Thin by
//! design: all connection smarts live in daemon.rs so they stay testable
//! without a running app. The JS side of this contract is src/rpc/bridge.ts.

use serde_json::Value;
use tauri::{Manager, State};

use crate::daemon::{DaemonHandle, RpcError};

/// Forward one JSON-RPC request to chimerad. Errors serialize as the daemon's
/// own {code, message} shape (RpcError derives Serialize), so the webview's
/// catch-side probes (isUnknownMethod & co.) work unchanged.
#[tauri::command]
pub async fn rpc_call(
    state: State<'_, DaemonHandle>,
    method: String,
    params: Value,
) -> Result<Value, RpcError> {
    state.call(method, params).await
}

/// Turn on the daemon's event stream for our connection (forwarded to the
/// webview as `daemon://event`). The filter is remembered and re-applied by
/// the Rust side after every reconnect — JS calls this once and forgets.
#[tauri::command]
pub async fn subscribe(state: State<'_, DaemonHandle>, filter: Value) -> Result<(), RpcError> {
    state.subscribe(filter).await
}

/// Snapshot of the connection state for late subscribers — `daemon://state`
/// only fires on transitions, so bridge.ts calls this once on attach.
#[tauri::command]
pub fn daemon_status(state: State<'_, DaemonHandle>) -> &'static str {
    state.state().as_str()
}

/// Headless-E2E probe (debug builds only): bridge.ts mirrors every
/// `daemon://state` / `daemon://event` it RECEIVES back through this command,
/// which appends to the file named by $CHIMERA_PROBE_FILE. A line landing in
/// that file proves the whole pipe — socket → daemon.rs → emit → webview
/// listener → invoke — because the webview itself wrote it. The window is
/// often unobservable in unattended runs (locked display defeats
/// screencapture), so this is the machine-checkable stand-in. No env var →
/// no-op; release builds compile it out entirely.
#[tauri::command]
pub fn dev_probe(line: String) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        if let Ok(path) = std::env::var("CHIMERA_PROBE_FILE") {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "{line}");
            }
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = line;
}

/// W6: open a transcript/composer image in the OS viewer (ImageChip click
/// inside Tauri; the browser fallback keeps the in-column lightbox). The
/// webview holds only the base64 payload — no fs access — so this command
/// materializes it under the OS temp dir and hands the path to the opener
/// plugin. The name is reduced to a sanitized basename and the extension is
/// derived from the vetted media type, so a hostile name can never escape
/// the chimera-images temp folder.
#[tauri::command]
pub fn open_image(
    app: tauri::AppHandle,
    name: String,
    media_type: String,
    data: String,
) -> Result<(), String> {
    use base64::Engine as _;
    use std::io::Write as _;
    use tauri_plugin_opener::OpenerExt;

    let ext = match media_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        other => return Err(format!("unsupported media type: {other}")),
    };
    let stem: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(64)
        .collect();
    if data.len() > 24 * 1024 * 1024 {
        return Err("image data exceeds the 24 MiB encoded limit".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid image data: {e}"))?;

    // Do not overwrite predictable filenames in a shared system-temp folder:
    // another process could preplant a symlink, or two images could collide.
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = tempfile::Builder::new().prefix(&format!("{stem}-")).suffix(&format!(".{ext}"))
        .tempfile_in(&dir).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    let (file, path) = file.keep().map_err(|e| e.to_string())?;
    drop(file); // the OS viewer must be able to reopen it on Windows

    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// F17 (W19): artifact ids are always core's `randomUUID()` (see
/// packages/core/src/artifacts.ts) — reject anything else before it ever
/// touches a path join, so a hostile/corrupt id can never escape the
/// `artifacts/` snapshot directory.
fn sanitize_artifact_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("invalid artifact id".to_string())
    }
}

/// F17 (W19): read an artifact's on-disk snapshot (`${CHIMERA_HOME}/artifacts/
/// <id>`, core's ArtifactStore) as UTF-8 text — feeds the in-app preview (the
/// F12 MessageBody renderer, fed a report/diff/chart's raw content) and the
/// artifacts strip's diff-chip ±line count. Lossy-converts non-UTF-8 bytes
/// rather than failing outright.
#[tauri::command]
pub fn read_artifact(id: String) -> Result<String, String> {
    sanitize_artifact_id(&id)?;
    let path = crate::daemon::chimera_home().join("artifacts").join(&id);
    std::fs::read(&path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|e| e.to_string())
}

/// F17 (W19): `o` OS-open for a report/diff/chart/file-kind artifact — hands
/// the on-disk snapshot straight to the opener plugin (already a real file,
/// unlike open_image's base64 payload).
#[tauri::command]
pub fn open_artifact(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    sanitize_artifact_id(&id)?;
    let path = crate::daemon::chimera_home().join("artifacts").join(&id);
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// F17 (W19): `o` OS-open for a "link"-kind artifact — no snapshot exists
/// (ArtifactStore stores the url as a bare reference), so this opens the url
/// itself rather than a path.
#[tauri::command]
pub fn open_artifact_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    crate::native_security::open_artifact_url(&url, |url| {
        app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
    })
}

/// F19 (W21): `x` exports the usage & cost card's current groupBy rows as a
/// csv file — the webview holds only the generated text (no fs seam, same
/// rule as open_image), so this materializes it under `${CHIMERA_HOME}/
/// exports/` and hands the resulting path back for the "csv exported: <path>"
/// toast. The name is reduced to a sanitized basename (mirrors open_image)
/// so a hostile filename can never escape the exports folder.
#[tauri::command]
pub fn write_export(filename: String, content: String) -> Result<String, String> {
    crate::native_security::write_export(&crate::daemon::chimera_home(), &filename, &content)
}

/// F20 (files-since fix): checked before shelling out — a checkpoint ref is
/// always `refs/chimera/checkpoints/<n>` (core's CheckpointStore), so anything
/// else (whitespace, a `..` range already baked in) is rejected rather than
/// handed to `git` as a revision argument.
fn sanitize_checkpoint_ref(r: &str) -> Result<(), String> {
    if r.starts_with("refs/") && !r.contains("..") && !r.chars().any(|c| c.is_whitespace()) {
        Ok(())
    } else {
        Err("invalid checkpoint ref".to_string())
    }
}

/// F20 (files-since fix): the checkpoints card's "files changed since" count,
/// deferred at W22 landing because D16's CheckpointRecord carries no diff-stat
/// field. A read-only webview-local `git diff --name-only <ref>..HEAD` shell-
/// out against the checkpoint's own repo cwd — mirrors D16's own git-plumbing-
/// only design for checkpoints, so this stays local rather than becoming a new
/// daemon RPC.
#[tauri::command]
pub fn checkpoint_files_since(cwd: String, checkpoint_ref: String) -> Result<u32, String> {
    sanitize_checkpoint_ref(&checkpoint_ref)?;
    let range = format!("{checkpoint_ref}..HEAD");
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&cwd)
        .arg("diff")
        .arg("--name-only")
        .arg(&range)
        .arg("--")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let count = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count();
    Ok(count as u32)
}

/// F18 (W20): dock/taskbar badge = pending permissions + questions
/// (selectors.notify.pendingBadgeCount, App.tsx's useNotifySurfaces). Native
/// Tauri core API (`Window::set_badge_count` — no plugin); Windows is a
/// documented no-op there (overlay icon is the Windows equivalent, out of
/// scope here), so this never errors on an unsupported platform.
#[tauri::command]
pub fn set_dock_badge(app: tauri::AppHandle, count: i64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_badge_count(if count > 0 { Some(count) } else { None })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// IN-APP-TERMINAL: escape hatch to the operator's real terminal for the cases the embedded
/// one deliberately does not cover (splits, profiles, tmux). `open -a` picks the user's
/// configured app; iTerm is honoured when installed, Terminal.app is the OS fallback. Worktrees
/// are removed after landing, so a stale tab cwd is the common case, not an exotic one — fall
/// back to $HOME rather than erroring.
#[tauri::command]
pub fn open_in_terminal(cwd: String) -> Result<(), String> {
    let dir = if std::path::Path::new(&cwd).is_dir() {
        cwd
    } else {
        dirs::home_dir().ok_or("home directory is unavailable")?.to_string_lossy().into_owned()
    };
    #[cfg(target_os = "macos")]
    {
    let app = if std::path::Path::new("/Applications/iTerm.app").exists() {
        "iTerm"
    } else {
        "Terminal"
    };
    std::process::Command::new("open")
        .arg("-a")
        .arg(app)
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        // cwd is a process attribute, never interpolated into a shell command.
        std::process::Command::new("cmd.exe").args(["/D", "/C", "start", "", "cmd.exe"])
            .current_dir(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("x-terminal-emulator").current_dir(dir)
            .spawn().map(|_| ()).map_err(|_| "No x-terminal-emulator found; use Chimera's built-in terminal or configure your system terminal alternative.".into())
    }
}
