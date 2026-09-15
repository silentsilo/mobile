//! A silo made on the phone, and its storage set or changed from the phone.
//! The same steps the desktop takes, in its order: the silo, then its first
//! key, then a recovery code, then storage and a first sync. Nothing reaches
//! storage until it is saved here.

use serde::Serialize;
use silentsilo_app::{AppState, StoreConfigInput};
use silentsilo_core::VaultMeta;
use silentsilo_store::StoreConfig;
use silentsilo_vault::{
    BackupTarget, LocalVaultAuth, SiloEntry, TargetRole, VaultSession, load_registry, save_registry,
};
use silentsilo_vfs::Vfs;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::commands::{active_silo, host};

/// Makes a new silo on the phone and opens it. Only a device secret opens
/// it until the phone key is added, which is the next step.
#[tauri::command]
pub async fn silo_create(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<VaultMeta, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Give the silo a name.".into());
    }
    let app_data = crate::background::data_dir()
        .cloned()
        .ok_or("The app's folder is not known yet.")?;
    let mut registry = load_registry(&app_data);
    if registry
        .silos
        .iter()
        .any(|s| s.name.eq_ignore_ascii_case(&name))
    {
        return Err("A silo with that name is already on this phone.".into());
    }

    let vault_id = Uuid::new_v4();
    let root = app_data.join("silos").join(vault_id.to_string());
    let device_secret = hex::encode(silentsilo_crypto::generate_dek().as_bytes());
    let (session, meta) = tauri::async_runtime::spawn_blocking({
        let root = root.clone();
        let device_secret = device_secret.clone();
        move || -> Result<(VaultSession, VaultMeta), String> {
            std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            silentsilo_vault::write_marker(&root, vault_id).map_err(|e| e.to_string())?;
            silentsilo_vault::save_credentials(&LocalVaultAuth {
                vault_id,
                device_secret: device_secret.clone(),
            })
            .map_err(|e| e.to_string())?;
            let session = VaultSession::provision(root, vault_id, &device_secret)
                .map_err(|e| e.to_string())?;
            let vfs = Vfs::new(&session);
            vfs.ensure_initialized().map_err(|e| e.to_string())?;
            let meta = vfs.meta().map_err(|e| e.to_string())?;
            session.backup_locally().map_err(|e| e.to_string())?;
            Ok((session, meta))
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    let entry = SiloEntry {
        id: vault_id,
        name,
        path: root,
        last_opened: 0,
        auto_lock_minutes: None,
    };
    registry.upsert(entry.clone());
    registry.active = Some(vault_id);
    save_registry(&app_data, &registry).map_err(|e| e.to_string())?;
    *state.active_silo.lock().map_err(|e| e.to_string())? = Some(entry);
    state.open_session(&host(&app), vault_id, session)?;
    Ok(meta)
}

/// Makes the open silo's recovery code and returns it, the only time it is
/// shown. A code made again replaces the old one once it syncs.
#[tauri::command]
pub fn recovery_create(state: State<'_, AppState>) -> Result<String, String> {
    let silo = active_silo(&state)?;
    state.with_session_id(silo.id, |session, _vfs| {
        let (code, envelope) = silentsilo_vault::create_recovery_envelope(&session.dek)
            .map_err(|e| silentsilo_core::CoreError::Invalid(e.to_string()))?;
        silentsilo_vault::save_recovery_envelope(&session.paths.root, &envelope)
            .map_err(|e| silentsilo_core::CoreError::Invalid(e.to_string()))?;
        Ok(code)
    })
}

/// Where the silo's backup is, without its secrets, for the screen that
/// changes it.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageView {
    configured: bool,
    kind: String,
    endpoint: String,
    region: String,
    bucket: String,
    access_key_id: String,
    url: String,
    host: String,
    port: u16,
    username: String,
    path: String,
    /// How many copies the silo has; the phone changes only the first.
    copies: usize,
}

#[tauri::command]
pub fn storage_view(state: State<'_, AppState>) -> Result<StorageView, String> {
    let silo = active_silo(&state)?;
    let targets = silentsilo_vault::load_targets(silo.id);
    let Some(first) = targets.first() else {
        return Ok(StorageView::default());
    };
    let mut view = StorageView {
        configured: true,
        copies: targets.len(),
        ..StorageView::default()
    };
    match &first.config {
        StoreConfig::S3(c) => {
            view.kind = "s3".into();
            view.endpoint = c.endpoint.clone();
            view.region = c.region.clone();
            view.bucket = c.bucket.clone();
            view.access_key_id = c.access_key_id.clone();
        }
        StoreConfig::WebDav(c) => {
            view.kind = "web-dav".into();
            view.url = c.url.clone();
            view.username = c.username.clone();
        }
        StoreConfig::Sftp(c) => {
            view.kind = "sftp".into();
            view.host = c.host.clone();
            view.port = c.port;
            view.username = c.username.clone();
            view.path = c.path.clone();
        }
        StoreConfig::Folder { .. } => view.kind = "folder".into(),
    }
    Ok(view)
}

/// Saves the open silo's backup storage, first or changed. A secret left
/// empty keeps the one stored. Refused when the place cannot be written to
/// or already holds another silo.
#[tauri::command]
pub async fn storage_save(
    state: State<'_, AppState>,
    config: StoreConfigInput,
) -> Result<(), String> {
    let silo = active_silo(&state)?;
    if !state.open_silo_ids().contains(&silo.id) {
        return Err("Unlock the silo first.".into());
    }
    let mut targets = silentsilo_vault::load_targets(silo.id);
    let existing = targets.first().map(|t| t.config.clone());
    // A blank secret keeps the stored one, for the same server only.
    let config = config.into_config(existing)?;
    let store = config.open().map_err(|e| e.to_string())?;
    store
        .check()
        .await
        .map_err(|e| format!("The storage did not accept a test write: {e}"))?;
    silentsilo_sync::refuse_foreign_vault(&*store, silo.id)
        .await
        .map_err(|e| e.to_string())?;

    match targets.first_mut() {
        Some(first) => first.config = config,
        None => targets.push(BackupTarget {
            config,
            label: String::new(),
            role: TargetRole::Working,
        }),
    }
    silentsilo_vault::save_targets(silo.id, &targets).map_err(|e| e.to_string())
}
