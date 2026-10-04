//! UDS JSON-RPC client to chimerad — the Rust twin of `packages/client/src/client.ts`.
//!
//! Wire protocol (mirrors `packages/daemon/src/server.ts` exactly):
//!   - newline-delimited JSON frames over a Unix socket
//!   - request  {id, type:"request", method, params}
//!   - response {id, type:"response", ok, result? | error:{code,message}}
//!   - events arrive unsolicited as {type:"event", event: NormalizedEvent}
//!   - `daemon.hello {protocolVersion}` MUST be the first frame on every
//!     (re)connection; the server rejects a version mismatch with {code:"protocol"}.
//!
//! Architecture: one long-lived driver task owns the socket and all connection
//! state (pending map, subscribe filter, backoff). The rest of the app talks to
//! it through a cheap cloneable `DaemonHandle` (mpsc commands + watch state).
//! Nothing here touches Tauri — state/event fan-out goes through injected
//! `Callbacks`, so the integration tests drive the exact production code path
//! against a fake daemon with plain tokio channels.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream as LocalStream;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient as LocalStream};
type OwnedReadHalf = tokio::io::ReadHalf<LocalStream>;
type OwnedWriteHalf = tokio::io::WriteHalf<LocalStream>;

async fn connect_local(path: &PathBuf) -> std::io::Result<LocalStream> {
    #[cfg(unix)]
    { LocalStream::connect(path).await }
    #[cfg(windows)]
    { ClientOptions::new().open(path) }
}
use tokio::sync::{mpsc, oneshot, watch};

/// Must match `PROTOCOL_VERSION` in `packages/protocol/src/index.ts`.
pub const PROTOCOL_VERSION: u64 = 1;

/// How long a single INTERACTIVE RPC round-trip may take before the caller gets
/// a {code:"timeout"} error (per PLAN §2). This is the budget for calls a human
/// is watching a spinner for; exceeding it means something is wrong, not slow.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// RPC-TIMEOUT-CLASSES: the budget for calls that are EXPECTED to be slow —
/// bulk export, a full re-index, an import. One uniform 30s made these fail on
/// a healthy daemon; raising 30s globally instead would have been the wrong
/// trade, because then a genuinely DEAD daemon takes this long to be reported
/// and the disconnected banner is the only signal the user gets in between.
const LONG_CALL_TIMEOUT: Duration = Duration::from_secs(300);

/// Verbs whose work is inherently bulk. Matched on the method's SUFFIX rather
/// than an enumerated method list: a list of "the slow methods" is exactly the
/// kind of restated set that rots silently the next time one is added, and the
/// failure mode is a spurious timeout on a working daemon.
const LONG_CALL_SUFFIXES: [&str; 6] = [".export", ".reindex", ".rebuild", ".import", ".backfill", ".compact"];

/// The client-side deadline for one call.
///
/// A caller that passes its OWN `timeoutMs` has already stated how long it is
/// willing to wait (`agent.wait` takes up to 300s) — honour that plus a margin
/// for the round trip, instead of cutting it off at our own 30s and reporting a
/// timeout the server was never given the chance to hit. This is what keeps the
/// two deadlines from contradicting each other as either side changes.
fn call_timeout_for(method: &str, params: &Value) -> Duration {
    // Two bounded npm phases (resolve lockfile, then install) can each take 90s.
    if method == "mcpstore.package.install" {
        return LONG_CALL_TIMEOUT;
    }
    // A manual provider switch can spend 90 seconds compacting the source session.
    if method == "agent.setAccount" || (method == "agent.reconfigure" && params.get("patch").and_then(|p| p.get("account")).is_some()) {
        return LONG_CALL_TIMEOUT;
    }
    if let Some(ms) = params.get("timeoutMs").and_then(Value::as_u64) {
        return Duration::from_millis(ms) + Duration::from_secs(5);
    }
    if LONG_CALL_SUFFIXES.iter().any(|suffix| method.ends_with(suffix)) {
        return LONG_CALL_TIMEOUT;
    }
    CALL_TIMEOUT
}
/// A daemon that accepts the socket but never acks hello is as good as dead;
/// give up on the attempt and let the backoff loop retry.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const BACKOFF_INITIAL: Duration = Duration::from_millis(250);
/// BOOT-LATENCY-RECONNECT: the retry interval's ceiling, DECOUPLED from the disconnected-banner
/// threshold below (they used to be the same 4s constant). A daemon restart is the common case,
/// not an outage, and a local UDS connect attempt costs essentially nothing — so keep retrying
/// briskly instead of parking for 4s and leaving the app blank for seconds after chimerad is
/// already listening.
const BACKOFF_CAP: Duration = Duration::from_secs(1);
/// How long the daemon must stay unreachable before the UI stops saying "reconnecting" and
/// shows the disconnected banner. Kept at the old effective value so a genuine outage still
/// reads the same to the user — only the retry cadence underneath it got faster.
const DISCONNECTED_AFTER: Duration = Duration::from_secs(4);

// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnState {
    Connected,
    Reconnecting,
    Disconnected,
}

impl ConnState {
    /// The literal strings the frontend bridge contract exposes ("connected" |
    /// "reconnecting" | "disconnected") — also the `daemon://state` payload.
    pub fn as_str(self) -> &'static str {
        match self {
            ConnState::Connected => "connected",
            ConnState::Reconnecting => "reconnecting",
            ConnState::Disconnected => "disconnected",
        }
    }
}

/// Serialized to the webview as {code, message} — the daemon's own error shape,
/// so JS error handling (e.g. the store's isUnknownMethod probe) works the same
/// whether the error came from chimerad or from this bridge.
#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    /// Same stable shape ChimeraClient (client.ts) settles in-flight requests
    /// with when the socket dies — consumers see one error regardless of UI.
    fn disconnected() -> Self {
        Self::new("disconnected", "chimerad connection closed")
    }
}

/// State/event fan-out injected by the embedder: main.rs forwards to Tauri
/// `emit`, the integration tests forward to channels. Keeping the driver free
/// of any Tauri type is what makes it testable without a running app.
pub struct Callbacks {
    pub on_state: Box<dyn Fn(ConnState) + Send + Sync>,
    /// Receives the NormalizedEvent JSON verbatim (the frame's `event` field).
    pub on_event: Box<dyn Fn(Value) + Send + Sync>,
}

enum Cmd {
    Call { method: String, params: Value, resp: oneshot::Sender<Result<Value, RpcError>> },
    Subscribe { filter: Value, resp: oneshot::Sender<Result<(), RpcError>> },
}

/// Cheap cloneable facade over the driver task. Managed as Tauri State.
#[derive(Clone)]
pub struct DaemonHandle {
    cmd_tx: mpsc::UnboundedSender<Cmd>,
    state_rx: watch::Receiver<ConnState>,
}

impl DaemonHandle {
    pub fn state(&self) -> ConnState {
        *self.state_rx.borrow()
    }

    pub async fn call(&self, method: String, params: Value) -> Result<Value, RpcError> {
        let (tx, rx) = oneshot::channel();
        let budget = call_timeout_for(&method, &params);
        self.cmd_tx
            .send(Cmd::Call { method, params, resp: tx })
            .map_err(|_| RpcError::disconnected())?;
        match tokio::time::timeout(budget, rx).await {
            Ok(Ok(result)) => result,
            // The driver dropped our sender: the connection died mid-call.
            Ok(Err(_)) => Err(RpcError::disconnected()),
            // The budget is in the message: a "timed out after 30s" that is a lie
            // once the budget varies is worse than no number at all.
            Err(_) => Err(RpcError::new("timeout", &format!("rpc call timed out after {}s", budget.as_secs()))),
        }
    }

    /// Stores the filter as "the" subscription (the daemon keeps exactly one
    /// per connection — server.ts replaces it on re-subscribe) and applies it
    /// if currently connected. While disconnected this resolves Ok: the driver
    /// re-applies the last filter right after every reconnect hello.
    pub async fn subscribe(&self, filter: Value) -> Result<(), RpcError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(Cmd::Subscribe { filter, resp: tx })
            .map_err(|_| RpcError::disconnected())?;
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::disconnected()),
            Err(_) => Err(RpcError::new("timeout", "subscribe timed out after 30s")),  // always the interactive budget: this is handshake, never bulk
        }
    }
}

/// Build the client: returns the handle plus the driver future the embedder
/// spawns onto its runtime (tauri::async_runtime in main.rs, tokio::spawn in
/// tests). The driver runs until every handle is dropped.
pub fn start(
    socket_path: PathBuf,
    callbacks: Callbacks,
) -> (DaemonHandle, impl Future<Output = ()> + Send + 'static) {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    // Start in Reconnecting (we are actively attempting) — the UI shows the
    // amber chip rather than flashing the scary disconnected banner during the
    // few ms a healthy startup takes. Degrades to Disconnected at backoff cap.
    let (state_tx, state_rx) = watch::channel(ConnState::Reconnecting);
    let handle = DaemonHandle { cmd_tx, state_rx };
    (handle, drive(socket_path, callbacks, cmd_rx, state_tx))
}

// ---------------------------------------------------------------------------
// driver internals

/// Globally-unique-enough frame ids: the daemon only echoes them back for
/// correlation, so pid+counter suffices (client.ts uses a bare counter).
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn next_id() -> String {
    format!("app-{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn set_state(state_tx: &watch::Sender<ConnState>, callbacks: &Callbacks, next: ConnState) {
    // Emit only on transition — reconnect attempts at the backoff cap would
    // otherwise spam identical "disconnected" events every 4s.
    let changed = state_tx.send_if_modified(|cur| {
        if *cur != next {
            *cur = next;
            true
        } else {
            false
        }
    });
    if changed {
        (callbacks.on_state)(next);
    }
}

fn request_frame(id: &str, method: &str, params: &Value) -> Value {
    json!({ "id": id, "type": "request", "method": method, "params": params })
}

fn parse_error(err: Option<&Value>) -> RpcError {
    RpcError {
        code: err
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("error")
            .to_string(),
        message: err
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("daemon error")
            .to_string(),
    }
}

async fn write_frame(write: &mut OwnedWriteHalf, frame: &Value) -> std::io::Result<()> {
    // Value serialization is infallible; the newline is the frame delimiter.
    let mut line = serde_json::to_vec(frame).expect("serde_json::Value always serializes");
    line.push(b'\n');
    write.write_all(&line).await
}

/// Reader half: one line = one frame. `next_line` accumulates bytes until the
/// delimiter and only then UTF-8-validates, so a multi-byte character split
/// across socket chunks parses whole (the StringDecoder fix in client.ts /
/// server.ts, for free). Ends (dropping `frame_tx`) on EOF or socket error,
/// which is how the connection loop learns the daemon went away.
async fn read_frames(read: OwnedReadHalf, frame_tx: mpsc::Sender<Value>) {
    const MAX_FRAME_BYTES: u64 = 32 * 1024 * 1024;
    let mut reader = BufReader::new(read);
    loop {
        let mut line = Vec::new();
        match (&mut reader).take(MAX_FRAME_BYTES + 1).read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(n) if n as u64 > MAX_FRAME_BYTES => break,
            Ok(_) => {}
        }
        // A malformed frame is the daemon's bug, not a reason to tear down the
        // connection — skip it (JSON.parse in decodeFrames would throw; we log-and-live).
        if let Ok(frame @ Value::Object(_)) = serde_json::from_slice::<Value>(&line) {
            if frame_tx.send(frame).await.is_err() {
                break; // connection loop already gone
            }
        }
    }
}

enum End {
    /// Every DaemonHandle dropped — the driver should exit for good.
    HandlesDropped,
    /// Socket died (EOF/write error) or hello never acked; reconnect.
    Dropped { helloed: bool },
}

async fn drive(
    socket_path: PathBuf,
    callbacks: Callbacks,
    mut cmd_rx: mpsc::UnboundedReceiver<Cmd>,
    state_tx: watch::Sender<ConnState>,
) {
    let mut backoff = BACKOFF_INITIAL;
    // BOOT-LATENCY-RECONNECT: when the current unreachable stretch began (None = we are not in
    // one). Drives the disconnected banner on elapsed time rather than on the backoff ladder's
    // position, which is what let the two be tuned apart.
    let mut down_since: Option<Instant> = None;
    // The last subscribe filter survives reconnects — server-side subscriptions
    // die with the socket, so we must re-apply after every hello.
    let mut sub_filter: Option<Value> = None;

    loop {
        if let Ok(stream) = connect_local(&socket_path).await {
            match run_connection(stream, &callbacks, &mut cmd_rx, &mut sub_filter, &state_tx).await {
                End::HandlesDropped => return,
                End::Dropped { helloed } => {
                    // A completed handshake proves the daemon was healthy; start
                    // the retry ladder from the bottom. A refused hello (version
                    // mismatch, hang) keeps climbing instead — no hot loop
                    // against a daemon that will keep saying no.
                    if helloed {
                        backoff = BACKOFF_INITIAL;
                        down_since = None;
                    }
                }
            }
        }

        // Reconnecting while the outage is short; once it has lasted DISCONNECTED_AFTER the
        // daemon is genuinely gone — show the disconnected banner. We never stop retrying
        // either way, and the retry cadence (BACKOFF_CAP) is deliberately much tighter than
        // this threshold so a restarting daemon is picked up within a second of binding.
        let down_for = down_since.get_or_insert_with(Instant::now).elapsed();
        set_state(
            &state_tx,
            &callbacks,
            if down_for >= DISCONNECTED_AFTER { ConnState::Disconnected } else { ConnState::Reconnecting },
        );

        // Service commands during the wait: calls fail fast with the stable
        // disconnected error instead of queueing into a dead socket; subscribes
        // just record the filter for the next successful hello.
        let sleep = tokio::time::sleep(backoff);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                cmd = cmd_rx.recv() => match cmd {
                    None => return,
                    Some(Cmd::Call { resp, .. }) => { let _ = resp.send(Err(RpcError::disconnected())); }
                    Some(Cmd::Subscribe { filter, resp }) => {
                        sub_filter = Some(filter);
                        let _ = resp.send(Ok(()));
                    }
                }
            }
        }
        backoff = (backoff * 2).min(BACKOFF_CAP);
    }
}

/// One connection's lifetime: hello handshake, subscribe re-apply, then the
/// steady-state pump (daemon frames one way, handle commands the other).
async fn run_connection(
    stream: LocalStream,
    callbacks: &Callbacks,
    cmd_rx: &mut mpsc::UnboundedReceiver<Cmd>,
    sub_filter: &mut Option<Value>,
    state_tx: &watch::Sender<ConnState>,
) -> End {
    let (read_half, mut write) = tokio::io::split(stream);
    // A dedicated reader task keeps the select loop cancel-safe (read_line is
    // not); its channel closing doubles as the disconnect signal.
    let (frame_tx, mut frame_rx) = mpsc::channel::<Value>(64);
    let reader = tokio::spawn(read_frames(read_half, frame_tx));

    let mut pending: HashMap<String, oneshot::Sender<Result<Value, RpcError>>> = HashMap::new();
    let mut helloed = false;
    // The re-applied subscribe's ack is nobody's await — tracked only so its
    // response isn't mistaken for a pending call's.
    let mut resub_id: Option<String> = None;

    // hello MUST be the first frame on the wire (server.ts gates the version
    // there). Later frames may be written before its ack arrives — the daemon
    // dispatches in order, so ordering, not round-trip, is the invariant.
    let hello_id = next_id();
    let hello =
        request_frame(&hello_id, "daemon.hello", &json!({ "protocolVersion": PROTOCOL_VERSION }));
    if write_frame(&mut write, &hello).await.is_err() {
        reader.abort();
        return End::Dropped { helloed: false };
    }

    let hello_deadline = tokio::time::sleep(HELLO_TIMEOUT);
    tokio::pin!(hello_deadline);

    let end = loop {
        tokio::select! {
            _ = &mut hello_deadline, if !helloed => break End::Dropped { helloed: false },

            frame = frame_rx.recv() => {
                let Some(frame) = frame else { break End::Dropped { helloed } }; // reader saw EOF/error
                match frame.get("type").and_then(Value::as_str) {
                    Some("event") => {
                        if let Some(event) = frame.get("event") {
                            (callbacks.on_event)(event.clone());
                        }
                    }
                    Some("response") => {
                        let id = frame.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                        let ok = frame.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        if id == hello_id {
                            // Version mismatch ({code:"protocol"}): drop and let the
                            // backoff ladder retry — a daemon restart onto our version
                            // heals this without an app restart.
                            if !ok { break End::Dropped { helloed: false }; }
                            helloed = true;
                            set_state(state_tx, callbacks, ConnState::Connected);
                            if let Some(filter) = sub_filter.clone() {
                                let id = next_id();
                                if write_frame(&mut write, &request_frame(&id, "subscribe", &filter)).await.is_err() {
                                    break End::Dropped { helloed: true };
                                }
                                resub_id = Some(id);
                            }
                        } else if resub_id.as_deref() == Some(id.as_str()) {
                            resub_id = None; // ack of the auto re-subscribe; nothing awaits it
                        } else if let Some(resp) = pending.remove(&id) {
                            let result = if ok {
                                Ok(frame.get("result").cloned().unwrap_or(Value::Null))
                            } else {
                                Err(parse_error(frame.get("error")))
                            };
                            let _ = resp.send(result);
                        }
                    }
                    _ => {} // requests never flow daemon→client; ignore unknown frame types
                }
            }

            cmd = cmd_rx.recv() => match cmd {
                None => break End::HandlesDropped,
                Some(Cmd::Call { method, params, resp }) => {
                    // Sweep entries whose caller already timed out (their 30s
                    // race dropped the receiver) so the map can't grow without
                    // bound across a long-lived connection.
                    pending.retain(|_, tx| !tx.is_closed());
                    let id = next_id();
                    if write_frame(&mut write, &request_frame(&id, &method, &params)).await.is_err() {
                        let _ = resp.send(Err(RpcError::disconnected()));
                        break End::Dropped { helloed };
                    }
                    pending.insert(id, resp);
                }
                Some(Cmd::Subscribe { filter, resp }) => {
                    *sub_filter = Some(filter.clone());
                    let id = next_id();
                    if write_frame(&mut write, &request_frame(&id, "subscribe", &filter)).await.is_err() {
                        let _ = resp.send(Err(RpcError::disconnected()));
                        break End::Dropped { helloed };
                    }
                    // Adapt the () ack the handle wants to the Value response the
                    // pending map carries.
                    let (vtx, vrx) = oneshot::channel::<Result<Value, RpcError>>();
                    pending.insert(id, vtx);
                    tokio::spawn(async move {
                        let _ = resp.send(match vrx.await {
                            Ok(Ok(_)) => Ok(()),
                            Ok(Err(e)) => Err(e),
                            Err(_) => Err(RpcError::disconnected()),
                        });
                    });
                }
            }
        }
    };

    reader.abort();
    // Settle every in-flight request with the stable disconnected shape instead
    // of leaving callers to hang until their 30s timeout (mirrors client.ts).
    for (_, tx) in pending.drain() {
        let _ = tx.send(Err(RpcError::disconnected()));
    }
    end
}

// ---------------------------------------------------------------------------

/// Socket path precedence per PLAN §2: `--socket <path>` (or `--socket=<path>`)
/// CLI arg, else `$CHIMERA_HOME/daemon.sock`, else `~/.chimera/daemon.sock`
/// (matches chimeraHome() in packages/core/src/paths.ts).
pub fn resolve_socket_path(args: impl Iterator<Item = String>) -> PathBuf {
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        if arg == "--socket" {
            if let Some(path) = args.next() {
                return PathBuf::from(path);
            }
        } else if let Some(path) = arg.strip_prefix("--socket=") {
            return PathBuf::from(path);
        }
    }
    if let Ok(home) = std::env::var("CHIMERA_HOME") {
        if !home.is_empty() {
            return endpoint_for_home(PathBuf::from(home));
        }
    }
    endpoint_for_home(dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".chimera"))
}

fn endpoint_for_home(home: PathBuf) -> PathBuf {
    #[cfg(unix)]
    { home.join("daemon.sock") }
    #[cfg(windows)]
    {
        let normalized = home.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in normalized.as_bytes() {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
        PathBuf::from(format!(r"\\.\pipe\chimera-{hash:016x}"))
    }
}

/// F17 (W19): `$CHIMERA_HOME` or `~/.chimera` — matches chimeraHome() in
/// packages/core/src/paths.ts exactly (no `--socket` override here: that flag
/// only relocates the daemon.sock file, not the coordination-state home the
/// artifact snapshots live under). Used to resolve `${home}/artifacts/<id>`
/// for the artifact preview/OS-open commands below.
pub fn chimera_home() -> PathBuf {
    if let Ok(home) = std::env::var("CHIMERA_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".chimera")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // RPC-TIMEOUT-CLASSES — one uniform 30s budget made calls that are SUPPOSED to
    // take minutes (a full re-index, a bulk export) fail against a perfectly healthy
    // daemon. These pin the three-way split, and specifically pin that the fix was
    // NOT "raise 30s globally" — an interactive call still gives up in 30s so a dead
    // daemon is reported promptly.
    #[test]
    fn interactive_calls_keep_the_thirty_second_budget() {
        assert_eq!(call_timeout_for("agent.spawn", &json!({})), Duration::from_secs(30));
        assert_eq!(call_timeout_for("queue.push", &json!({"text": "x"})), Duration::from_secs(30));
        assert_eq!(call_timeout_for("chronicle.search", &json!({"query": "q"})), Duration::from_secs(30));
    }

    #[test]
    fn bulk_verbs_get_the_long_budget() {
        assert_eq!(call_timeout_for("mcpstore.package.install", &json!({})), Duration::from_secs(300));
        for method in ["chronicle.reindex", "events.export", "memory.rebuild", "vault.import", "index.backfill", "agent.compact"] {
            assert_eq!(call_timeout_for(method, &json!({})), Duration::from_secs(300), "{method}");
        }
    }

    #[test]
    fn provider_context_transfers_get_the_long_budget() {
        assert_eq!(call_timeout_for("agent.setAccount", &json!({"account": "codex"})), Duration::from_secs(300));
        assert_eq!(call_timeout_for("agent.reconfigure", &json!({"patch": {"account": "codex"}})), Duration::from_secs(300));
        assert_eq!(call_timeout_for("agent.reconfigure", &json!({"patch": {"model": "opus"}})), Duration::from_secs(30));
    }

    #[test]
    fn a_caller_supplied_timeout_wins_over_our_own() {
        // agent.wait takes up to 300s; cutting it off at our 30s reported a timeout
        // the server was never given the chance to hit.
        assert_eq!(call_timeout_for("agent.wait", &json!({"timeoutMs": 300_000})), Duration::from_secs(305));
        // and it wins in the other direction too — a caller asking for 2s gets 2s
        // (+ the round-trip margin), not a silent 30s floor.
        assert_eq!(call_timeout_for("agent.wait", &json!({"timeoutMs": 2_000})), Duration::from_secs(7));
    }

    #[test]
    fn a_non_numeric_timeout_param_falls_back_instead_of_panicking() {
        assert_eq!(call_timeout_for("agent.wait", &json!({"timeoutMs": "soon"})), Duration::from_secs(30));
        assert_eq!(call_timeout_for("agent.wait", &json!({"timeoutMs": -1})), Duration::from_secs(30));
    }

    #[test]
    fn the_suffix_match_is_anchored_at_the_end() {
        // "export" as a NAMESPACE is not a bulk verb; only ".export" as the verb is.
        assert_eq!(call_timeout_for("export.status", &json!({})), Duration::from_secs(30));
    }
}
