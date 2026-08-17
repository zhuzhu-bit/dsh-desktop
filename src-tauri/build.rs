fn main() {
    // Tauri embeds the Windows application icon at Rust build time. Explicitly
    // track the icon inputs so an icon-only change cannot reuse a stale
    // incremental-build resource.
    println!("cargo:rerun-if-changed=icons/icon-source.png");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    tauri_build::build()
}
