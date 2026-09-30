//! Every place the open silo backs up to, from the phone: the list, a copy
//! added, a copy removed. The sync pass already writes to all of them; the
//! main copy is the one `storage_save` changes.

use serde::Serialize;
use silentsilo_app::{AppState, StoreConfigInput, StoreConfigView};
use silentsilo_vault::{BackupTarget, TargetRole};
use tauri::State;

use crate::commands::active_silo;

/// One copy as the screen lists it: never a secret.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyView {
    id: String,
    label: String,
    config: StoreConfigView,
    /// The one the storage screen changes, and the one the app keeps tidy.
    primary: bool,
    /// Unix seconds of the last pass it took everything, 0 for never or
    /// not known while locked.
    last_success: i64,
    archive: bool,
}

#[tauri::command]
pub fn backup_targets_list(state: State<'_, AppState>) -> Result<Vec<CopyView>, String> {
    let silo = active_silo(&state)?;
    let targets = silentsilo_vault::load_targets(silo.id);
    let written: Vec<i64> = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        match sessions.get(&silo.id) {
            Some(session) => targets
                .iter()
                .map(|t| {
                    silentsilo_vfs::target_last_success(&session.conn, t.config.target_id())
                        .unwrap_or(0)
                })
                .collect(),
            None => vec![0; targets.len()],
        }
    };
    Ok(targets
        .into_iter()
        .zip(written)
        .enumerate()
        .map(|(index, (target, last_success))| CopyView {
            id: target.config.target_id().to_string(),
            label: target.label,
            config: StoreConfigView::from(&target.config),
            primary: index == 0,
            last_success,
            archive: !target.role.allows_delete(),
        })
        .collect())
}

/// Adds another place to back up to, checked before it is saved, as on
/// desktop: storage that cannot be written to is not a copy.
#[tauri::command]
pub async fn backup_target_add(
    state: State<'_, AppState>,
    config: StoreConfigInput,
) -> Result<(), String> {
    let silo = active_silo(&state)?;
    if !state.open_silo_ids().contains(&silo.id) {
        return Err("Unlock the silo first.".into());
    }
    let described = crate::cloud::describe(config, None)?;
    silentsilo_sync::refuse_foreign_vault(&*described.store, silo.id)
        .await
        .map_err(|e| e.to_string())?;
    described
        .store
        .check()
        .await
        .map_err(|e| format!("The backup storage did not accept a test write: {e}"))?;
    let mut targets = silentsilo_vault::load_targets(silo.id);
    if targets
        .iter()
        .any(|t| t.config.target_id() == described.config.target_id())
    {
        return Err("This silo already backs up there.".into());
    }
    targets.push(BackupTarget {
        config: described.config.clone(),
        label: String::new(),
        role: TargetRole::Working,
    });
    silentsilo_vault::save_targets(silo.id, &targets).map_err(|e| e.to_string())?;
    described.adopt().await
}

/// Stops backing up to a copy. Nothing there is deleted. The main copy is
/// changed on the storage screen, not removed, so the silo always keeps one.
#[tauri::command]
pub async fn backup_target_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let silo = active_silo(&state)?;
    if !state.open_silo_ids().contains(&silo.id) {
        return Err("Unlock the silo first.".into());
    }
    let targets = silentsilo_vault::load_targets(silo.id);
    if targets
        .first()
        .is_some_and(|t| t.config.target_id().to_string() == id)
    {
        return Err("The main copy can be changed, not removed.".into());
    }
    let (removed, kept): (Vec<_>, Vec<_>) = targets
        .into_iter()
        .partition(|t| t.config.target_id().to_string() == id);
    // A cloud sign-in ends with the copy, at the provider where that touches
    // nothing else.
    for target in removed.iter().filter(|t| t.config.cloud().is_some()) {
        silentsilo_vault::end_cloud_sign_in(&target.config).await;
    }
    silentsilo_vault::save_targets(silo.id, &kept).map_err(|e| e.to_string())
}
