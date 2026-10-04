//! Library target so integration tests (tests/daemon_client.rs) can exercise
//! the daemon client without a running Tauri app; main.rs is a thin shell.

pub mod commands;
pub mod computer_use;
pub mod daemon;
pub mod desktop_runtime;
pub mod pty;
pub mod meeting_speech;

mod native_security;
