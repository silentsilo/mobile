fn main() {
    // iOS: the security key entry points (`ss_nfc_*`, `ss_ask_pin`) are Swift
    // in the Xcode project, linked with the static library. The cdylib Cargo
    // also builds is never used there, so it may leave them unresolved.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-undefined,dynamic_lookup");
    }
    require_google_secret();
    tauri_build::build()
}

/// Google Drive exists only in a build that has Google's client secret: core
/// reads it at compile time (`silentsilo-cloud`, `option_env!`). A release
/// without it ships without Google Drive while the store listing, the site
/// and the privacy page promise it, so a release build stops instead. A
/// build meant to go without it says so with `SILENTSILO_WITHOUT_GOOGLE=1`.
fn require_google_secret() {
    println!("cargo:rerun-if-env-changed=SILENTSILO_GOOGLE_CLIENT_SECRET");
    println!("cargo:rerun-if-env-changed=SILENTSILO_WITHOUT_GOOGLE");
    let present =
        std::env::var("SILENTSILO_GOOGLE_CLIENT_SECRET").is_ok_and(|s| !s.trim().is_empty());
    let waived = std::env::var_os("SILENTSILO_WITHOUT_GOOGLE").is_some();
    if present || waived {
        return;
    }
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        panic!(
            "{}",
            concat!(
                "SILENTSILO_GOOGLE_CLIENT_SECRET is not set, so this release would have ",
                "no Google Drive. Set it (the release machine keeps it in ",
                "~/.silentsilo-release/google-client-secret.txt), or set ",
                "SILENTSILO_WITHOUT_GOOGLE=1 for a build that goes without it."
            )
        );
    }
    // A phone build for testing: said once, so a missing Google Drive on the
    // device is not a surprise.
    if matches!(
        std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
        Ok("ios" | "android")
    ) {
        println!(
            "cargo:warning=SILENTSILO_GOOGLE_CLIENT_SECRET is not set: this build has no Google Drive"
        );
    }
}
