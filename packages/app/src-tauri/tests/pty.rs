use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chimera_app::pty::{
    close_session, open_session, resize_session, write_session, PtyMsg, PtyState, MAX_SESSIONS,
};

fn collect(state: &PtyState, cwd: &str) -> (String, Arc<Mutex<Vec<u8>>>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let sink_buf = buf.clone();
    let id = open_session(state, cwd.to_string(), 80, 24, move |msg: PtyMsg| {
        if let PtyMsg::Output { b64 } = msg {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
            sink_buf.lock().unwrap().extend_from_slice(&bytes);
        }
    })
    .expect("session opens");
    (id, buf)
}

fn wait_for(buf: &Arc<Mutex<Vec<u8>>>, needle: &str, secs: u64) -> String {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let seen = String::from_utf8_lossy(&buf.lock().unwrap()).to_string();
        if seen.contains(needle) || Instant::now() > deadline {
            return seen;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn echo_roundtrips_through_the_pty() {
    let state = PtyState::default();
    let (id, buf) = collect(&state, env!("CARGO_MANIFEST_DIR"));
    write_session(&state, &id, "echo chimera_marker\n").unwrap();
    let seen = wait_for(&buf, "chimera_marker", 10);
    assert!(seen.contains("chimera_marker"), "pty output was: {seen}");
    close_session(&state, &id).unwrap();
}

#[test]
#[cfg(unix)]
fn resize_is_visible_to_the_shell() {
    let state = PtyState::default();
    let (id, buf) = collect(&state, env!("CARGO_MANIFEST_DIR"));
    resize_session(&state, &id, 120, 40).unwrap();
    write_session(&state, &id, "tput cols\n").unwrap();
    let seen = wait_for(&buf, "120", 10);
    assert!(seen.contains("120"), "expected 120 columns, output was: {seen}");
    close_session(&state, &id).unwrap();
}

#[test]
#[cfg(unix)]
fn child_environment_has_no_chimera_vars() {
    std::env::set_var("CHIMERA_TEAM", "leaked-team");
    let state = PtyState::default();
    let (id, buf) = collect(&state, env!("CARGO_MANIFEST_DIR"));
    write_session(&state, &id, "env | grep -c CHIMERA_ ; echo env_probe_done\n").unwrap();
    let seen = wait_for(&buf, "env_probe_done", 10);
    assert!(!seen.contains("leaked-team"), "CHIMERA_TEAM leaked into the shell: {seen}");
    close_session(&state, &id).unwrap();
    std::env::remove_var("CHIMERA_TEAM");
}

#[test]
fn missing_cwd_falls_back_instead_of_failing() {
    let state = PtyState::default();
    let (id, _buf) = collect(&state, "/definitely/not/a/real/dir/xyz");
    assert!(!id.is_empty());
    close_session(&state, &id).unwrap();
}

#[test]
fn session_cap_is_enforced() {
    let state = PtyState::default();
    let mut ids = Vec::new();
    for _ in 0..MAX_SESSIONS {
        let (id, _b) = collect(&state, env!("CARGO_MANIFEST_DIR"));
        ids.push(id);
    }
    let over = open_session(&state, env!("CARGO_MANIFEST_DIR").to_string(), 80, 24, |_| {});
    assert!(over.is_err(), "expected the {MAX_SESSIONS}-session cap to reject the next open");
    for id in ids {
        close_session(&state, &id).unwrap();
    }
}
