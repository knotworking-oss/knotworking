fn main() {
    // The default window icon is embedded at compile time.
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    // Declaring the app's commands makes them deny-by-default: a page can call
    // one only when a capability grants it (see capabilities/connect.json).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["saved_server", "connect"])),
    )
    .expect("failed to run tauri-build");
}
