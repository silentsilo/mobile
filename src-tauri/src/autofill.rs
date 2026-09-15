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

pub(crate) fn front_silo(data_dir: &Path) -> Option<SiloEntry> {
    let registry = load_registry(data_dir);
    registry
        .active
        .and_then(|id| registry.get(id).cloned())
        .or_else(|| registry.silos.first().cloned())
}

pub(crate) fn text(env: &mut JNIEnv, value: &JString) -> String {
    env.get_string(value).map(String::from).unwrap_or_default()
}

pub(crate) fn answer(env: &mut JNIEnv, json: serde_json::Value) -> jstring {
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

/// Runs `f` against the front silo, opening it with the unwrapped key when
/// it is not open yet. Into the app's session map when the app is running;
/// otherwise opened, used and closed again, which saves what `f` wrote.
pub(crate) fn with_front_silo<T>(
    data_dir: &Path,
    credential_id: &str,
    wrap_hex: &str,
    f: impl FnOnce(&silentsilo_vfs::Vfs<'_>) -> silentsilo_core::CoreResult<T>,
) -> Result<T, String> {
    let silo = front_silo(data_dir).ok_or("There is no silo on this phone.")?;
    let open = |silo: &SiloEntry| {
        let wrap: [u8; 32] = hex::decode(wrap_hex)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or("The silo is locked.")?;
        flows::open_with_device_key(silo.path.clone(), credential_id, &wrap, silo.id)
            .map(|(session, _)| session)
    };

    match crate::background::app() {
        Some(app) => {
            let state = app.state::<AppState>();
            if !state.session_is_open(silo.id) {
                let session = open(&silo)?;
                state.open_session(&crate::host::MobileHost(app.clone()), silo.id, session)?;
                let _ = tauri::Emitter::emit(app, "vault-changed", ());
                crate::background::opened_while_away(app);
            }
            state.touch(silo.id);
            state.with_session_id(silo.id, |_session, vfs| f(vfs))
        }
        None => {
            let state = AppState::default();
            state.open_session(&Quiet, silo.id, open(&silo)?)?;
            let result = state.with_session_id(silo.id, |_session, vfs| f(vfs));
            let _ = state.close_session(&Quiet, silo.id);
            result
        }
    }
}

fn is_login(entry: &serde_json::Value) -> bool {
    entry
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("login")
        == "login"
}

fn field<'a>(entry: &'a serde_json::Value, name: &str) -> &'a str {
    entry.get(name).and_then(|v| v.as_str()).unwrap_or("")
}

fn logins(
    data_dir: &Path,
    credential_id: &str,
    wrap_hex: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let rows = with_front_silo(data_dir, credential_id, wrap_hex, |vfs| {
        vfs.list_passwords()
    })?;
    Ok(rows
        .iter()
        .filter_map(|row| serde_json::from_str::<serde_json::Value>(row).ok())
        .filter(|entry| is_login(entry) && !field(entry, "password").is_empty())
        .map(|entry| {
            serde_json::json!({
                "service": field(&entry, "service"),
                "username": field(&entry, "username"),
                "password": field(&entry, "password"),
                "url": field(&entry, "url"),
            })
        })
        .collect())
}

/// The host of a URL as entries store it, without `www.`.
pub(crate) fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest
        .split(['/', '?', '#', ':'])
        .next()?
        .trim()
        .to_lowercase();
    (!host.is_empty()).then(|| host.trim_start_matches("www.").to_string())
}

/// `Native.autofillSave`: stores a login typed into another app. Updates
/// the password of a login for the same account when there is one, so a
/// changed password does not leave a stale twin behind.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_autofillSave(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    credential_id: JString,
    wrap_key: JString,
    login: JString,
) -> jstring {
    let data_dir = text(&mut env, &data_dir);
    let credential_id = text(&mut env, &credential_id);
    let mut wrap_hex = text(&mut env, &wrap_key);
    let login = text(&mut env, &login);
    let result = save(Path::new(&data_dir), &credential_id, &wrap_hex, &login);
    zeroize::Zeroize::zeroize(&mut wrap_hex);
    match result {
        Ok(outcome) => answer(&mut env, serde_json::json!({ "saved": outcome })),
        Err(error) => answer(&mut env, serde_json::json!({ "error": error })),
    }
}

fn save(
    data_dir: &Path,
    credential_id: &str,
    wrap_hex: &str,
    login: &str,
) -> Result<&'static str, String> {
    let login: serde_json::Value = serde_json::from_str(login).map_err(|e| e.to_string())?;
    let (service, username, password, url) = (
        field(&login, "service").trim().to_string(),
        field(&login, "username").to_string(),
        field(&login, "password").to_string(),
        field(&login, "url").trim().to_string(),
    );
    // Only a trusted browser's site may replace a kept password; an app's
    // name is whatever the app says it is.
    let may_update = login
        .get("fromBrowser")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if password.is_empty() {
        return Err("There is no password to save.".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    with_front_silo(data_dir, credential_id, wrap_hex, |vfs| {
        let same_account = |entry: &serde_json::Value| {
            let same_place = match (host_of(&url), host_of(field(entry, "url"))) {
                (Some(asked), Some(stored)) => asked == stored,
                _ => !service.is_empty() && field(entry, "service").eq_ignore_ascii_case(&service),
            };
            is_login(entry) && same_place && field(entry, "username") == username
        };
        let existing = vfs
            .list_passwords()?
            .iter()
            .filter_map(|row| serde_json::from_str::<serde_json::Value>(row).ok())
            .find(same_account);

        let (entry, outcome) = match existing {
            Some(entry) if field(&entry, "password") == password => return Ok("unchanged"),
            Some(mut entry) if may_update => {
                entry["password"] = password.clone().into();
                entry["updated_at"] = now.into();
                (entry, "updated")
            }
            _ => (
                serde_json::json!({
                    "id": Uuid::new_v4().to_string(),
                    "service": if service.is_empty() { host_of(&url).unwrap_or_default() } else { service.clone() },
                    "username": username,
                    "password": password,
                    "url": url,
                    "notes": "",
                    "category": "General",
                    "created_at": now,
                    "updated_at": now,
                    "type": "login",
                }),
                "new",
            ),
        };
        let id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .and_then(|v| Uuid::parse_str(v).ok())
            .ok_or_else(|| silentsilo_core::CoreError::Database("the entry has no id".into()))?;
        vfs.upsert_password(id, &entry.to_string())?;
        Ok(outcome)
    })
}
