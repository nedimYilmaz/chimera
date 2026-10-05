#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chimera_app::{commands, computer_use, daemon, desktop_runtime, meeting_speech, pty};
use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        // W6 packaging: single-instance MUST register first (plugin docs) —
        // a second launch focuses the existing main window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        // W6: OS-viewer opens for transcript images (commands::open_image).
        .plugin(tauri_plugin_opener::init())
        // CWD-PICKER: native folder/file picker (PathPicker.tsx's
        // @tauri-apps/plugin-dialog `open()` call; dialog:default in
        // capabilities/default.json).
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            let desktop_resources = resources.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = desktop_runtime::start(&resources, &daemon::chimera_home(), &std::env::args().skip(1).collect::<Vec<_>>()) {
                    eprintln!("Chimera startup: {error}");
                }
            });
            // The daemon client outlives every window: spawned once onto the
            // Tauri (tokio) runtime, exposed to commands as managed State, and
            // fanned out to the webview as `daemon://state` / `daemon://event`.
            let socket = daemon::resolve_socket_path(std::env::args().skip(1));
            let state_app = app.handle().clone();
            let event_app = app.handle().clone();
            let (handle, driver) = daemon::start(
                socket,
                daemon::Callbacks {
                    on_state: Box::new(move |s| {
                        let _ = state_app.emit("daemon://state", s.as_str());
                    }),
                    // NormalizedEvent JSON forwarded verbatim — @chimera/protocol
                    // stays the only wire-type authority; Rust never reshapes it.
                    on_event: Box::new(move |e| {
                        let _ = event_app.emit("daemon://event", &e);
                    }),
                },
            );
            tauri::async_runtime::spawn(driver);
            app.manage(handle);
            app.manage(pty::PtyState::default());
            let desktop = computer_use::ComputerUseState::with_resources(desktop_resources);
            app.manage(desktop.clone());
            let bundle_id = app.config().identifier.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let home = daemon::chimera_home();
                // Autostart only brings the driver back; the live view appears inside the controlling
                // agent's transcript, so there is deliberately no native window to open here.
                if let Err(error) = desktop.resume(&home, &bundle_id) { eprintln!("Chimera Computer Use: {error}"); }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            computer_use::computer_use_status,
            computer_use::computer_use_preview,
            computer_use::computer_use_start,
            computer_use::computer_use_stop,
            computer_use::computer_use_permissions,
            commands::rpc_call,
            commands::subscribe,
            commands::daemon_status,
            commands::dev_probe,
            commands::open_image,
            commands::read_artifact,
            commands::open_artifact,
            commands::open_artifact_url,
            commands::set_dock_badge,
            commands::write_export,
            commands::checkpoint_files_since,
            commands::open_in_terminal,
            pty::term_open,
            pty::term_open_command,
            pty::term_write,
            pty::term_close,
            pty::term_resize,
            meeting_speech::meeting_speech_start,
            meeting_speech::meeting_speech_append,
            meeting_speech::meeting_speech_finish,
            meeting_speech::meeting_speech_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building chimera")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) { app.state::<computer_use::ComputerUseState>().stop(); }
        });
}
