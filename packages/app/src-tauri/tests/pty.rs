use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chimera_app::pty::{
    close_session, open_session, write_session, PtyMsg, PtyState, MAX_SESSIONS,
};

#[cfg(unix)]
use chimera_app::pty::resize_session;

#[derive(Default, Debug)]
struct Observed {
    bytes: Vec<u8>,
    exit: Option<Option<i32>>,
}

struct TestSession<'a> {
    state: &'a PtyState,
    id: String,
    observed: Arc<Mutex<Observed>>,
    cursor_replies: usize,
}

impl TestSession<'_> {
    fn write(&self, input: &str) {
        write_session(self.state, &self.id, input).expect("input is written");
    }

    fn wait_for(&mut self, needle: &str, secs: u64) -> String {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let (seen, requests, exited) = {
                let observed = self.observed.lock().unwrap();
                (String::from_utf8_lossy(&observed.bytes).to_string(),
                 observed.bytes.windows(4).filter(|bytes| *bytes == b"\x1b[6n").count(),
                 observed.exit.is_some())
            };
            // The app's xterm does this via onData. ConPTY's INHERIT_CURSOR handshake
            // needs the same reply here; counting over all bytes handles split reads.
            while self.cursor_replies < requests {
                self.write("\x1b[1;1R");
                self.cursor_replies += 1;
            }
            if seen.contains(needle) || exited || Instant::now() >= deadline {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn diagnostics(&self) -> String {
        let observed = self.observed.lock().unwrap();
        format!("output={:?}, exit={:?}, cursor replies={}",
            String::from_utf8_lossy(&observed.bytes), observed.exit, self.cursor_replies)
    }
}

impl Drop for TestSession<'_> {
    fn drop(&mut self) {
        // Assertion failures must release the child and its slot too.
        let _ = close_session(self.state, &self.id);
    }
}

fn collect<'a>(state: &'a PtyState, cwd: &str) -> TestSession<'a> {
    let observed = Arc::new(Mutex::new(Observed::default()));
    let sink_observed = observed.clone();
    let id = open_session(state, cwd.to_string(), 80, 24, move |msg: PtyMsg| {
        let mut observed = sink_observed.lock().unwrap();
        match msg {
            PtyMsg::Output { b64 } => {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
                observed.bytes.extend_from_slice(&bytes);
            }
            PtyMsg::Exit { code } => observed.exit = Some(code),
        }
    }).expect("session opens");
    #[allow(unused_mut)]
    let mut session = TestSession { state, id, observed, cursor_replies: 0 };
    #[cfg(windows)]
    {
        // Complete the terminal handshake before submitting shell input: it must not
        // be consumed while ConPTY is waiting for a cursor-position response.
        session.wait_for("\x1b[6n", 10);
        assert!(session.cursor_replies > 0, "ConPTY startup: {}", session.diagnostics());
    }
    session
}

const MARKER: &str = "chimera_marker";

fn marker_commands() -> Vec<&'static str> {
    #[cfg(windows)]
    { vec!["set chimera_probe=marker\r", "echo chimera_%chimera_probe%\r"] }
    #[cfg(not(windows))]
    { vec!["printf '%s%s\\n' chimera_ marker\r"] }
}

#[test]
fn echo_roundtrips_through_the_pty() {
    let state = PtyState::default();
    let mut session = collect(&state, env!("CARGO_MANIFEST_DIR"));
    for command in marker_commands() { session.write(command); }
    let seen = session.wait_for(MARKER, 10);
    assert!(seen.contains(MARKER), "pty roundtrip: {}", session.diagnostics());
}

#[test]
#[cfg(unix)]
fn resize_is_visible_to_the_shell() {
    let state = PtyState::default();
    let mut session = collect(&state, env!("CARGO_MANIFEST_DIR"));
    // An executed probe separates shell startup from the SIGWINCH/size check.
    session.write("printf '%s%s\\n' chimera_ ready\r");
    let ready = session.wait_for("chimera_ready", 10);
    assert!(ready.contains("chimera_ready"), "shell startup: {}", session.diagnostics());
    resize_session(&state, &session.id, 120, 40).unwrap();
    session.write("printf 'size=%s,%s\\n' \"$(tput cols)\" \"$(tput lines)\"\r");
    let seen = session.wait_for("size=120,40", 10);
    assert!(seen.contains("size=120,40"), "expected 120 columns and 40 rows: {}", session.diagnostics());
}

#[test]
#[cfg(unix)]
fn child_environment_has_no_chimera_vars() {
    struct RestoreTeam(Option<std::ffi::OsString>);
    impl Drop for RestoreTeam {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("CHIMERA_TEAM", value),
                None => std::env::remove_var("CHIMERA_TEAM"),
            }
        }
    }
    let _restore = RestoreTeam(std::env::var_os("CHIMERA_TEAM"));
    std::env::set_var("CHIMERA_TEAM", "leaked-team");
    let state = PtyState::default();
    let mut session = collect(&state, env!("CARGO_MANIFEST_DIR"));
    session.write("printf '\\nchimera_count=%s\\n' \"$(env | grep -c '^CHIMERA_')\"; printf '%s%s\\n' env_probe_ done\r");
    let seen = session.wait_for("env_probe_done", 10);
    assert!(seen.contains("env_probe_done"), "environment probe did not execute: {}", session.diagnostics());
    assert!(seen.lines().any(|line| line.trim_end_matches('\r') == "chimera_count=0"),
        "expected no CHIMERA_ variables in the shell: {}", session.diagnostics());
}

#[test]
fn missing_cwd_falls_back_instead_of_failing() {
    let state = PtyState::default();
    let session = collect(&state, "/definitely/not/a/real/dir/xyz");
    assert!(!session.id.is_empty());
}

#[test]
fn session_cap_is_enforced() {
    let state = PtyState::default();
    let mut sessions = Vec::new();
    for _ in 0..MAX_SESSIONS {
        sessions.push(collect(&state, env!("CARGO_MANIFEST_DIR")));
    }
    let over = open_session(&state, env!("CARGO_MANIFEST_DIR").to_string(), 80, 24, |_| {});
    assert!(over.is_err(), "expected the {MAX_SESSIONS}-session cap to reject the next open");
}

#[test]
fn echoed_marker_commands_are_not_roundtrip_output() {
    // Negative control: input echo alone satisfied the old oracle.
    assert!("echo chimera_marker\n".contains(MARKER));
    assert!(!marker_commands().join("").contains(MARKER));
}
