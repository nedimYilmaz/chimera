//! Integration tests for the daemon UDS client (src/daemon.rs) against a fake
//! chimerad speaking the exact wire protocol of packages/daemon/src/server.ts:
//! newline-delimited JSON frames, hello-first gating, one subscription per
//! connection, unsolicited event frames. No Tauri app involved — the client's
//! Callbacks fan out to plain channels, exercising the production code path.

#![cfg(unix)]

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::mpsc;

use chimera_app::daemon::{self, Callbacks, ConnState};

const WAIT: Duration = Duration::from_secs(5);

/// What the fake daemon observed from the client, in order. The Connected
/// marker lets tests assert hello-is-first per (re)connection.
#[derive(Debug)]
enum FromClient {
    Connected,
    Frame(Value),
}

/// A minimal chimerad stand-in: accepts connections sequentially, records
/// every request frame, auto-responds like server.ts would (hello ack,
/// subscribe ack, echo for everything else, a canned error for "boom"), and
/// writes arbitrary raw bytes on demand (for event frames and chunk-split
/// torture). kill() aborts the task and unlinks the socket, so the client
/// sees EOF then ENOENT — exactly a dead daemon.
struct FakeDaemon {
    path: PathBuf,
    from_client: mpsc::UnboundedReceiver<FromClient>,
    to_client: mpsc::UnboundedSender<Vec<u8>>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeDaemon {
    fn start(path: PathBuf) -> Self {
        let _ = std::fs::remove_file(&path); // stale socket from a previous run
        let listener = UnixListener::bind(&path).expect("bind fake daemon socket");
        let (from_tx, from_client) = mpsc::unbounded_channel();
        let (to_client, mut to_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let _ = from_tx.send(FromClient::Connected);
                let (read, mut write) = stream.into_split();
                let mut lines = BufReader::new(read).lines();
                loop {
                    tokio::select! {
                        line = lines.next_line() => {
                            let Ok(Some(line)) = line else { break }; // client gone; accept the next connection
                            let frame: Value = serde_json::from_str(&line).expect("client sent valid JSON");
                            let _ = from_tx.send(FromClient::Frame(frame.clone()));
                            let id = frame["id"].as_str().unwrap_or_default();
                            let reply = match frame["method"].as_str().unwrap_or_default() {
                                "daemon.hello" => json!({"id": id, "type": "response", "ok": true,
                                    "result": {"ok": true, "protocolVersion": 1, "engineId": "fake", "features": []}}),
                                "subscribe" => json!({"id": id, "type": "response", "ok": true, "result": {"ok": true}}),
                                "boom" => json!({"id": id, "type": "response", "ok": false,
                                    "error": {"code": "protocol", "message": "unknown method \"boom\""}}),
                                _ => json!({"id": id, "type": "response", "ok": true, "result": {"echo": frame["params"]}}),
                            };
                            let mut buf = serde_json::to_vec(&reply).unwrap();
                            buf.push(b'\n');
                            if write.write_all(&buf).await.is_err() { break; }
                        }
                        chunk = to_rx.recv() => {
                            let Some(chunk) = chunk else { return };
                            if write.write_all(&chunk).await.is_err() { break; }
                        }
                    }
                }
            }
        });

        Self { path, from_client, to_client, task }
    }

    fn send_frame(&self, frame: &Value) {
        let mut buf = serde_json::to_vec(frame).unwrap();
        buf.push(b'\n');
        self.to_client.send(buf).expect("fake daemon task alive");
    }

    fn send_raw(&self, bytes: Vec<u8>) {
        self.to_client.send(bytes).expect("fake daemon task alive");
    }

    /// Simulate the daemon dying: drop the listener + live connection (EOF at
    /// the client) and unlink the socket (ENOENT on reconnect attempts).
    fn kill(self) -> PathBuf {
        self.task.abort();
        let _ = std::fs::remove_file(&self.path);
        self.path
    }

    async fn expect_connected(&mut self) {
        match tokio::time::timeout(WAIT, self.from_client.recv()).await {
            Ok(Some(FromClient::Connected)) => {}
            other => panic!("expected a client connection, got {other:?}"),
        }
    }

    async fn expect_frame(&mut self) -> Value {
        match tokio::time::timeout(WAIT, self.from_client.recv()).await {
            Ok(Some(FromClient::Frame(f))) => f,
            other => panic!("expected a frame from the client, got {other:?}"),
        }
    }
}

/// Spawn the production client wired to channel-backed callbacks.
fn start_client(
    path: PathBuf,
) -> (daemon::DaemonHandle, mpsc::UnboundedReceiver<ConnState>, mpsc::UnboundedReceiver<Value>) {
    let (state_tx, state_rx) = mpsc::unbounded_channel();
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let (handle, driver) = daemon::start(
        path,
        Callbacks {
            on_state: Box::new(move |s| {
                let _ = state_tx.send(s);
            }),
            on_event: Box::new(move |e| {
                let _ = event_tx.send(e);
            }),
        },
    );
    tokio::spawn(driver);
    (handle, state_rx, event_rx)
}

async fn expect_state(rx: &mut mpsc::UnboundedReceiver<ConnState>, want: ConnState) {
    loop {
        match tokio::time::timeout(WAIT, rx.recv()).await {
            Ok(Some(s)) if s == want => return,
            Ok(Some(_)) => continue, // intermediate transition (e.g. Disconnected at cap)
            other => panic!("expected state {want:?}, got {other:?}"),
        }
    }
}

fn sock_in(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("d.sock")
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn hello_first_then_rpc_roundtrip_and_error_shape() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = FakeDaemon::start(sock_in(&dir));
    let (handle, mut state_rx, _events) = start_client(sock_in(&dir));

    server.expect_connected().await;
    let first = server.expect_frame().await;
    assert_eq!(first["type"], "request");
    assert_eq!(first["method"], "daemon.hello", "hello must be the FIRST frame");
    assert_eq!(first["params"]["protocolVersion"], 1);

    expect_state(&mut state_rx, ConnState::Connected).await;

    // round-trip: the daemon's result comes back verbatim
    let result = handle.call("daemon.status".into(), json!({"probe": 1})).await.unwrap();
    assert_eq!(result, json!({"echo": {"probe": 1}}));

    // daemon-side errors surface with the daemon's own {code,message} shape
    let err = handle.call("boom".into(), json!({})).await.unwrap_err();
    assert_eq!(err.code, "protocol");
    assert!(err.message.contains("unknown method"));
}

#[tokio::test]
async fn event_frames_reach_the_event_callback() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = FakeDaemon::start(sock_in(&dir));
    let (_handle, mut state_rx, mut events) = start_client(sock_in(&dir));

    server.expect_connected().await;
    let _hello = server.expect_frame().await;
    expect_state(&mut state_rx, ConnState::Connected).await;

    let event = json!({
        "ts": 1e12, "seq": 7, "engineId": "local", "agentId": "a1",
        "kind": "agent_message", "data": {"text": "hi"}
    });
    server.send_frame(&json!({"type": "event", "event": event}));

    let got = tokio::time::timeout(WAIT, events.recv()).await.unwrap().unwrap();
    assert_eq!(got, event, "NormalizedEvent JSON must surface verbatim");
}

#[tokio::test]
async fn reconnect_re_sends_hello_and_re_applies_subscribe() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = FakeDaemon::start(sock_in(&dir));
    let (handle, mut state_rx, _events) = start_client(sock_in(&dir));

    server.expect_connected().await;
    let _hello = server.expect_frame().await;
    expect_state(&mut state_rx, ConnState::Connected).await;

    handle.subscribe(json!({"agentId": "a1"})).await.unwrap();
    let sub = server.expect_frame().await;
    assert_eq!(sub["method"], "subscribe");
    assert_eq!(sub["params"], json!({"agentId": "a1"}));

    // daemon dies → the client must report Reconnecting
    let path = server.kill();
    expect_state(&mut state_rx, ConnState::Reconnecting).await;

    // daemon comes back → Connected again, hello FIRST, then the remembered
    // subscribe filter re-applied without any caller involvement
    let mut server = FakeDaemon::start(path);
    server.expect_connected().await;
    expect_state(&mut state_rx, ConnState::Connected).await;

    let hello2 = server.expect_frame().await;
    assert_eq!(hello2["method"], "daemon.hello", "hello must lead every reconnection");
    let resub = server.expect_frame().await;
    assert_eq!(resub["method"], "subscribe");
    assert_eq!(resub["params"], json!({"agentId": "a1"}), "filter survives the reconnect");
}

#[tokio::test]
async fn chunk_split_utf8_frame_parses_whole() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = FakeDaemon::start(sock_in(&dir));
    let (_handle, mut state_rx, mut events) = start_client(sock_in(&dir));

    server.expect_connected().await;
    let _hello = server.expect_frame().await;
    expect_state(&mut state_rx, ConnState::Connected).await;

    // A frame whose bytes we cut INSIDE a multi-byte character, delivered as
    // two writes with a pause — the client must reassemble before decoding
    // (the StringDecoder class of bug in client.ts/server.ts).
    let text = "günaydın 🦄 — çok iyi";
    let event = json!({
        "ts": 1e12, "seq": 8, "engineId": "local", "agentId": "a1",
        "kind": "agent_message", "data": {"text": text}
    });
    let mut bytes = serde_json::to_vec(&json!({"type": "event", "event": event})).unwrap();
    bytes.push(b'\n');
    let line = String::from_utf8(bytes.clone()).unwrap();
    let mut cut = line.find('🦄').expect("emoji present") + 2; // inside the 4-byte scalar
    assert!(!line.is_char_boundary(cut), "cut must land mid-character");
    while cut >= bytes.len() {
        cut -= 1;
    }
    server.send_raw(bytes[..cut].to_vec());
    tokio::time::sleep(Duration::from_millis(80)).await;
    server.send_raw(bytes[cut..].to_vec());

    let got = tokio::time::timeout(WAIT, events.recv()).await.unwrap().unwrap();
    assert_eq!(got, event);
    assert_eq!(got["data"]["text"], text);
}
