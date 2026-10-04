//! Filesystem and opener boundaries shared by the native commands and headless tests.
use std::path::Path;

pub fn open_artifact_url(url: &str, open: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    // Enforce this at the native boundary: artifact chips and direct IPC calls
    // do not pass through the inline Markdown link filter.
    let (scheme, rest) = url.split_once("://").ok_or("only http(s) artifact URLs are supported")?;
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        || rest.is_empty()
        || rest.starts_with(['/', '\\', '?', '#'])
        || url.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("only http(s) artifact URLs are supported".into());
    }
    open(url)
}

pub fn write_export(home: &Path, filename: &str, content: &str) -> Result<String, String> {
    let stem: String = filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .take(128)
        .collect();
    if stem.is_empty() || stem == "." || stem == ".." {
        return Err("invalid export filename".to_string());
    }
    let dir = home.join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Reject a preplanted directory link as well as destination links. The
    // application home and its ancestors remain operator-owned trusted paths.
    if std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?.file_type().is_symlink() {
        return Err("export directory must not be a symlink".into());
    }
    let path = dir.join(stem);
    // Exclusive creation atomically refuses existing files, symlinks and hard
    // links, rather than following a link and truncating its target.
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!("chimera-native-security-{}-{}-{}",
                std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn sec_001_external_schemes_never_reach_the_os_opener() {
        for url in ["file:///tmp/synthetic.command", "javascript:alert(1)", "data:text/html,x", "custom-app://execute", "/tmp/synthetic.command", "--help", "HTTPS://example.com\nfile:///tmp/x"] {
            let mut called = false;
            let result = open_artifact_url(url, |_| { called = true; Ok(()) });
            assert!(!called, "unsafe URL reached opener: {url}");
            assert!(result.is_err());
        }
    }

    #[test]
    fn http_urls_and_opener_errors_are_preserved() {
        for url in ["http://example.com", "https://example.com/a?x=1", "HTTPS://example.com"] {
            let result = open_artifact_url(url, |received| {
                assert_eq!(received, url);
                Err("synthetic opener error".into())
            });
            assert_eq!(result, Err("synthetic opener error".into()));
        }
    }

    #[test]
    #[cfg(unix)]
    fn sec_002_export_does_not_clobber_a_symlink_target() {
        let f = Fixture::new();
        let exports = f.0.join("exports");
        std::fs::create_dir(&exports).unwrap();
        let victim = f.0.join("synthetic-secret.txt");
        std::fs::write(&victim, "keep me").unwrap();
        std::os::unix::fs::symlink(&victim, exports.join("usage.csv")).unwrap();
        let result = write_export(&f.0, "usage.csv", "attacker bytes");
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep me");
        assert!(result.is_err());
    }

    #[test]
    #[cfg(unix)]
    fn export_rejects_directory_symlinks_and_hardlinked_destinations() {
        let f = Fixture::new();
        let outside = f.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let exports = f.0.join("exports");
        std::os::unix::fs::symlink(&outside, &exports).unwrap();
        assert!(write_export(&f.0, "usage.csv", "x").is_err());
        assert!(!outside.join("usage.csv").exists());
        std::fs::remove_file(&exports).unwrap();
        std::fs::create_dir(&exports).unwrap();
        let victim = outside.join("synthetic.txt");
        std::fs::write(&victim, "keep me").unwrap();
        std::fs::hard_link(&victim, exports.join("usage.csv")).unwrap();
        assert!(write_export(&f.0, "usage.csv", "x").is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep me");
    }

    #[test]
    fn export_preserves_existing_files_and_sanitizes_names() {
        let f = Fixture::new();
        let path = write_export(&f.0, "../../usage.csv", "first").unwrap();
        assert_eq!(Path::new(&path).parent().unwrap(), f.0.join("exports"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        assert!(write_export(&f.0, "../../usage.csv", "second").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        for name in ["", ".", ".."] { assert!(write_export(&f.0, name, "x").is_err()); }
    }
}
