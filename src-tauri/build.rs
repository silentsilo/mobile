fn main() {
    // iOS: the security key entry points (`ss_nfc_*`, `ss_ask_pin`) are Swift
    // in the Xcode project, linked with the static library. The cdylib Cargo
    // also builds is never used there, so it may leave them unresolved.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-undefined,dynamic_lookup");
    }
    tauri_build::build()
}
