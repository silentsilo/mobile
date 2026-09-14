//! What the autofill prompt reads: which silo, which keys may open it, and
//! its logins once open. The Kotlin side is `Autofill.kt`; it matches the
//! logins to the app or site and hands the chosen one to Android.
//!
//! The silo opens into the running app's session map when the app is
//! running, so it then counts as unlocked there and locks by the same rules.
//! When autofill started the process on its own, the silo is opened, read
//! and closed again at once.

use std::path::Path;

use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::jstring;
use silentsilo_app::{AppEvent, AppState, Host, flows};
use silentsilo_vault::{BackupTarget, KIND_ANDROID_KEYSTORE, SiloEntry, load_registry};
use tauri::Manager;
use uuid::Uuid;

/// No window to tell: autofill started the process without the app.
struct Quiet;

impl Host for Quiet {
    fn emit(&self, _event: AppEvent) {}
    fn warn(&self, _area: &str, _detail: &str) {}
    fn targets(&self, silo_id: Uuid) -> Vec<BackupTarget> {
        silentsilo_vault::load_targets(silo_id)
    }
}

fn front_silo(data_dir: &Path) -> Option<SiloEntry> {
    let registry = load_registry(data_dir);
    registry
        .active
        .and_then(|id| registry.get(id).cloned())
        .or_else(|| registry.silos.first().cloned())
}

fn text(env: &mut JNIEnv, value: &JString) -> String {
    env.get_string(value).map(String::from).unwrap_or_default()
}

fn answer(env: &mut JNIEnv, json: serde_json::Value) -> jstring {
    env.new_string(json.to_string())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// `Native.autofillSilo`: `{vaultId, name, credentialIds, open}`, or `{}`
/// when there is no silo on the phone.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_autofillSilo(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
) -> jstring {
    let data_dir = text(&mut env, &data_dir);
    let Some(silo) = front_silo(Path::new(&data_dir)) else {
        return answer(&mut env, serde_json::json!({}));
    };
    let open = crate::background::app()
        .is_some_and(|app| app.state::<AppState>().session_is_open(silo.id));
    let ids = flows::device_key_ids(&silo.path, KIND_ANDROID_KEYSTORE);
    answer(
        &mut env,
        serde_json::json!({
            "vaultId": silo.id.to_string(),
            "name": silo.name,
            "credentialIds": ids,
            "open": open,
        }),
    )
}

/// `Native.autofillLogins`: `{logins: [...]}` or `{error}`. The key is
/// empty when the silo is already open in the app.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_autofillLogins(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    credential_id: JString,
    wrap_key: JString,
) -> jstring {
    let data_dir = text(&mut env, &data_dir);
    let credential_id = text(&mut env, &credential_id);
    let mut wrap_hex = text(&mut env, &wrap_key);
    let result = logins(Path::new(&data_dir), &credential_id, &wrap_hex);
    // The only copy of the key this side holds.
    zeroize::Zeroize::zeroize(&mut wrap_hex);
    match result {
        Ok(logins) => answer(&mut env, serde_json::json!({ "logins": logins })),
        Err(error) => answer(&mut env, serde_json::json!({ "error": error })),
    }
}

fn logins(
    data_dir: &Path,
    credential_id: &str,
    wrap_hex: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let silo = front_silo(data_dir).ok_or("There is no silo on this phone.")?;
    let open = |silo: &SiloEntry| {
        let wrap: [u8; 32] = hex::decode(wrap_hex)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or("The silo is locked.")?;
        flows::open_with_device_key(silo.path.clone(), credential_id, &wrap, silo.id)
            .map(|(session, _)| session)
    };

    let rows = match crate::background::app() {
        Some(app) => {
            let state = app.state::<AppState>();
            if !state.session_is_open(silo.id) {
                let session = open(&silo)?;
                state.open_session(&crate::host::MobileHost(app.clone()), silo.id, session)?;
                let _ = tauri::Emitter::emit(app, "vault-changed", ());
            }
            state.touch(silo.id);
            state.with_session_id(silo.id, |_session, vfs| vfs.list_passwords())?
        }
        None => {
            let state = AppState::default();
            state.open_session(&Quiet, silo.id, open(&silo)?)?;
            let rows = state.with_session_id(silo.id, |_session, vfs| vfs.list_passwords());
            let _ = state.close_session(&Quiet, silo.id);
            rows?
        }
    };

    Ok(rows
        .iter()
        .filter_map(|row| serde_json::from_str::<serde_json::Value>(row).ok())
        .filter(|entry| {
            let kind = entry
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("login");
            kind == "login"
                && entry
                    .get("password")
                    .and_then(|p| p.as_str())
                    .is_some_and(|p| !p.is_empty())
        })
        .map(|entry| {
            let field = |name: &str| entry.get(name).and_then(|v| v.as_str()).unwrap_or("");
            serde_json::json!({
                "service": field("service"),
                "username": field("username"),
                "password": field("password"),
                "url": field("url"),
            })
        })
        .collect())
}
