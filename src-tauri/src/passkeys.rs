//! What the passkey provider (`Passkeys.kt`) asks of the silo: which
//! passkeys a site has, a new one saved into a password entry, and a
//! sign-in signed. The WebAuthn work is core's `silentsilo_fido::passkey`.
//!
//! Every call that touches a private key comes with the key a fingerprint
//! just unwrapped, so each passkey use is a verified one. The silo opens the
//! way autofill opens it.

use std::path::Path;

use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::jstring;
use silentsilo_app::AppState;
use silentsilo_fido::passkey::{self, Caller, PasskeyError, PasskeyRecord};
use tauri::Manager;
use uuid::Uuid;

use crate::autofill::{answer, front_silo, host_of, text, with_front_silo};

/// The passkeys the silo's password entries hold.
fn held(rows: &[String]) -> Vec<PasskeyRecord> {
    rows.iter()
        .filter_map(|row| serde_json::from_str::<serde_json::Value>(row).ok())
        .filter_map(|entry| serde_json::from_value(entry.get("passkey")?.clone()).ok())
        .collect()
}

fn caller<'a>(origin: &'a str, package: &'a str, hash_hex: &str) -> Caller<'a> {
    Caller {
        origin,
        package: (!package.is_empty()).then_some(package),
        client_data_hash: hex::decode(hash_hex).ok().and_then(|b| b.try_into().ok()),
    }
}

fn listed(records: &[&PasskeyRecord]) -> Vec<serde_json::Value> {
    records
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.credential_id,
                "userName": r.user_name,
                "displayName": r.user_display_name,
            })
        })
        .collect()
}

fn describe(error: PasskeyError) -> serde_json::Value {
    let code = match error {
        PasskeyError::Excluded => "excluded",
        PasskeyError::Unsupported => "unsupported",
        PasskeyError::WrongOrigin { .. } => "origin",
        PasskeyError::Invalid(_) => "invalid",
        PasskeyError::AppCaller => "app",
    };
    serde_json::json!({ "error": error.to_string(), "code": code })
}

/// `Native.passkeyOverview`: the site's passkeys when the silo is open in
/// the app, `{open: true, passkeys}`; otherwise what unlocking needs,
/// `{open: false, vaultId, name, credentialIds}`, or `{}` with no silo.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_passkeyOverview(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    request: JString,
    origin: JString,
) -> jstring {
    let (data_dir, request, origin) = (
        text(&mut env, &data_dir),
        text(&mut env, &request),
        text(&mut env, &origin),
    );
    let Some(silo) = front_silo(Path::new(&data_dir)) else {
        return answer(&mut env, serde_json::json!({}));
    };
    let open_rows = crate::background::app().and_then(|app| {
        let state = app.state::<AppState>();
        state
            .session_is_open(silo.id)
            .then(|| {
                state
                    .with_session_id(silo.id, |_session, vfs| vfs.list_passwords())
                    .ok()
            })
            .flatten()
    });
    let json = match open_rows {
        Some(rows) => {
            let records = held(&rows);
            let usable = passkey::usable_for(&request, &origin, &records).unwrap_or_default();
            serde_json::json!({ "open": true, "passkeys": listed(&usable) })
        }
        None => serde_json::json!({
            "open": false,
            "vaultId": silo.id.to_string(),
            "name": silo.name,
            "credentialIds": silentsilo_app::flows::device_key_ids(
                &silo.path,
                silentsilo_vault::KIND_ANDROID_KEYSTORE,
            ),
        }),
    };
    answer(&mut env, json)
}

/// `Native.passkeyFind`: after a fingerprint, the site's passkeys,
/// `{passkeys}` or `{error}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_passkeyFind(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    credential_id: JString,
    wrap_key: JString,
    request: JString,
    origin: JString,
) -> jstring {
    let (data_dir, credential_id, request, origin) = (
        text(&mut env, &data_dir),
        text(&mut env, &credential_id),
        text(&mut env, &request),
        text(&mut env, &origin),
    );
    let mut wrap_hex = text(&mut env, &wrap_key);
    let rows = with_front_silo(Path::new(&data_dir), &credential_id, &wrap_hex, |vfs| {
        vfs.list_passwords()
    });
    zeroize::Zeroize::zeroize(&mut wrap_hex);
    let json = match rows {
        Ok(rows) => {
            let records = held(&rows);
            match passkey::usable_for(&request, &origin, &records) {
                Ok(usable) => serde_json::json!({ "passkeys": listed(&usable) }),
                Err(error) => describe(error),
            }
        }
        Err(error) => serde_json::json!({ "error": error }),
    };
    answer(&mut env, json)
}

/// `Native.passkeyCreate`: makes a passkey and saves it, `{response}` with
/// the registration JSON or `{error, code}`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_passkeyCreate(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    credential_id: JString,
    wrap_key: JString,
    request: JString,
    origin: JString,
    package: JString,
    client_data_hash: JString,
) -> jstring {
    let (data_dir, credential_id, request, origin, package, hash) = (
        text(&mut env, &data_dir),
        text(&mut env, &credential_id),
        text(&mut env, &request),
        text(&mut env, &origin),
        text(&mut env, &package),
        text(&mut env, &client_data_hash),
    );
    let mut wrap_hex = text(&mut env, &wrap_key);
    let caller = caller(&origin, &package, &hash);
    let mut outcome = None;
    let saved = with_front_silo(Path::new(&data_dir), &credential_id, &wrap_hex, |vfs| {
        let rows = vfs.list_passwords()?;
        let records = held(&rows);
        let now = now_ms();
        let made = match passkey::register(&request, &caller, &records, now) {
            Ok(made) => made,
            Err(error) => {
                outcome = Some(describe(error));
                return Ok(());
            }
        };
        let entry = entry_for(&rows, &made, now);
        let id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .and_then(|v| Uuid::parse_str(v).ok())
            .ok_or_else(|| silentsilo_core::CoreError::Database("the entry has no id".into()))?;
        vfs.upsert_password(id, &entry.to_string())?;
        outcome = Some(serde_json::json!({ "response": made.response_json }));
        Ok(())
    });
    zeroize::Zeroize::zeroize(&mut wrap_hex);
    let json = match saved {
        Ok(()) => outcome.unwrap_or_else(|| serde_json::json!({ "error": "nothing was made" })),
        Err(error) => serde_json::json!({ "error": error }),
    };
    answer(&mut env, json)
}

/// The entry a new passkey goes into: the site's login for the same
/// account when it has no passkey yet, else a new login entry.
fn entry_for(rows: &[String], made: &passkey::Registration, now: i64) -> serde_json::Value {
    let record = &made.record;
    let passkey = serde_json::to_value(record).unwrap_or_default();
    let same_account = rows
        .iter()
        .filter_map(|row| serde_json::from_str::<serde_json::Value>(row).ok())
        .find(|entry| {
            let login = entry
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("login")
                == "login";
            let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let user = entry.get("username").and_then(|v| v.as_str()).unwrap_or("");
            login
                && entry.get("passkey").is_none()
                && host_of(url).is_some_and(|h| {
                    h == record.rp_id || h.ends_with(&format!(".{}", record.rp_id))
                })
                && !user.is_empty()
                && user == record.user_name
        });
    match same_account {
        Some(mut entry) => {
            entry["passkey"] = passkey;
            entry["updated_at"] = now.into();
            entry
        }
        None => serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "service": if made.rp_name.trim().is_empty() { record.rp_id.clone() } else { made.rp_name.trim().to_string() },
            "username": record.user_name,
            "password": "",
            "url": format!("https://{}", record.rp_id),
            "notes": "",
            "category": "General",
            "created_at": now,
            "updated_at": now,
            "type": "login",
            "passkey": passkey,
        }),
    }
}

/// `Native.passkeyAssert`: signs in with passkey `passkey_id`, `{response}`
/// with the authentication JSON or `{error, code}`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_passkeyAssert(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    credential_id: JString,
    wrap_key: JString,
    passkey_id: JString,
    request: JString,
    origin: JString,
    package: JString,
    client_data_hash: JString,
) -> jstring {
    let (data_dir, credential_id, passkey_id, request, origin, package, hash) = (
        text(&mut env, &data_dir),
        text(&mut env, &credential_id),
        text(&mut env, &passkey_id),
        text(&mut env, &request),
        text(&mut env, &origin),
        text(&mut env, &package),
        text(&mut env, &client_data_hash),
    );
    let mut wrap_hex = text(&mut env, &wrap_key);
    let caller = caller(&origin, &package, &hash);
    let found = with_front_silo(Path::new(&data_dir), &credential_id, &wrap_hex, |vfs| {
        let rows = vfs.list_passwords()?;
        Ok(held(&rows)
            .into_iter()
            .find(|r| r.credential_id == passkey_id))
    });
    zeroize::Zeroize::zeroize(&mut wrap_hex);
    let json = match found {
        Ok(Some(record)) => match passkey::assert(&record, &request, &caller) {
            Ok(response) => serde_json::json!({ "response": response }),
            Err(error) => describe(error),
        },
        Ok(None) => serde_json::json!({ "error": "That passkey is no longer in the silo." }),
        Err(error) => serde_json::json!({ "error": error }),
    };
    answer(&mut env, json)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
