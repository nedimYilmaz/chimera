//! Native file actions use the daemon's existing project-root authorization.
//! Only media receives an exact-file asset grant; scripts/unknown files can be
//! revealed in the file manager, never executed by the generic open action.
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;
use crate::daemon::DaemonHandle;

fn checked_path(requested: &str, result: &Value) -> Result<PathBuf, String> {
    let path = Path::new(requested);
    if !path.is_absolute() || result["absolutePath"].as_str() != Some(requested) {
        return Err("File is not an authorized local path. Refresh and reopen the file.".into());
    }
    // Node's realpath uses ordinary drive/UNC paths on Windows, whereas Rust's
    // canonicalize adds a verbatim prefix. Compare normalized canonical forms.
    let canonical = dunce::canonicalize(path).map_err(|e| e.to_string())?;
    if canonical != dunce::simplified(path) || !canonical.is_file() {
        return Err("File moved or changed. Refresh and reopen the file.".into());
    }
    Ok(canonical)
}

async fn authorize(state: &DaemonHandle, path: &str) -> Result<(PathBuf, Value), String> {
    let result = state.call("fs.read".into(), json!({"path": path})).await
        .map_err(|e| e.message)?;
    Ok((checked_path(path, &result)?, result))
}

fn media_extension(path: &Path) -> bool {
    matches!(extension(path).as_str(), "mp4" | "m4v" | "mov" | "webm" | "ogv" | "mkv" | "avi" |
        "mp3" | "m4a" | "aac" | "wav" | "ogg" | "opus" | "flac")
}

fn extension(path: &Path) -> String {
    path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn document_extension(path: &Path) -> bool {
    media_extension(path) || matches!(extension(path).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" |
        "pdf" | "txt" | "md" | "csv" | "json" | "xml" | "rtf" |
        "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp" |
        "pages" | "numbers" | "key" | "psd" | "blend")
}

#[tauri::command]
pub async fn prepare_local_media(app: tauri::AppHandle, state: State<'_, DaemonHandle>, path: String) -> Result<String, String> {
    let (file, result) = authorize(&state, &path).await?;
    let mime = result["mediaType"].as_str().unwrap_or("");
    if !media_extension(&file) || !(mime.starts_with("video/") || mime.starts_with("audio/")) {
        return Err("This file cannot be played here. Open it in its default app.".into());
    }
    // Empty initial scope, exact canonical file only (no parent directories or
    // globs). Tauri's asset handler supports byte ranges for seeking and checks
    // the resolved path again on each request, including symlink replacements.
    app.asset_protocol_scope().allow_file(&file).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn open_local_file(app: tauri::AppHandle, state: State<'_, DaemonHandle>, path: String, reveal: bool) -> Result<(), String> {
    let (file, _) = authorize(&state, &path).await?;
    if reveal {
        app.opener().reveal_item_in_dir(file).map_err(|e| e.to_string())
    } else if document_extension(&file) {
        app.opener().open_path(file.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
    } else {
        Err("Use Show in folder to open this file with your preferred application.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_existing_authorized_files_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a movie #1.mp4");
        std::fs::write(&path, b"fixture").unwrap();
        let path = dunce::canonicalize(path).unwrap();
        let raw = path.to_str().unwrap();
        assert_eq!(checked_path(raw, &json!({"absolutePath": raw})).unwrap(), path);
        assert!(checked_path(raw, &json!({})).is_err());
        assert!(checked_path(raw, &json!({"absolutePath": "/different"})).is_err());
        assert!(checked_path("relative.mp4", &json!({"absolutePath": "relative.mp4"})).is_err());
        let directory = dir.path().canonicalize().unwrap();
        let directory = directory.to_str().unwrap();
        assert!(checked_path(directory, &json!({"absolutePath": directory})).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(checked_path(raw, &json!({"absolutePath": raw})).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn stale_file_replaced_with_symlink_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("clip.mp4");
        std::fs::write(&file, b"original").unwrap();
        let file = dunce::canonicalize(file).unwrap();
        let raw = file.to_str().unwrap();
        let other = dir.path().join("other.mp4");
        std::fs::write(&other, b"different").unwrap();
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(other, &file).unwrap();
        assert!(checked_path(raw, &json!({"absolutePath":raw})).is_err());
    }
    #[test]
    fn opens_documents_but_never_scripts_or_executables() {
        for name in ["movie.MP4", "voice.wav", "report.pdf", "slides.pptx", "sheet.xlsx"] {
            assert!(document_extension(Path::new(name)), "{name}");
        }
        for name in ["run.command", "run.sh", "run.exe", "run.bat", "run.desktop", "run.app", "run.js", "run", "page.html", "movie.mp4.exe"] {
            assert!(!document_extension(Path::new(name)), "{name}");
            assert!(!media_extension(Path::new(name)), "{name}");
        }
        assert!(!media_extension(Path::new("report.pdf")));
    }
}
