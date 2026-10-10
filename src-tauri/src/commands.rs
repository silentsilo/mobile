//! The commands `src/api.ts` calls, with the desktop's names and shapes.
//! Flows live in `silentsilo_app`; this file is the phone's glue: where the
//! silo folder goes, the silo list, and the device key through the plugin.

use std::path::PathBuf;

use silentsilo_app::flows::{self, DeviceKey};
use silentsilo_app::{AppState, StoreConfigInput, SyncReport};
use silentsilo_core::{FolderEntry, VaultEntry, VaultMeta};
use silentsilo_vault::{
    LocalVaultAuth, SiloEntry, StoredFidoCredential, VaultSession, load_registry, save_registry,
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::host::MobileHost;

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    crate::paths::data_dir(app)
}

pub(crate) fn active_silo(state: &AppState) -> Result<SiloEntry, String> {
    state
        .active_silo
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "No silo is open.".to_string())
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

#[tauri::command(async)]
pub fn app_bootstrap(app: AppHandle, state: State<AppState>) -> Result<Bootstrap, String> {
    let silo = active_silo(&state).ok();
    let locked = crate::background::past_deadline(&app) || state.focused_session()?.is_none();
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
    let store = crate::cloud::describe(config, None)?.store;
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
    /// Downloaded; the silo is being built from it on this phone.
    building: bool,
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
    let described = crate::cloud::describe(config, None)?;
    let join = flows::recovery_join_begin(&*described.store, &code).await?;
    let meta = finish_join(
        &app,
        &state,
        &described.config,
        &*described.store,
        join,
        &name,
    )
    .await?;
    described.adopt().await?;
    Ok(meta)
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
    // Until the silo is in the list: a join the phone stops part way (the
    // app killed during a long download) is cleared at the next start
    // instead of coming back as a silo that does not open.
    std::fs::write(crate::paths::joining_marker(&root), b"").map_err(|e| e.to_string())?;
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
    let _ = std::fs::remove_file(crate::paths::joining_marker(&root));
    *state.active_silo.lock().map_err(|e| e.to_string())? = Some(entry.clone());
    state.open_session(&host(app), entry.id, session)?;
    crate::audit::set_unlocked_with(entry.id, None);
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
            let _ = emitter.emit(
                "join-progress",
                JoinProgress {
                    fetched,
                    total,
                    building: false,
                },
            );
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    let _ = app.emit(
        "join-progress",
        JoinProgress {
            fetched: 0,
            total: 0,
            building: true,
        },
    );
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
        kind: crate::device_key::KIND.into(),
        derivation: crate::device_key::DERIVATION.into(),
        credential_id: enrolled.credential_id.clone(),
        public_key: enrolled.public_key.clone(),
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
    save_device_key(&app, silo.id, &enrolled.credential_id)?;
    crate::audit::record_off_thread(
        &app,
        crate::audit::event(crate::audit::codes::KEY_ADDED)
            .on(enrolled.credential_id.clone(), key.label.clone())
            .with("kind", "this phone"),
    )
    .await
}

/// What this phone's own key can still do. Changing the fingerprints on the
/// phone retires the key without telling anyone, and the only sign used to
/// be that every unlock failed, so the app asks outright.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhoneKeyState {
    /// The silo lists a key this phone published.
    enrolled: bool,
    /// And this phone can still use it.
    usable: bool,
    /// It was retired by a change to the fingerprints or faces.
    invalidated: bool,
}

#[tauri::command]
pub async fn phone_key_state(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PhoneKeyState, String> {
    let silo = active_silo(&state)?;
    let Some(credential_id) = this_phone_key(&app, &silo) else {
        return Ok(PhoneKeyState::default());
    };
    let state = app
        .state::<crate::device_key::DeviceKey<tauri::Wry>>()
        .key_state(&credential_id)
        .await?;
    Ok(PhoneKeyState {
        enrolled: true,
        usable: state == "ok",
        invalidated: state == "invalidated",
    })
}

#[tauri::command]
pub async fn vault_unlock(app: AppHandle, state: State<'_, AppState>) -> Result<VaultMeta, String> {
    let silo = active_silo(&state)?;
    let ids = flows::device_key_ids(&silo.path, crate::device_key::KIND);
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
    crate::audit::set_unlocked_with(silo.id, Some(crate::audit::VIA_PHONE_KEY.into()));
    crate::audit::start_by_default_off_thread(&app, silo.id).await;
    crate::audit::record_off_thread(
        &app,
        crate::audit::event(crate::audit::codes::UNLOCKED).with("by", "this phone"),
    )
    .await?;
    Ok(meta)
}

/// Asks for this phone's fingerprint or face again, for an entry marked to
/// ask before its secrets show. The check only counts if the key it releases
/// opens this silo's key, as on desktop, so any unlocked phone prompt is not
/// enough.
#[tauri::command]
pub async fn vault_reverify(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let silo = active_silo(&state)?;
    if !state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&silo.id)
    {
        return Err("Unlock the silo first.".into());
    }
    let ids = flows::device_key_ids(&silo.path, crate::device_key::KIND);
    if ids.is_empty() {
        return Err(
            "This phone has no key for this silo, so it cannot confirm it is you. Add one under Keys."
                .into(),
        );
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
    let keys = silentsilo_vault::load_fido_keys(&silo.path).map_err(|e| e.to_string())?;
    let stored = keys
        .active()
        .find(|k| k.credential_id == unlocked.credential_id)
        .ok_or_else(|| "That key is not enrolled on this silo.".to_string())?;
    silentsilo_vault::unwrap_dek_hex(&stored.wrapped_dek, &wrap_key)
        .map(|_| ())
        .map_err(|_| "That key could not confirm it is you.".to_string())
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
    crate::audit::set_unlocked_with(silo.id, Some(crate::audit::VIA_RECOVERY_CODE.into()));
    crate::audit::start_by_default_off_thread(&app, silo.id).await;
    crate::audit::record_off_thread(
        &app,
        crate::audit::event(crate::audit::codes::RECOVERY_CODE_USED),
    )
    .await?;
    crate::audit::record_off_thread(
        &app,
        crate::audit::event(crate::audit::codes::UNLOCKED).with("by", "recovery code"),
    )
    .await?;
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
    // What was saved and not sent yet goes before the key does.
    let unsent: Vec<Uuid> = crate::background::with_unsent(&state)
        .into_iter()
        .filter(|id| ids.contains(id))
        .collect();
    if !unsent.is_empty() {
        crate::background::push_unsent(&app, unsent, std::time::Duration::from_secs(10)).await;
    }
    for id in ids {
        state.close_session(&host(&app), id)?;
    }
    state.sweep_scratch();
    if state.open_silo_ids().is_empty() {
        tauri::async_runtime::spawn(silentsilo_vault::forget_cloud_sign_ins());
    }
    crate::viewer::wipe_opened(&app);
    crate::background::clear_clipboard(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn vault_read_passwords(state: State<AppState>) -> Result<String, String> {
    let entries = state.with_vfs(|_session, vfs| vfs.list_passwords())?;
    Ok(format!("[{}]", entries.join(",")))
}

#[tauri::command(async)]
pub fn vault_upsert_password(
    app: AppHandle,
    id: String,
    json: String,
    change: Option<crate::audit::EntryChange>,
    state: State<AppState>,
) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|e| format!("This entry's id is not valid ({e})."))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("This entry could not be read ({e})."))?;
    match parsed.get("id").and_then(|v| v.as_str()) {
        Some(inner) if inner == id.to_string() => {}
        Some(_) => return Err("This entry's id does not match the one being saved.".into()),
        None => return Err("This entry has no id.".into()),
    }
    // The category list is a row of its own, not an entry anyone edited.
    let is_entry = !parsed
        .get("type")
        .and_then(|v| v.as_str())
        .is_some_and(|t| t.starts_with("meta:"));
    if is_entry {
        let label = parsed
            .get("service")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let code = change.unwrap_or(crate::audit::EntryChange::Edited).code();
        crate::audit::record(&app, crate::audit::event(code).on(id.to_string(), label))?;
    }
    state.with_vfs(|_session, vfs| vfs.upsert_password(id, &json))
}

#[tauri::command(async)]
pub fn vault_delete_password(
    app: AppHandle,
    id: String,
    label: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|e| format!("This entry's id is not valid ({e})."))?;
    crate::audit::record(
        &app,
        crate::audit::event(crate::audit::codes::ENTRY_DELETED)
            .on(id.to_string(), label.unwrap_or_default()),
    )?;
    state.with_vfs(|_session, vfs| vfs.delete_password(id))
}

/// `audit` says what the secret was, for the silo's activity log; it is
/// written before the clipboard holds anything.
#[tauri::command]
pub async fn copy_secret_to_clipboard(
    app: AppHandle,
    text: String,
    audit: Option<crate::audit::CopiedSecret>,
) -> Result<(), String> {
    if let Some(audit) = audit {
        crate::audit::record_off_thread(&app, audit.event()).await?;
    }
    app.state::<crate::device_key::DeviceKey<tauri::Wry>>()
        .copy_secret(&text)
        .await
}

#[tauri::command(async)]
pub fn vault_root_folder(state: State<AppState>) -> Result<FolderEntry, String> {
    state.with_vfs(|_session, vfs| {
        let id = vfs.root_folder_id()?;
        vfs.get_folder(id)
    })
}

#[tauri::command(async)]
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
            // Opening a PDF asks for its page count first, once.
            if let (Some(id), "pages") = (id, what.as_str())
                && let Err(e) = crate::audit::file_opened(&app, id, "this app").await
            {
                responder.respond(respond(403, "text/plain", e.into_bytes()));
                return;
            }
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
        if let Some(file_id) = id
            && let Err(e) = crate::audit::file_opened(&app, file_id, "this app").await
        {
            responder.respond(respond(403, "text/plain", e.into_bytes()));
            return;
        }
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

#[tauri::command(async)]
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
    /// This phone's own key, the one removing which leaves the phone without
    /// its fingerprint unlock.
    this_phone: bool,
}

#[tauri::command(async)]
pub fn fido_list_keys(app: AppHandle, state: State<AppState>) -> Result<Vec<ListedKey>, String> {
    let silo = active_silo(&state)?;
    let own = this_phone_key(&app, &silo);
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
            this_phone: own.as_deref() == Some(k.credential_id.as_str()),
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
        return Err("That key is no longer on this silo.".into());
    };
    if key.managed() {
        return Err("An organisation administers this key, so it cannot be removed here.".into());
    }
    key.revoked = true;
    if keys.active().next().is_none() {
        return Err("This is the silo's last key. Add another before removing it.".into());
    }
    let label = keys
        .keys
        .iter()
        .find(|k| k.credential_id == credential_id)
        .map(|k| k.label.clone())
        .unwrap_or_default();
    crate::audit::record_off_thread(
        &app,
        crate::audit::event(crate::audit::codes::KEY_REMOVED).on(credential_id.clone(), label),
    )
    .await?;
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

#[tauri::command(async)]
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
        // Silos told this phone's name since the app started.
        let mut announced: std::collections::HashSet<Uuid> = Default::default();
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
                if announced.insert(id) {
                    announce_this_phone(&app, &silo).await;
                }
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
                // Away from the screen Android keeps the app off the network,
                // and a pass only to look for news would fail at every
                // provider. Changes still waiting are tried all the same.
                if waiting == 0
                    && !app
                        .state::<crate::background::BackgroundLock>()
                        .is_visible()
                {
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

/// Rebuilds this phone's copy of the silo from the latest snapshot in storage,
/// for a phone that fell behind a compaction: without it nothing syncs in
/// either direction. This phone's changes not sent yet are kept and sent
/// after. Progress as a join's.
#[tauri::command]
pub async fn vault_rebuild(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let silo = active_silo(&state)?;
    let targets = silentsilo_vault::load_targets(silo.id);
    if targets.is_empty() {
        return Err("This silo has no backup storage set up.".into());
    }
    let dek = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&silo.id)
            .ok_or("Unlock the silo first.")?
            .dek
            .clone()
    };
    // No pass alongside: it would replay what it fetched against the old
    // horizon onto the rebuilt tree.
    let _held = SyncHold::take(&state).await;
    let mut best: Option<(
        silentsilo_vfs::snapshot::Snapshot,
        Vec<silentsilo_vfs::OpRecord>,
    )> = None;
    for target in &targets {
        let Ok(store) = target.config.open() else {
            continue;
        };
        let emitter = app.clone();
        let mut report = move |fetched: usize, total: usize| {
            let _ = emitter.emit(
                "join-progress",
                JoinProgress {
                    fetched,
                    total,
                    building: false,
                },
            );
        };
        if let Ok(Some(found)) =
            silentsilo_sync::fetch_rebuild_reporting(&*store, &dek, &mut report).await
        {
            let better = best.as_ref().is_none_or(|(snapshot, ops)| {
                (found.0.horizon, found.1.len()) > (snapshot.horizon, ops.len())
            });
            if better {
                best = Some(found);
            }
        }
    }
    let (snapshot, incoming) =
        best.ok_or("Backup storage holds nothing to rebuild this silo from.")?;
    let _ = app.emit(
        "join-progress",
        JoinProgress {
            fetched: 0,
            total: 0,
            building: true,
        },
    );
    let handle = app.clone();
    let applied = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get_mut(&silo.id)
            .ok_or("The silo was locked during the rebuild.")?;
        let applied = silentsilo_sync::apply_rebuild(&mut session.conn, &snapshot, incoming)
            .map_err(|e| e.to_string())?
            .replay
            .applied;
        Ok::<_, String>(applied)
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit("vault-changed", ());
    Ok(applied)
}

/// Holds off sync passes while it lives: waits for one running to finish,
/// then marks one as running.
struct SyncHold<'a>(&'a AppState);

impl<'a> SyncHold<'a> {
    async fn take(state: &'a AppState) -> SyncHold<'a> {
        use std::sync::atomic::Ordering;
        while state
            .sync_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        SyncHold(state)
    }
}

impl Drop for SyncHold<'_> {
    fn drop(&mut self) {
        self.0
            .sync_in_flight
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Tells the silo what this phone is called, as the desktop does, so its
/// Devices list names the phone instead of "Unnamed device": the name of
/// this phone's key in the silo, else the name the phone gives itself.
/// Recorded only when it changed, so it costs nothing on later opens.
async fn announce_this_phone(app: &AppHandle, silo: &SiloEntry) {
    let label = crate::backup::phone_label(app, silo);
    let name = if this_phone_key(app, silo).is_some() {
        label
    } else {
        app.state::<crate::device_key::DeviceKey<tauri::Wry>>()
            .device_name()
            .await
            .unwrap_or(label)
    };
    let platform = if cfg!(target_os = "ios") {
        "iOS"
    } else {
        "Android"
    };
    let _ = app
        .state::<AppState>()
        .with_session_id(silo.id, |_session, vfs| {
            vfs.announce_device(Some(&name), platform)
        });
}

/// iOS can move an app's data container when the app is reinstalled or
/// updated, so the absolute path a silo was saved under goes stale while
/// the silo itself sits in this app's `silos/` folder as before. Such
/// entries are pointed back at it before anything opens a silo.
pub fn rehome_silos(app_data: &std::path::Path) {
    let mut registry = load_registry(app_data);
    let mut moved = false;
    for silo in &mut registry.silos {
        let here = app_data.join("silos").join(silo.id.to_string());
        if !silo.path.exists() && here.is_dir() {
            silo.path = here;
            moved = true;
        }
    }
    if moved {
        let _ = save_registry(app_data, &registry);
    }
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

#[cfg(test)]
mod rehome_tests {
    use super::*;

    #[test]
    fn a_silo_left_under_an_old_container_path_is_found_again() {
        let data = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        std::fs::create_dir_all(data.path().join("silos").join(id.to_string())).unwrap();
        let gone =
            std::path::PathBuf::from("/private/var/mobile/Containers/Data/Application/OLD/silos")
                .join(id.to_string());
        let kept = data.path().join("elsewhere");
        std::fs::create_dir_all(&kept).unwrap();
        let other = Uuid::new_v4();
        save_registry(
            data.path(),
            &silentsilo_vault::SiloRegistry {
                silos: vec![
                    SiloEntry {
                        id,
                        name: "Personal".into(),
                        path: gone,
                        last_opened: 0,
                        auto_lock_minutes: None,
                    },
                    SiloEntry {
                        id: other,
                        name: "Work".into(),
                        path: kept.clone(),
                        last_opened: 0,
                        auto_lock_minutes: None,
                    },
                ],
                active: Some(id),
            },
        )
        .unwrap();

        rehome_silos(data.path());

        let registry = load_registry(data.path());
        assert_eq!(
            registry.silos[0].path,
            data.path().join("silos").join(id.to_string())
        );
        assert_eq!(
            registry.silos[1].path, kept,
            "a silo where it was saved stays put"
        );
    }
}
