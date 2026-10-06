//! Desktop control belongs to the GUI's OS identity. chimerad only connects an MCP
//! proxy to this app-owned socket; it must never spawn the automation daemon.
use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::State;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config { driver_path: PathBuf, socket_path: String }

struct Runtime { child: Child }
impl Drop for Runtime {
    // The driver only unlinks its endpoint on a liveness-pipe EOF; SIGKILL strands the socket
    // and the next launch's driver refuses to start over it. Kill is only the hung-driver fallback.
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if !matches!(self.child.try_wait(), Ok(None)) { return; }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = self.child.kill(); let _ = self.child.wait();
    }
}
// The second field is the app's resource dir: where the packaged runtime (and the cua-driver it
// bundles) lives. None in a development build, which keeps using desktop.json only.
#[derive(Clone, Default)]
pub struct ComputerUseState(Arc<Mutex<Option<Runtime>>>, Option<PathBuf>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    configured: bool,
    // "bundled" = the driver shipped inside Chimera; "override" = an explicit computer-use/desktop.json.
    driver_source: Option<&'static str>,
    running: bool,
    auto_start: bool,
    permission_owner: &'static str,
    accessibility: Option<bool>,
    screen_recording: Option<bool>,
}

fn validate_endpoint(cfg: &Config) -> Result<(), String> {
    #[cfg(unix)]
    if !Path::new(&cfg.socket_path).is_absolute() || cfg.socket_path.len() >= 104 { return Err("Desktop socket must be an absolute path shorter than 104 bytes.".into()); }
    #[cfg(windows)]
    if !cfg.socket_path.starts_with(r"\\.\pipe\") { return Err("Desktop endpoint must be a Windows named pipe.".into()); }
    Ok(())
}

// The driver the installer shipped, found through the runtime's own manifest. The endpoint is the
// same one the daemon registers (core's desktopSocket), so the two sides agree without a config
// file. Only macOS ships a driver today; any other manifest state means "nothing bundled".
fn bundled_config(home: &Path, resources: Option<&Path>) -> Result<Option<Config>, String> {
    let Some(resources) = resources else { return Ok(None) };
    let runtime = resources.join("runtime");
    let bytes = match std::fs::read(runtime.join("integrations/manifest.json")) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid bundled integration manifest: {e}"))?;
    let entry = &manifest["integrations"]["chimera-desktop"];
    if entry["state"].as_str() != Some("bundled") { return Ok(None); }
    let rel = Path::new(entry["driver"].as_str().ok_or("The bundled integration manifest names no desktop driver.")?);
    if rel.is_absolute() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err("The bundled integration manifest has an unsafe driver path.".into());
    }
    let driver_path = runtime.join(rel);
    if !driver_path.is_file() { return Err("The desktop control runtime bundled with Chimera is missing. Reinstall Chimera.".into()); }
    #[cfg(unix)]
    {
        let cfg = Config { driver_path, socket_path: home.join("computer-use/desktop.sock").to_string_lossy().into_owned() };
        validate_endpoint(&cfg)?;
        Ok(Some(cfg))
    }
    #[cfg(not(unix))]
    { let _ = (home, driver_path); Ok(None) }
}

// desktop.json stays an explicit override (a developer's own driver build); without it the bundled
// driver is used.
fn config(home: &Path, resources: Option<&Path>) -> Result<Option<(Config, &'static str)>, String> {
    let path = home.join("computer-use/desktop.json");
    if !path.exists() { return Ok(bundled_config(home, resources)?.map(|cfg| (cfg, "bundled"))); }
    let cfg: Config = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("Invalid Chimera Computer Use setup: {e}"))?;
    if !cfg.driver_path.is_absolute() || !cfg.driver_path.is_file() { return Err("Chimera Computer Use runtime is missing; run its setup again.".into()); }
    validate_endpoint(&cfg)?;
    Ok(Some((cfg, "override")))
}

#[derive(Serialize, Deserialize, Default)]
struct Preferences { enabled: bool }

fn auto_start(home: &Path) -> Result<bool, String> {
    let path = home.join("computer-use/preferences.json");
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Preferences>(&bytes).map(|p| p.enabled).map_err(|e| format!("Invalid desktop preference: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Adopt an existing installation only when Chimera already has both
            // OS permissions; a recorded Stop always takes precedence. Only an explicit desktop.json
            // counts as that earlier operator choice: the bundled driver is present on EVERY install,
            // so treating it as consent would start desktop control the user never asked for. It
            // starts only after an explicit Start, which records preferences.json.
            let granted = permissions(false);
            Ok(home.join("computer-use/desktop.json").is_file() && granted == (Some(true), Some(true)))
        },
        Err(e) => Err(e.to_string()),
    }
}
fn save_enabled(home: &Path, enabled: bool) -> Result<(), String> {
    use std::io::Write;
    let dir = home.join("computer-use");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&Preferences { enabled }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(dir.join("preferences.json")).map_err(|e| e.to_string())?;
    Ok(())
}

fn driver_command(cfg: &Config, bundle_id: &str) -> Command {
    let mut cmd = Command::new(&cfg.driver_path);
    cmd.args(["serve", "--embedded", "--parent-liveness-stdio", "--no-permissions-gate", "--socket", &cfg.socket_path, "--host-bundle-id", bundle_id, "--permission-mode", "standard"])
        .env_clear().stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    // No provider credentials or ambient driver mode/profile overrides cross this boundary.
    for key in ["HOME", "USERPROFILE", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SystemRoot", "WINDIR", "APPDATA", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(key) { cmd.env(key, value); }
    }
    // The driver reports telemetry unless told otherwise; a bundled, app-owned driver must not.
    cmd.env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0").env("CUA_TELEMETRY_ENABLED", "0").env("DO_NOT_TRACK", "1");
    cmd.env("CUA_DRIVER_EMBEDDED", "1").env("CUA_DRIVER_HOST_BUNDLE_ID", bundle_id)
        .env("CUA_DRIVER_EMBEDDED_HOST_PID", std::process::id().to_string());
    cmd
}

fn endpoint_ready(endpoint: &str) -> bool {
    #[cfg(unix)]
    { std::os::unix::net::UnixStream::connect(endpoint).is_ok() }
    #[cfg(windows)]
    { std::fs::OpenOptions::new().read(true).write(true).open(endpoint).is_ok() }
}

impl ComputerUseState {
    pub fn with_resources(resources: PathBuf) -> Self { Self(Arc::default(), Some(resources)) }
    fn resources(&self) -> Option<&Path> { self.1.as_deref() }
    pub fn stop(&self) { if let Ok(mut owned) = self.0.lock() { owned.take(); } }
    pub fn resume(&self, home: &Path, bundle_id: &str) -> Result<bool, String> {
        if !auto_start(home)? { return Ok(false); }
        self.start(home, bundle_id)?;
        Ok(true)
    }
    fn disable(&self, home: &Path) -> Result<(), String> {
        let mut owned = self.0.lock().map_err(|e| e.to_string())?;
        owned.take();
        save_enabled(home, false)
    }
    fn status(&self, home: &Path) -> Result<Status, String> {
        let resolved = config(home, self.resources())?;
        let mut owned = self.0.lock().map_err(|e| e.to_string())?;
        if let Some(runtime) = owned.as_mut() {
            if runtime.child.try_wait().map_err(|e| e.to_string())?.is_some() { owned.take(); }
        }
        let (accessibility, screen_recording) = permissions(false);
        Ok(Status {
            configured: resolved.is_some(), driver_source: resolved.as_ref().map(|(_, source)| *source), running: owned.is_some(),
            auto_start: auto_start(home)?, permission_owner: "Chimera", accessibility, screen_recording,
        })
    }
    pub fn start(&self, home: &Path, bundle_id: &str) -> Result<(), String> {
        let (cfg, _) = config(home, self.resources())?.ok_or("Chimera Computer Use runtime is not installed.")?;
        let mut owned = self.0.lock().map_err(|e| e.to_string())?;
        if let Some(runtime) = owned.as_mut() {
            if runtime.child.try_wait().map_err(|e| e.to_string())?.is_none() { save_enabled(home, true)?; return Ok(()); }
            owned.take();
        }
        // Never attach to, stop, or adopt another host's desktop service.
        if endpoint_ready(&cfg.socket_path) { return Err("The desktop endpoint is already owned by another running app.".into()); }
        // A socket nobody accepts on was left by a crashed or killed host. The driver requires the
        // host to prove that and remove it before spawn; single-instance rules out a racing host.
        #[cfg(unix)]
        if std::fs::symlink_metadata(&cfg.socket_path).is_ok_and(|m| std::os::unix::fs::FileTypeExt::is_socket(&m.file_type())) {
            std::fs::remove_file(&cfg.socket_path).map_err(|e| format!("Could not remove the stale desktop endpoint: {e}"))?;
        }
        let mut runtime = Runtime { child: driver_command(&cfg, bundle_id).spawn().map_err(|e| format!("Could not start Chimera Computer Use: {e}"))? };
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            if runtime.child.try_wait().map_err(|e| e.to_string())?.is_some() { return Err("Chimera Computer Use exited before it was ready.".into()); }
            if endpoint_ready(&cfg.socket_path) { save_enabled(home, true)?; *owned = Some(runtime); return Ok(()); }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("Chimera Computer Use did not become ready within 12 seconds.".into())
    }
}

#[cfg(target_os = "macos")]
fn permissions(prompt: bool) -> (Option<bool>, Option<bool>) {
    use std::ffi::c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" { fn CGPreflightScreenCaptureAccess() -> bool; fn CGRequestScreenCaptureAccess() -> bool; }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        fn CFDictionaryCreate(allocator: *const c_void, keys: *const *const c_void, values: *const *const c_void, count: isize, key_callbacks: *const c_void, value_callbacks: *const c_void) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }
    // The calls execute in the Chimera process. The helper never raises permission prompts.
    unsafe {
        if prompt {
            let options = CFDictionaryCreate(std::ptr::null(), &kAXTrustedCheckOptionPrompt, &kCFBooleanTrue, 1, std::ptr::null(), std::ptr::null());
            if !options.is_null() { AXIsProcessTrustedWithOptions(options); CFRelease(options); }
            CGRequestScreenCaptureAccess();
        }
        (Some(AXIsProcessTrusted()), Some(CGPreflightScreenCaptureAccess()))
    }
}
#[cfg(not(target_os = "macos"))]
fn permissions(_prompt: bool) -> (Option<bool>, Option<bool>) { (None, None) }

#[tauri::command]
pub async fn computer_use_status(state: State<'_, ComputerUseState>) -> Result<Status, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.status(&crate::daemon::chimera_home())).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn computer_use_start(app: tauri::AppHandle, state: State<'_, ComputerUseState>) -> Result<Status, String> {
    let state = state.inner().clone(); let bundle_id = app.config().identifier.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        let home = crate::daemon::chimera_home(); state.start(&home, &bundle_id)?; state.status(&home)
    }).await.map_err(|e| e.to_string())??;
    Ok(status)
}
#[tauri::command]
pub async fn computer_use_stop(state: State<'_, ComputerUseState>) -> Result<Status, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let home = crate::daemon::chimera_home(); state.disable(&home)?; state.status(&home) }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn computer_use_permissions(app: tauri::AppHandle) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { permissions(true); let _ = tx.send(()); }).map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_choice_survives_shutdown_and_explicit_stop_disables_it() {
        let home = tempfile::tempdir().unwrap();
        let state = ComputerUseState::default();
        assert!(!auto_start(home.path()).unwrap());
        assert!(!state.resume(home.path(), "dev.chimera.desktop").unwrap());
        save_enabled(home.path(), true).unwrap();
        state.stop(); // App shutdown must keep the operator's choice.
        assert!(auto_start(home.path()).unwrap());
        // A missing driver must not erase the choice on an unsuccessful relaunch.
        assert!(ComputerUseState::default().resume(home.path(), "dev.chimera.desktop").is_err());
        assert!(auto_start(home.path()).unwrap());
        state.disable(home.path()).unwrap();
        assert!(!ComputerUseState::default().resume(home.path(), "dev.chimera.desktop").unwrap());
    }
    #[test]
    fn corrupt_preferences_fail_visibly_without_starting_control() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("computer-use")).unwrap();
        std::fs::write(home.path().join("computer-use/preferences.json"), "invalid").unwrap();
        assert!(ComputerUseState::default().resume(home.path(), "dev.chimera.desktop").is_err());
    }
    #[test]
    fn host_launch_keeps_identity_and_parent_liveness() {
        let cfg = Config { driver_path: PathBuf::from("/runtime with spaces/driver"), socket_path: "/private/test.sock".into() };
        let cmd = driver_command(&cfg, "dev.chimera.desktop");
        let args: Vec<_> = cmd.get_args().map(|s| s.to_string_lossy().to_string()).collect();
        assert!(args.contains(&"--embedded".into())); assert!(args.contains(&"--parent-liveness-stdio".into()));
        assert!(args.windows(2).any(|p| p == ["--host-bundle-id", "dev.chimera.desktop"]));
        assert!(args.windows(2).any(|p| p == ["--permission-mode", "standard"]));
        assert!(!cmd.get_envs().any(|(k, _)| k == "OPENAI_API_KEY" || k == "ANTHROPIC_API_KEY"));
        let env = |name: &str| cmd.get_envs().find(|(k, _)| *k == name).and_then(|(_, v)| v).map(|v| v.to_string_lossy().to_string());
        for name in ["CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_TELEMETRY_ENABLED"] { assert_eq!(env(name).as_deref(), Some("0"), "{name}"); }
        assert_eq!(env("DO_NOT_TRACK").as_deref(), Some("1"));
    }
    #[test]
    #[cfg(unix)]
    fn lifecycle_owns_one_child_and_refuses_another_hosts_endpoint() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let dir = home.path().join("computer-use"); std::fs::create_dir(&dir).unwrap();
        let script = home.path().join("fake-driver");
        std::fs::write(&script, r#"#!/usr/bin/python3
import os, socket, sys
path = sys.argv[sys.argv.index('--socket') + 1]
if os.path.exists(path): os.unlink(path)
s = socket.socket(socket.AF_UNIX)
s.bind(path)
s.listen(4)
sys.stdin.buffer.read()
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.join("desktop.json"), serde_json::json!({ "driverPath": script, "socketPath": dir.join("d.sock") }).to_string()).unwrap();
        let owner = ComputerUseState::default(); owner.start(home.path(), "dev.chimera.desktop").unwrap();
        let pid = owner.0.lock().unwrap().as_ref().unwrap().child.id();
        owner.start(home.path(), "dev.chimera.desktop").unwrap();
        assert_eq!(owner.0.lock().unwrap().as_ref().unwrap().child.id(), pid);
        let other = ComputerUseState::default();
        assert!(other.start(home.path(), "dev.chimera.desktop").unwrap_err().contains("already owned"));
        other.stop(); assert!(owner.status(home.path()).unwrap().running);
        owner.stop(); assert!(!owner.status(home.path()).unwrap().running);
        extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
        assert_eq!(unsafe { kill(pid as i32, 0) }, -1, "owned child must be reaped");
    }

    #[test]
    #[cfg(unix)]
    fn restart_survives_quit_and_reclaims_a_crashed_hosts_socket() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let dir = home.path().join("computer-use"); std::fs::create_dir(&dir).unwrap();
        let script = home.path().join("fake-driver");
        // Mirrors cua-driver 0.31: refuses a pre-existing endpoint and only unlinks it on a
        // graceful liveness-pipe EOF, so a SIGKILLed driver leaves the socket behind.
        std::fs::write(&script, r#"#!/usr/bin/python3
import os, socket, sys
path = sys.argv[sys.argv.index('--socket') + 1]
if os.path.exists(path): sys.exit(1)
s = socket.socket(socket.AF_UNIX)
s.bind(path)
s.listen(4)
sys.stdin.buffer.read()
os.unlink(path)
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sock = dir.join("d.sock");
        std::fs::write(dir.join("desktop.json"), serde_json::json!({ "driverPath": script, "socketPath": sock }).to_string()).unwrap();
        let state = ComputerUseState::default();
        state.start(home.path(), "dev.chimera.desktop").unwrap();
        state.stop();
        assert!(!sock.exists(), "quit must let the driver remove its own endpoint");
        state.start(home.path(), "dev.chimera.desktop").unwrap();
        state.stop();
        drop(std::os::unix::net::UnixListener::bind(&sock).unwrap());
        assert!(sock.exists());
        state.start(home.path(), "dev.chimera.desktop").unwrap();
        assert!(state.status(home.path()).unwrap().running);
        state.stop();
    }

    // A packaged runtime laid out like the installer's: <resources>/runtime/integrations/manifest.json
    // naming a relative driver path.
    fn packaged(resources: &Path, state: &str, driver: &str) {
        let integrations = resources.join("runtime/integrations");
        std::fs::create_dir_all(integrations.join("cua-driver")).unwrap();
        let entry = if state == "bundled" { serde_json::json!({ "state": "bundled", "version": "0.33.3", "driver": driver }) } else { serde_json::json!({ "state": state, "reason": "test" }) };
        std::fs::write(integrations.join("manifest.json"), serde_json::json!({ "schemaVersion": 1, "integrations": { "chimera-desktop": entry } }).to_string()).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn bundled_driver_is_found_through_the_manifest_without_desktop_json() {
        let tmp = tempfile::tempdir_in("/tmp").unwrap();
        let (resources, home) = (tmp.path().join("App Dir"), tmp.path().join("h"));
        packaged(&resources, "bundled", "integrations/cua-driver/cua-driver");
        std::fs::write(resources.join("runtime/integrations/cua-driver/cua-driver"), "").unwrap();
        let (cfg, source) = config(&home, Some(&resources)).unwrap().unwrap();
        assert_eq!(source, "bundled");
        assert_eq!(cfg.driver_path, resources.join("runtime/integrations/cua-driver/cua-driver"));
        // Must equal core's desktopSocket(home), which the daemon registers for the proxy.
        assert_eq!(cfg.socket_path, home.join("computer-use/desktop.sock").to_string_lossy());
    }

    #[test]
    #[cfg(unix)]
    fn desktop_json_overrides_the_bundled_driver() {
        let tmp = tempfile::tempdir_in("/tmp").unwrap();
        let (resources, home) = (tmp.path().join("res"), tmp.path().join("h"));
        packaged(&resources, "bundled", "integrations/cua-driver/cua-driver");
        std::fs::write(resources.join("runtime/integrations/cua-driver/cua-driver"), "").unwrap();
        let own = tmp.path().join("my-driver"); std::fs::write(&own, "").unwrap();
        std::fs::create_dir_all(home.join("computer-use")).unwrap();
        std::fs::write(home.join("computer-use/desktop.json"), serde_json::json!({ "driverPath": own, "socketPath": tmp.path().join("o.sock") }).to_string()).unwrap();
        let (cfg, source) = config(&home, Some(&resources)).unwrap().unwrap();
        assert_eq!((source, cfg.driver_path), ("override", own));
    }

    #[test]
    #[cfg(unix)]
    fn a_bundled_driver_alone_never_auto_starts_desktop_control() {
        // Present on every install, so it cannot stand in for the operator's consent -- even if the
        // OS permissions happen to be granted already. Only an explicit Start (or a recorded
        // preference / explicit desktop.json) may bring it up.
        let tmp = tempfile::tempdir_in("/tmp").unwrap();
        let (resources, home) = (tmp.path().join("r"), tmp.path().join("h"));
        packaged(&resources, "bundled", "integrations/cua-driver/cua-driver");
        std::fs::write(resources.join("runtime/integrations/cua-driver/cua-driver"), "").unwrap();
        let state = ComputerUseState::with_resources(resources);
        assert!(!auto_start(&home).unwrap());
        assert!(!state.resume(&home, "dev.chimera.desktop").unwrap());
        assert!(!state.status(&home).unwrap().running);
        assert!(!home.join("computer-use/preferences.json").exists(), "resume must not record consent");
    }

    #[test]
    fn nothing_bundled_means_not_configured_rather_than_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(config(&tmp.path().join("h"), None).unwrap().is_none(), "dev build: no resource dir");
        assert!(config(&tmp.path().join("h"), Some(tmp.path())).unwrap().is_none(), "no packaged runtime");
        packaged(tmp.path(), "unsupported-platform", "");
        assert!(config(&tmp.path().join("h"), Some(tmp.path())).unwrap().is_none(), "non-macOS manifests ship no driver");
    }

    #[test]
    fn a_manifest_that_promises_a_missing_or_unsafe_driver_fails_visibly() {
        // No Unix socket is opened here, so use the OS temp directory rather than requiring /tmp.
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("h");
        packaged(tmp.path(), "bundled", "integrations/cua-driver/cua-driver");
        assert!(config(&home, Some(tmp.path())).unwrap_err().contains("Reinstall Chimera"));
        let absolute_driver = tmp.path().join("outside");
        let mut bad_paths = vec!["../outside", "/abs/driver", "integrations/../../x"];
        bad_paths.push(absolute_driver.to_str().unwrap());
        // Windows root-relative and drive-relative paths are unsafe even when is_absolute is false.
        #[cfg(windows)]
        bad_paths.extend([r"C:\abs\driver", r"C:driver", r"\abs\driver", r"\\server\share\driver", r"..\outside", r"integrations\..\..\x"]);
        for bad in bad_paths {
            packaged(tmp.path(), "bundled", bad);
            assert!(config(&home, Some(tmp.path())).unwrap_err().contains("unsafe"), "{bad}");
        }
        std::fs::write(tmp.path().join("runtime/integrations/manifest.json"), "not json").unwrap();
        assert!(config(&home, Some(tmp.path())).unwrap_err().contains("Invalid bundled integration manifest"));
    }

    #[test]
    #[cfg(unix)]
    fn bundled_driver_hosts_the_endpoint_with_no_setup_file() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir_in("/tmp").unwrap();
        let (resources, home) = (tmp.path().join("r"), tmp.path().join("h"));
        packaged(&resources, "bundled", "integrations/cua-driver/cua-driver");
        let driver = resources.join("runtime/integrations/cua-driver/cua-driver");
        std::fs::write(&driver, r#"#!/usr/bin/python3
import os, socket, sys
path = sys.argv[sys.argv.index('--socket') + 1]
if os.path.exists(path): os.unlink(path)
s = socket.socket(socket.AF_UNIX)
s.bind(path)
s.listen(4)
sys.stdin.buffer.read()
"#).unwrap();
        std::fs::set_permissions(&driver, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir_all(home.join("computer-use")).unwrap();
        let state = ComputerUseState::with_resources(resources);
        assert!(!home.join("computer-use/desktop.json").exists());
        state.start(&home, "dev.chimera.desktop").unwrap();
        let status = state.status(&home).unwrap();
        assert!(status.configured && status.running);
        assert_eq!(status.driver_source, Some("bundled"));
        assert!(home.join("computer-use/desktop.sock").exists());
        state.stop();
    }

    #[test]
    fn missing_install_is_not_running_and_malformed_config_is_visible() {
        let home = tempfile::tempdir().unwrap(); let state = ComputerUseState::default();
        assert!(!state.status(home.path()).unwrap().configured);
        assert!(state.start(home.path(), "dev.chimera.desktop").is_err());
        std::fs::create_dir(home.path().join("computer-use")).unwrap();
        std::fs::write(home.path().join("computer-use/desktop.json"), "{}").unwrap();
        assert!(state.status(home.path()).is_err());
    }
}

// Independent screen capture: monitor reads must never consume the driver's
// capture IDs or replace an agent's actionable accessibility snapshot.
#[tauri::command]
pub async fn computer_use_preview(window_id: Option<u32>, state: State<'_, ComputerUseState>) -> Result<String, String> {
    if window_id == Some(0) || !state.status(&crate::daemon::chimera_home())?.running { return Err("Desktop control is stopped".into()); }
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        if permissions(false).1 != Some(true) { return Err("Screen Recording permission is required".into()); }
        let file = tempfile::Builder::new().suffix(".jpg").tempfile().map_err(|e| e.to_string())?;
        let mut capture = Command::new("/usr/sbin/screencapture");
        capture.args(["-x", "-o", "-t", "jpg"]);
        if let Some(id) = window_id { capture.args(["-l", &id.to_string()]); } else { capture.arg("-m"); }
        let mut child = capture.arg(file.path()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                if !status.success() { return Err("Target window is unavailable".into()); }
                break;
            }
            if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err("Preview timed out".into()); }
            std::thread::sleep(Duration::from_millis(25));
        }
        let bytes = std::fs::read(file.path()).map_err(|e| e.to_string())?;
        if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 { return Err("Preview size is unsupported".into()); }
        Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }).await.map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    Err("Live window preview is currently supported on macOS".into())
}
