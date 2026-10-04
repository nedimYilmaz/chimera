//! Native Windows transport gate. Run on Windows; no TCP fallback or live daemon.
#![cfg(windows)]

use chimera_app::daemon::{self, Callbacks, ConnState};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ServerOptions;

#[tokio::test]
async fn named_pipe_hello_and_rpc_roundtrip() {
    let path = PathBuf::from(format!(r"\\.\pipe\chimera-test-{}", std::process::id()));
    let server = ServerOptions::new().first_pipe_instance(true).create(&path).unwrap();
    let fake = tokio::spawn(async move {
        server.connect().await.unwrap();
        let (read, mut write) = tokio::io::split(server);
        let mut lines = BufReader::new(read).lines();
        let hello: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(hello["method"], "daemon.hello");
        let ack = json!({"id": hello["id"], "type": "response", "ok": true, "result": {"protocolVersion": 1}});
        write.write_all(format!("{ack}\n").as_bytes()).await.unwrap();
        let request: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(request["method"], "daemon.status");
        let response = json!({"id": request["id"], "type": "response", "ok": true, "result": {"transport": "named-pipe"}});
        write.write_all(format!("{response}\n").as_bytes()).await.unwrap();
        // Keep the stream open until the client is dropped.
        let _ = lines.next_line().await;
    });
    let (state_tx, mut states) = tokio::sync::mpsc::unbounded_channel();
    let (handle, driver) = daemon::start(path, Callbacks { on_state: Box::new(move |state| { let _ = state_tx.send(state); }), on_event: Box::new(|_| {}) });
    let driver = tokio::spawn(driver);
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(state) = states.recv().await {
            if state == ConnState::Connected { return; }
        }
        panic!("client stopped before hello");
    }).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), handle.call("daemon.status".into(), json!({}))).await.unwrap().unwrap();
    assert_eq!(result["transport"], "named-pipe");
    drop(handle);
    tokio::time::timeout(Duration::from_secs(5), driver).await.unwrap().unwrap();
    fake.abort();
}
