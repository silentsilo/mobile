//! Changing what is in a silo and which silos are on the phone: renaming,
//! the trash, and switching between or removing silos. Named like the
//! desktop's commands they mirror.

use silentsilo_app::AppState;
use silentsilo_core::{FileEntry, FolderEntry, TrashItem};
use silentsilo_vault::{load_registry, save_registry};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::commands::{active_silo, host};

fn id(raw: &str) -> Result<Uuid, String> {
    Uuid::parse_str(raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_rename_file(
    state: State<'_, AppState>,
    file_id: String,
    new_name: String,
) -> Result<FileEntry, String> {
    let file_id = id(&file_id)?;
    state.with_vfs(|_session, vfs| vfs.rename_file(file_id, new_name.trim()))
}

#[tauri::command]
pub fn vault_rename_folder(
    state: State<'_, AppState>,
    folder_id: String,
    new_name: String,
) -> Result<FolderEntry, String> {
    let folder_id = id(&folder_id)?;
    state.with_vfs(|_session, vfs| vfs.rename_folder(folder_id, new_name.trim()))
}

#[tauri::command]
pub fn vault_trash_file(state: State<'_, AppState>, file_id: String) -> Result<(), String> {
    let file_id = id(&file_id)?;
    state.with_vfs(|_session, vfs| vfs.trash_file(file_id))
}

#[tauri::command]
pub fn vault_trash_folder(state: State<'_, AppState>, folder_id: String) -> Result<(), String> {
    let folder_id = id(&folder_id)?;
    state.with_vfs(|_session, vfs| vfs.trash_folder(folder_id))
}

#[tauri::command]
pub fn vault_list_trash(state: State<'_, AppState>) -> Result<Vec<TrashItem>, String> {
    state.with_vfs(|_session, vfs| vfs.list_trash())
}

#[tauri::command]
pub fn vault_restore_file(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<FileEntry, String> {
    let file_id = id(&file_id)?;
    state.with_vfs(|_session, vfs| vfs.restore_file(file_id))
}

#[tauri::command]
pub fn vault_restore_folder(
    state: State<'_, AppState>,
    folder_id: String,
) -> Result<FolderEntry, String> {
    let folder_id = id(&folder_id)?;
    state.with_vfs(|_session, vfs| vfs.restore_folder(folder_id))
}

/// Deletes trashed entries for good: every one when `ids` is empty. The
/// local copies of their content go too; storage copies are left to the
/// orphan sweep, which removes only what stays unreferenced across passes,
/// so a restore made meanwhile on another device loses nothing.
#[tauri::command]
pub fn vault_purge_trash(state: State<'_, AppState>, ids: Vec<String>) -> Result<u64, String> {
    let ids: Vec<Uuid> = ids.iter().map(|raw| id(raw)).collect::<Result<_, _>>()?;
    let silo = active_silo(&state)?;
    let (removed, blobs) = state.with_vfs(|_session, vfs| {
        if ids.is_empty() {
            vfs.empty_trash()
        } else {
            vfs.purge_items(&ids)
        }
    })?;
    for blob_id in blobs {
        let _ = silentsilo_vault::remove_blob_from_cache(&silo.path, blob_id);
    }
    Ok(removed)
}

#[derive(serde::Serialize)]
pub struct SiloChoice {
    id: String,
    name: String,
    active: bool,
    unlocked: bool,
}

#[tauri::command]
pub fn silo_list(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<SiloChoice>, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let active = active_silo(&state).ok().map(|s| s.id);
    Ok(load_registry(&data)
        .silos
        .into_iter()
        .map(|s| SiloChoice {
            id: s.id.to_string(),
            name: s.name.clone(),
            active: Some(s.id) == active,
            unlocked: state.session_is_open(s.id),
        })
        .collect())
}

#[tauri::command]
pub fn silo_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    silo_id: String,
) -> Result<(), String> {
    let silo_id = id(&silo_id)?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut registry = load_registry(&data);
    let entry = registry
        .get(silo_id)
        .cloned()
        .ok_or_else(|| "That silo is not on this phone.".to_string())?;
    registry.active = Some(silo_id);
    save_registry(&data, &registry).map_err(|e| e.to_string())?;
    *state.active_silo.lock().map_err(|e| e.to_string())? = Some(entry);
    Ok(())
}

/// Removes a silo from this phone only: its local copy, this phone's key for
/// it, its storage settings and backup. Storage and the other devices keep
/// the silo; joining again takes the recovery code.
#[tauri::command]
pub async fn silo_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    silo_id: String,
) -> Result<(), String> {
    let silo_id = id(&silo_id)?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut registry = load_registry(&data);
    let silo = registry
        .get(silo_id)
        .cloned()
        .ok_or_else(|| "That silo is not on this phone.".to_string())?;
    // Only a folder this app made: never follow a registry entry elsewhere.
    let silos_dir = data.join("silos");
    if silo.path.parent() != Some(silos_dir.as_path()) {
        return Err("This silo's folder is not where the app keeps silos.".into());
    }

    state.close_session(&host(&app), silo_id)?;
    if crate::backup::sender_vault(&data) == Some(silo_id) {
        let _ = crate::backup::stop(&app).await;
    }
    if let Some(credential_id) = crate::commands::forget_device_key(&app, silo_id) {
        let _ = app
            .state::<crate::device_key::DeviceKey<tauri::Wry>>()
            .remove(&credential_id)
            .await;
    }
    silentsilo_vault::clear_credentials(silo_id);
    silentsilo_vault::clear_s3_config(silo_id);
    silentsilo_vault::wipe_machine_state(&silo.path);
    let _ = std::fs::remove_dir_all(silentsilo_vault::workdir::secrets_dir_for(silo_id));
    std::fs::remove_dir_all(&silo.path).map_err(|e| e.to_string())?;

    registry.remove(silo_id);
    registry.active = registry.silos.first().map(|s| s.id);
    save_registry(&data, &registry).map_err(|e| e.to_string())?;
    *state.active_silo.lock().map_err(|e| e.to_string())? = registry.silos.first().cloned();
    let _ = app.emit("vault-changed", ());
    Ok(())
}
