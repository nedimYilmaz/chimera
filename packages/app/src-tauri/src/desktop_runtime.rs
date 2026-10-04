//! Start the embedded service once when a standalone desktop opens. Development builds and
//! explicit --socket connections keep using their externally managed daemon.
use std::{fs::{self, OpenOptions}, path::Path, process::{Command, Stdio}, time::{Duration, Instant}};

pub fn start(resource_dir: &Path, home: &Path, args: &[String]) -> Result<bool, String> {
    if args.iter().any(|arg| arg == "--socket" || arg.starts_with("--socket=")) { return Ok(false); }
    let runtime = resource_dir.join("runtime");
    if !runtime.exists() { return Ok(false); }
    let node = runtime.join(if cfg!(windows) { "node/node.exe" } else { "node/bin/node" });
    let bootstrap = runtime.join("bootstrap.mjs");
    if !node.is_file() || !bootstrap.is_file() || !runtime.join("runtime.json").is_file() {
        return Err("The bundled background service is incomplete. Reinstall Chimera.".into());
    }
    fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let log = OpenOptions::new().create(true).append(true).open(home.join("desktop-runtime.log")).map_err(|e| e.to_string())?;
    let mut command = Command::new(node);
    command.arg(bootstrap).current_dir(home).env("CHIMERA_HOME", home)
        .stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
    // A desktop opened from an agent's shell is still an operator, not that agent.
    for key in ["CHIMERA_AGENT_ID", "CHIMERA_DEPTH", "CHIMERA_TREE_ID", "CHIMERA_TEAM", "CHIMERA_ROLE", "CHIMERA_PARENT_PID", "NODE_OPTIONS", "NODE_PATH"] {
        command.env_remove(key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| format!("Cannot start bundled service: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => return Ok(true),
            Some(status) => return Err(format!("Background service startup failed ({status}); see {}", home.join("desktop-runtime.log").display())),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Background service startup timed out; see desktop-runtime.log".into());
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn development_and_explicit_endpoints_do_not_start_a_service() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!start(dir.path(), &dir.path().join("home"), &[]).unwrap());
        fs::create_dir(dir.path().join("runtime")).unwrap();
        for args in [vec!["--socket".into(), "custom".into()], vec!["--socket=custom".into()]] {
            assert!(!start(dir.path(), &dir.path().join("home"), &args).unwrap());
        }
        assert!(!dir.path().join("home").exists());
        assert!(start(dir.path(), &dir.path().join("home"), &[]).unwrap_err().contains("incomplete"));
    }
    #[cfg(unix)]
    #[test]
    fn launches_embedded_node_with_space_paths_and_reports_failures() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::Builder::new().prefix("chimera runtime ").tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        fs::create_dir_all(runtime.join("node/bin")).unwrap();
        fs::write(runtime.join("bootstrap.mjs"), "").unwrap();
        fs::write(runtime.join("runtime.json"), "{}").unwrap();
        let node = runtime.join("node/bin/node");
        fs::write(&node, "#!/bin/sh\n[ -f \"$1\" ] && [ . -ef \"$CHIMERA_HOME\" ] && echo ready\n").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        let home = dir.path().join("user state");
        assert!(start(dir.path(), &home, &[]).unwrap());
        assert!(fs::read_to_string(home.join("desktop-runtime.log")).unwrap().contains("ready"));
        fs::write(&node, "#!/bin/sh\nexit 7\n").unwrap();
        assert!(start(dir.path(), &home, &[]).unwrap_err().contains("startup failed"));
    }
}
