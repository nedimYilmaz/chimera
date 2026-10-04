fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_meeting_speech();
    }
    tauri_build::build()
}

fn build_meeting_speech() {
    use std::{env, path::PathBuf, process::Command};
    println!("cargo:rerun-if-changed=src/meeting_speech.swift");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => panic!("Unsupported macOS Speech architecture: {other}"),
    };
    let target = format!("{arch}-apple-macosx10.15");
    let status = Command::new("xcrun").args(["swiftc", "-swift-version", "5", "-O", "-parse-as-library", "-emit-library", "-static", "-module-name", "ChimeraMeetingSpeech", "-target", &target, "src/meeting_speech.swift", "-o"])
        .arg(out.join("libchimera_meeting_speech.a")).status().expect("Apple Swift compiler is required for local meeting recognition");
    assert!(status.success(), "Failed to compile the local meeting Speech bridge");
    let info = Command::new("xcrun").args(["swiftc", "-print-target-info", "-target", &target]).output().expect("Swift runtime paths");
    assert!(info.status.success(), "Failed to find Swift runtime libraries");
    let info: serde_json::Value = serde_json::from_slice(&info.stdout).expect("Swift target information");
    for path in info["paths"]["runtimeLibraryPaths"].as_array().expect("Swift runtime paths") {
        println!("cargo:rustc-link-search=native={}", path.as_str().unwrap());
    }
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=chimera_meeting_speech");
    for framework in ["Speech", "AVFoundation", "Foundation"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
