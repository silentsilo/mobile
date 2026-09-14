use serde::Serialize;

/// What the first build proves: the core crates linked and ran on the device.
#[derive(Serialize)]
struct Probe {
    app_version: String,
    key_bytes: usize,
}

#[tauri::command]
fn probe(app: tauri::AppHandle) -> Probe {
    Probe {
        app_version: app.package_info().version.to_string(),
        key_bytes: silentsilo_crypto::generate_dek().as_bytes().len(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe])
        .run(tauri::generate_context!())
        .expect("error while running SilentSilo");
}
