//! The commands `src/api.ts` calls, with the desktop's names and shapes.
//! Flows live in `silentsilo_app`; this file is the phone's glue: where the
//! silo folder goes, the silo list, and the device key through the plugin.

use std::path::PathBuf;

use silentsilo_app::flows::{self, DeviceKey};
use silentsilo_app::{AppState, StoreConfigInput, SyncReport};
use silentsilo_core::{FolderEntry, VaultEntry, VaultMeta};
use silentsilo_vault::{
    KIND_ANDROID_KEYSTORE, LocalVaultAuth, SiloEntry, StoredFidoCredential, VaultSession,
    load_registry, save_registry,
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::host::MobileHost;

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

pub(crate) fn active_silo(state: &AppState) -> Result<SiloEntry, String> {
    state
        .active_silo
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "No silo is open".to_string())
}

pub(crate) fn host(app: &AppHandle) -> MobileHost {
    MobileHost(app.clone())
}

/// Which key on each silo is this phone's own, since a desktop's Windows
/// Hello key is also "built in" and would otherwise read as this device's.
fn device_keys_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("device-keys.json"))
}

fn load_device_keys(app: &AppHandle) -> std::collections::HashMap<Uuid, String> {
    device_keys_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_device_key(app: &AppHandle, silo: Uuid, credential_id: &str) -> Result<(), String> {
    let mut map = load_device_keys(app);
    map.insert(silo, credential_id.to_string());
    let path = device_keys_path(app)?;
    std::fs::write(path, serde_json::to_vec(&map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Drops this phone's key record for a silo and returns the credential id
/// it named, for removing the key itself.
pub(crate) fn forget_device_key(app: &AppHandle, silo: Uuid) -> Option<String> {
    let mut map = load_device_keys(app);
    let removed = map.remove(&silo)?;
    let path = device_keys_path(app).ok()?;
    let _ = std::fs::write(path, serde_json::to_vec(&map).ok()?);
    Some(removed)
}

pub(crate) fn this_phone_key(app: &AppHandle, silo: &SiloEntry) -> Option<String> {
    let id = load_device_keys(app).get(&silo.id)?.clone();
    let keys = silentsilo_vault::load_fido_keys(&silo.path).ok()?;
    keys.active().any(|k| k.credential_id == id).then_some(id)
}

#[derive(serde::Serialize)]
pub struct SiloView {
    id: String,
    name: String,
    path: String,
    last_opened: i64,
    present: bool,
    unlocked: bool,
}

#[derive(serde::Serialize)]
pub struct Bootstrap {
    provisioned: bool,
    locked: bool,
    fido_available: bool,
    fido_key_present: bool,
    fido_enrolled: bool,
    fido_backup_enrolled: bool,
    platform_authenticator: bool,
    portable_enrolled: bool,
    platform_enrolled: bool,
    /// Made on this phone and left before its first key: nothing but the
    /// device secret opens it (`silo_resume_new`).
    keyless: bool,
    silo: Option<SiloView>,
}

#[tauri::command]
pub fn app_bootstrap(app: AppHandle, state: State<AppState>) -> Result<Bootstrap, String> {
    let silo = active_silo(&state).ok();
    let locked = state.focused_session()?.is_none();
    let platform_enrolled = silo
        .as_ref()
        .is_some_and(|s| this_phone_key(&app, s).is_some());
    let fido_enrolled = silo
        .as_ref()
        .is_some_and(|s| silentsilo_vault::is_fido_enrolled(&s.path));
    Ok(Bootstrap {
        provisioned: silo
            .as_ref()
            .is_some_and(|s| silentsilo_vault::is_provisioned(s.id)),
        locked,
        fido_available: false,
        fido_key_present: false,
        fido_enrolled,
        fido_backup_enrolled: false,
        platform_authenticator: true,
        portable_enrolled: false,
        platform_enrolled,
        keyless: silo.as_ref().is_some_and(crate::create::keyless),
        silo: silo.map(|s| SiloView {
            id: s.id.to_string(),
            name: s.name.clone(),
            path: s.path.to_string_lossy().to_string(),
            last_opened: s.last_opened,
            present: s.is_present(),
            unlocked: !locked,
        }),
    })
}

#[tauri::command]
pub async fn sftp_probe_host_key(host: String, port: u16) -> Result<String, String> {
    silentsilo_store::probe_host_key(host.trim(), port)
        .await
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize, Default)]
pub struct JoinPreview {
    vault_id: Option<String>,
    key_labels: Vec<String>,
}

#[tauri::command]
pub async fn vault_preview_join(config: StoreConfigInput) -> Result<JoinPreview, String> {
    let store = config
        .into_config(None)?
        .open()
        .map_err(|e| e.to_string())?;
    let Some(manifest) = silentsilo_sync::read_manifest(&*store)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(JoinPreview::default());
    };
    let key_labels = silentsilo_sync::fetch_key_envelopes(&*store)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|k| k.label)
        .collect();
    Ok(JoinPreview {
        vault_id: Some(manifest.vault_id.to_string()),
        key_labels,
    })
}

#[derive(serde::Serialize, Clone)]
struct JoinProgress {
    fetched: usize,
    total: usize,
}

#[tauri::command]
pub async fn vault_join_with_recovery(
    app: AppHandle,
    state: State<'_, AppState>,
    config: StoreConfigInput,
    code: String,
    name: String,
    location: Option<String>,
) -> Result<VaultMeta, String> {
    let _ = location;
    let store_config = config.into_config(None)?;
    let store = store_config.open().map_err(|e| e.to_string())?;
    let join = flows::recovery_join_begin(&*store, &code).await?;
    finish_join(&app, &state, &store_config, &*store, join, &name).await
}

/// Everything after the recovery code or a security key opened the silo:
/// this phone's folder, credentials and storage settings, the silo created
/// and filled from storage, and opened. A join that fails part way leaves
/// nothing behind, so trying again is not refused as a silo already here.
pub(crate) async fn finish_join(
    app: &AppHandle,
    state: &AppState,
    store_config: &silentsilo_store::StoreConfig,
    store: &dyn silentsilo_store::ObjectStore,
    join: flows::RecoveryJoin,
    name: &str,
) -> Result<VaultMeta, String> {
    // The silo list and this phone's folder for it.
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the silo a name.".into());
    }
    let app_data = app_data(app)?;
    let mut registry = load_registry(&app_data);
    if registry.silos.iter().any(|s| s.id == join.vault_id) {
        return Err("That silo is already on this phone.".into());
    }
    let root = app_data.join("silos").join(join.vault_id.to_string());
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    silentsilo_vault::write_marker(&root, join.vault_id).map_err(|e| e.to_string())?;
    let entry = SiloEntry {
        id: join.vault_id,
        name: name.to_string(),
        path: root.clone(),
        last_opened: 0,
        auto_lock_minutes: None,
    };

    let (session, meta) = match provision_joined(app, store_config, store, &join, &root).await {
        Ok(made) => made,
        Err(e) => {
            silentsilo_vault::clear_credentials(join.vault_id);
            silentsilo_vault::clear_s3_config(join.vault_id);
            silentsilo_vault::wipe_machine_state(&root);
            let _ =
                std::fs::remove_dir_all(silentsilo_vault::workdir::secrets_dir_for(join.vault_id));
            let _ = std::fs::remove_dir_all(&root);
            return Err(e);
        }
    };

    registry.upsert(entry.clone());
    registry.active = Some(entry.id);
    save_registry(&app_data, &registry).map_err(|e| e.to_string())?;
    *state.active_silo.lock().map_err(|e| e.to_string())? = Some(entry.clone());
    state.open_session(&host(app), entry.id, session)?;
    Ok(meta)
}

async fn provision_joined(
    app: &AppHandle,
    store_config: &silentsilo_store::StoreConfig,
    store: &dyn silentsilo_store::ObjectStore,
    join: &flows::RecoveryJoin,
    root: &std::path::Path,
) -> Result<(VaultSession, VaultMeta), String> {
    let device_secret = hex::encode(silentsilo_crypto::generate_dek().as_bytes());
    silentsilo_vault::save_credentials(&LocalVaultAuth {
        vault_id: join.vault_id,
        device_secret: device_secret.clone(),
    })
    .map_err(|e| e.to_string())?;
    silentsilo_vault::save_s3_config(join.vault_id, store_config).map_err(|e| e.to_string())?;

    let session =
        flows::recovery_join_provision(store, join, root.to_path_buf(), &device_secret).await?;

    let emitter = app.clone();
    let plan = silentsilo_sync::fetch_join_plan_reporting(
        store,
        join.dek(),
        &mut move |fetched, total| {
            let _ = emitter.emit("join-progress", JoinProgress { fetched, total });
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || flows::join_finish(session, plan))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn device_key_enroll(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
) -> Result<(), String> {
    let silo = active_silo(&state)?;
    let lock = app.state::<crate::background::BackgroundLock>();
    let _prompt = lock.prompt();
    let enrolled = app
        .state::<crate::device_key::DeviceKey<tauri::Wry>>()
        .enrol(&silo.id.to_string())
        .await?;
    let wrap_key: [u8; 32] = hex::decode(&enrolled.wrap_key)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| "The phone returned an unreadable key.".to_string())?;
    let key = DeviceKey {
        kind: KIND_ANDROID_KEYSTORE.into(),
        derivation: silentsilo_vault::DERIVATION_KEYSTORE_AES_GCM_V1.into(),
        credential_id: enrolled.credential_id.clone(),
        public_key: String::new(),
        wrap_key,
        label: label.trim().to_string(),
    };
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(&silo.id)
            .ok_or_else(|| "Unlock the silo first.".to_string())?;
        flows::enrol_device_key(session, &key)?;
    }
    save_device_key(&app, silo.id, &enrolled.credential_id)
}

#[tauri::command]
pub async fn vault_unlock(app: AppHandle, state: State<'_, AppState>) -> Result<VaultMeta, String> {
    let silo = active_silo(&state)?;
    let ids = flows::device_key_ids(&silo.path, KIND_ANDROID_KEYSTORE);
    if ids.is_empty() {
        return Err("This phone has no key for this silo. Use the recovery code.".into());
    }
    app.state::<crate::background::BackgroundLock>()
        .on_screen()
        .await;
    let unlocked = app
        .state::<crate::device_key::DeviceKey<tauri::Wry>>()
        .unlock(&silo.id.to_string(), &ids)
        .await?;
    let wrap_key: [u8; 32] = hex::decode(&unlocked.wrap_key)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| "The phone returned an unreadable key.".to_string())?;
    let root = silo.path.clone();
    let (session, meta) = tauri::async_runtime::spawn_blocking(move || {
        flows::open_with_device_key(root, &unlocked.credential_id, &wrap_key, silo.id)
    })
    .await
    .map_err(|e| e.to_string())??;
    state.open_session(&host(&app), silo.id, session)?;
    Ok(meta)
}

#[tauri::command]
pub async fn vault_unlock_with_recovery(
    app: AppHandle,
    state: State<'_, AppState>,
    code: String,
) -> Result<VaultMeta, String> {
    let silo = active_silo(&state)?;
    let store = silentsilo_vault::load_s3_config(silo.id).and_then(|c| c.open().ok());
    let envelope = flows::recovery_envelope_for(&silo.path, store.as_deref()).await?;
    let root = silo.path.clone();
    let (session, meta) = tauri::async_runtime::spawn_blocking(move || {
        flows::open_with_recovery(root, &envelope, &code, silo.id)
    })
    .await
    .map_err(|e| e.to_string())??;
    silentsilo_app::wipe_open_scratch(&silo.path);
    state.open_session(&host(&app), silo.id, session)?;
    Ok(meta)
}

#[tauri::command]
pub async fn vault_lock(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Option<String>,
) -> Result<(), String> {
    let ids = match id {
        Some(id) => vec![Uuid::parse_str(&id).map_err(|e| e.to_string())?],
        None => state.open_silo_ids(),
    };
    for id in ids {
        state.close_session(&host(&app), id)?;
    }
    state.sweep_scratch();
    crate::viewer::wipe_opened(&app);
    Ok(())
}

#[tauri::command]
pub fn vault_read_passwords(state: State<AppState>) -> Result<String, String> {
    let entries = state.with_vfs(|_session, vfs| vfs.list_passwords())?;
    Ok(format!("[{}]", entries.join(",")))
}

#[tauri::command]
pub fn vault_upsert_password(
    id: String,
    json: String,
    state: State<AppState>,
) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|e| format!("invalid entry id: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
    match parsed.get("id").and_then(|v| v.as_str()) {
        Some(inner) if inner == id.to_string() => {}
        Some(_) => return Err("entry id does not match the record".into()),
        None => return Err("entry has no id".into()),
    }
    state.with_vfs(|_session, vfs| vfs.upsert_password(id, &json))
}

#[tauri::command]
pub fn vault_delete_password(id: String, state: State<AppState>) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|e| format!("invalid entry id: {e}"))?;
    state.with_vfs(|_session, vfs| vfs.delete_password(id))
}

#[tauri::command]
pub async fn copy_secret_to_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    app.state::<crate::device_key::DeviceKey<tauri::Wry>>()
        .copy_secret(&text)
        .await
}

#[tauri::command]
pub fn vault_root_folder(state: State<AppState>) -> Result<FolderEntry, String> {
    state.with_vfs(|_session, vfs| {
        let id = vfs.root_folder_id()?;
        vfs.get_folder(id)
    })
}

#[tauri::command]
pub fn vault_list_folder(
    folder_id: String,
    state: State<AppState>,
) -> Result<Vec<VaultEntry>, String> {
    let folder_id = Uuid::parse_str(&folder_id).map_err(|e| e.to_string())?;
    state.with_vfs(|_session, vfs| vfs.list_folder(folder_id))
}

/// The most a preview holds in memory. Past this the file is described,
/// not shown.
const MAX_PREVIEW_BYTES: i64 = 64 * 1024 * 1024;

/// `silo://…/<file id>`: one file's plaintext, for an `<img>` or a fetch.
///
/// A URL rather than a command, because Android has no binary IPC: a
/// command's bytes come back as a JavaScript array literal evaluated in the
/// page, which for a photo is tens of megabytes of text that never arrives.
pub fn serve_file(
    app: AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move {
        let respond = |status: u16, mime: &str, body: Vec<u8>| {
            tauri::http::Response::builder()
                .status(status)
                .header(tauri::http::header::CONTENT_TYPE, mime)
                .header(tauri::http::header::CACHE_CONTROL, "no-store")
                .body(body)
                .unwrap_or_default()
        };
        let path = request.uri().path().trim_matches('/').to_string();
        // `pdf/<file id>/pages` or `pdf/<file id>/<page>?w=<width>`.
        if let Some(rest) = path.strip_prefix("pdf/") {
            let mut parts = rest.split('/');
            let id = parts.next().and_then(|s| Uuid::parse_str(s).ok());
            let what = parts.next().unwrap_or("pages").to_string();
            let width = request
                .uri()
                .query()
                .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("w=")))
                .and_then(|w| w.parse().ok())
                .unwrap_or(1080);
            let response = match id {
                Some(id) => match crate::viewer::serve_pdf(&app, id, &what, width).await {
                    Ok((mime, body)) => respond(200, mime, body),
                    Err(e) => respond(500, "text/plain", e.into_bytes()),
                },
                None => respond(404, "text/plain", b"not found".to_vec()),
            };
            responder.respond(response);
            return;
        }
        let id = path
            .rsplit('/')
            .next()
            .and_then(|last| Uuid::parse_str(last).ok());
        let state = app.state::<AppState>();
        let response = match (id, active_silo(&state)) {
            (Some(file_id), Ok(silo)) => {
                match silentsilo_app::files::read_file(
                    &state,
                    &host(&app),
                    &silo,
                    file_id,
                    MAX_PREVIEW_BYTES,
                )
                .await
                {
                    Ok(content) => respond(
                        200,
                        content
                            .mime_type
                            .as_deref()
                            .unwrap_or("application/octet-stream"),
                        content.bytes,
                    ),
                    Err(e) => respond(500, "text/plain", e.into_bytes()),
                }
            }
            _ => respond(404, "text/plain", b"not found".to_vec()),
        };
        responder.respond(response);
    });
}

#[derive(serde::Serialize)]
pub struct SyncStatus {
    configured: bool,
    pending_ops: usize,
    archive_targets: usize,
}

#[tauri::command]
pub fn sync_status(state: State<AppState>) -> Result<SyncStatus, String> {
    let silo = active_silo(&state).ok();
    let targets = silo
        .as_ref()
        .map(|s| silentsilo_vault::load_targets(s.id))
        .unwrap_or_default();
    let guard = state.focused_session()?;
    let pending_ops = match guard.as_ref() {
        Some(session) => silentsilo_vfs::pending_count(&session.conn).map_err(|e| e.to_string())?,
        None => 0,
    };
    Ok(SyncStatus {
        configured: !targets.is_empty(),
        pending_ops,
        archive_targets: targets.iter().filter(|t| !t.role.allows_delete()).count(),
    })
}

#[tauri::command]
pub async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> Result<SyncReport, String> {
    let silo = active_silo(&state)?;
    silentsilo_app::sync_now(&state, &host(&app), &silo).await
}

#[derive(serde::Serialize)]
pub struct ListedKey {
    #[serde(flatten)]
    key: StoredFidoCredential,
    usable: bool,
}

#[tauri::command]
pub fn fido_list_keys(state: State<AppState>) -> Result<Vec<ListedKey>, String> {
    let silo = active_silo(&state)?;
    if !silentsilo_vault::is_fido_enrolled(&silo.path) {
        return Ok(Vec::new());
    }
    let keys = silentsilo_vault::load_fido_keys(&silo.path).map_err(|e| e.to_string())?;
    let usable: std::collections::HashSet<&str> =
        keys.usable().map(|k| k.credential_id.as_str()).collect();
    Ok(keys
        .active()
        .map(|k| ListedKey {
            usable: usable.contains(k.credential_id.as_str()),
            key: k.clone(),
        })
        .collect())
}

#[derive(serde::Serialize)]
pub struct RemoveKeyOutcome {
    withheld: Vec<String>,
}

/// Retires a key: a tombstone here, and the next sync pass deletes its
/// envelope from storage. Refuses the last key and an organisation's.
#[tauri::command]
pub async fn fido_remove_key(
    app: AppHandle,
    state: State<'_, AppState>,
    credential_id: String,
) -> Result<RemoveKeyOutcome, String> {
    let silo = active_silo(&state)?;
    let is_this_phone = load_device_keys(&app).get(&silo.id) == Some(&credential_id);
    let mut keys = silentsilo_vault::load_fido_keys(&silo.path).map_err(|e| e.to_string())?;
    let Some(key) = keys
        .keys
        .iter_mut()
        .find(|k| k.credential_id == credential_id && !k.revoked)
    else {
        return Err("Security key not found".into());
    };
    if key.managed() {
        return Err("An organisation administers this key, so it cannot be removed here.".into());
    }
    key.revoked = true;
    if keys.active().next().is_none() {
        return Err("This is the silo's last key. Add another before removing it.".into());
    }
    silentsilo_vault::save_fido_keys(&silo.path, &keys, silentsilo_vault::Authority::Machine)
        .map_err(|e| e.to_string())?;
    if is_this_phone {
        let _ = app
            .state::<crate::device_key::DeviceKey<tauri::Wry>>()
            .remove(&credential_id)
            .await;
        // Its items would be refused from now on anyway: the sender is
        // valid only while this key is in storage.
        let _ = crate::backup::stop(&app).await;
    }
    Ok(RemoveKeyOutcome {
        withheld: Vec::new(),
    })
}

#[derive(serde::Serialize, Default)]
pub struct RecoveryStatus {
    enabled: bool,
    created_at: Option<i64>,
}

#[tauri::command]
pub fn recovery_status(state: State<AppState>) -> Result<RecoveryStatus, String> {
    let silo = active_silo(&state)?;
    if !silentsilo_vault::has_recovery_code(&silo.path) {
        return Ok(RecoveryStatus::default());
    }
    Ok(RecoveryStatus {
        enabled: true,
        created_at: silentsilo_vault::load_recovery_envelope(&silo.path)
            .ok()
            .map(|e| e.created_at),
    })
}

/// Syncs every open silo that has changes waiting or has not pulled for two
/// minutes, for as long as the app runs. Quiet on failure: a phone is often
/// offline.
pub fn spawn_auto_sync(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_pull: std::collections::HashMap<Uuid, i64> = Default::default();
        let mut first = true;
        loop {
            // The first tick straight away: what changed elsewhere while the
            // app was closed should show up now, not a quarter minute later.
            if !first {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            }
            first = false;
            let state = app.state::<AppState>();
            let Ok(app_data) = app_data(&app) else {
                continue;
            };
            let registry = load_registry(&app_data);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            for id in state.open_silo_ids() {
                let Some(silo) = registry.get(id).cloned() else {
                    continue;
                };
                let waiting = state
                    .sessions
                    .lock()
                    .ok()
                    .and_then(|s| {
                        s.get(&id)
                            .and_then(|s| silentsilo_vfs::pending_count(&s.conn).ok())
                    })
                    .unwrap_or(0);
                if waiting == 0 && now - last_pull.get(&id).copied().unwrap_or(0) < 120 {
                    continue;
                }
                match silentsilo_app::run_sync_pass(&state, &host(&app), &silo).await {
                    Ok(report) if report.skipped => {}
                    Ok(_) => {
                        last_pull.insert(id, now);
                        crate::backup::confirm_sent(&app, &silo).await;
                    }
                    Err(_) => {
                        last_pull.insert(id, now);
                    }
                }
            }
        }
    });
}

/// The silo opened last time, so a restart lands on its unlock screen.
pub fn restore_focus(app: &AppHandle, state: &AppState) {
    let Ok(app_data) = app_data(app) else {
        return;
    };
    let registry = load_registry(&app_data);
    let focused = registry
        .active
        .and_then(|id| registry.get(id).cloned())
        .or_else(|| registry.silos.first().cloned());
    if let Ok(mut active) = state.active_silo.lock() {
        *active = focused;
    }
}
