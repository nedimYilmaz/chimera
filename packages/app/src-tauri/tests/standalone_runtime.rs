use std::{fs, path::PathBuf, process::Command, time::Duration};

// Runs the exact Rust startup path against a built app's resources, without opening or
// stopping the operator's existing desktop. Never reads the operator's Chimera state.
#[test]
#[ignore = "set CHIMERA_TEST_RESOURCE_DIR to a built standalone app's resource directory"]
fn real_bundled_service_starts_and_is_reused() {
    let resources = PathBuf::from(std::env::var_os("CHIMERA_TEST_RESOURCE_DIR").expect("CHIMERA_TEST_RESOURCE_DIR"));
    let home = tempfile::Builder::new().prefix("csr").tempdir().unwrap();
    let runtime = resources.join("runtime");
    let node = runtime.join(if cfg!(windows) { "node/node.exe" } else { "node/bin/node" });
    struct Stop { node: PathBuf, runtime: PathBuf, home: PathBuf }
    impl Drop for Stop {
        fn drop(&mut self) {
            let _ = Command::new(&self.node).args(["--input-type=module", "--eval", "import {pathToFileURL} from 'node:url'; const {ChimeraClient} = await import(pathToFileURL(process.argv[1])); const c = await ChimeraClient.connect({autostart:false}); await c.request('daemon.stop',{}); c.close();"])
                .arg(self.runtime.join("packages/client/src/client.js")).env("CHIMERA_HOME", &self.home).output();
        }
    }
    let stop = Stop { node, runtime, home: home.path().to_path_buf() };
    assert!(chimera_app::desktop_runtime::start(&resources, home.path(), &[]).unwrap());
    let first = fs::read_to_string(home.path().join("daemon.pid")).unwrap();
    assert!(chimera_app::desktop_runtime::start(&resources, home.path(), &[]).unwrap());
    assert_eq!(first, fs::read_to_string(home.path().join("daemon.pid")).unwrap());
    drop(stop);
    for _ in 0..100 {
        if !home.path().join("daemon.pid").exists() { return; }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("Test daemon did not stop");
}
