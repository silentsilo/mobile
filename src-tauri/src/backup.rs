//! Photo and contacts backup while the silo is locked.
//!
//! Set up while the silo is open: this phone gets a signing key, registers
//! it as a sender (sealed under the content KEK, so only a device holding
//! the silo can), and learns the inbox key. From then on the job in
//! `Backup.kt` seals each new photo to that key and signs it, with no key
//! that opens anything. Any unlocked device, this phone included, imports
//! what arrives. Formats: core FORMATS.md, "The inbox".

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use silentsilo_app::AppState;
use silentsilo_sync::inbox::{self, INBOX_VERSION, SenderRecord};
use silentsilo_vault::{BackupTarget, TargetRole};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, State};
use uuid::Uuid;

use crate::background::BackgroundLock;

/// What this phone needs to send to one silo, none of it secret.
#[derive(Serialize, Deserialize)]
struct SenderFile {
    vault_id: Uuid,
    sender_id: Uuid,
    key_id: Uuid,
    /// The inbox public key, uncompressed P-256, hex.
    inbox_public: String,
}

fn sender_path(data_dir: &Path) -> PathBuf {
    data_dir.join("backup-sender.json")
}

fn read_sender(data_dir: &Path) -> Option<SenderFile> {
    serde_json::from_slice(&std::fs::read(sender_path(data_dir)).ok()?).ok()
}

/// Where the phone sends: the first working copy. An archive copy never
/// sees a delete, so imported items would stay there for good.
fn send_target(vault_id: Uuid) -> Option<BackupTarget> {
    let targets = silentsilo_vault::load_targets(vault_id);
    targets
        .iter()
        .find(|t| t.role == TargetRole::Working)
        .or(targets.first())
        .cloned()
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    #[serde(default)]
    pub vault_id: String,
    #[serde(default)]
    pub photos: bool,
    #[serde(default)]
    pub contacts: bool,
    #[serde(default = "yes")]
    pub wifi_only: bool,
    #[serde(default)]
    pub charging_only: bool,
    #[serde(default)]
    pub sent: i64,
    #[serde(default)]
    pub last_run: i64,
    #[serde(default)]
    pub last_error: String,
    #[serde(default)]
    pub photos_allowed: bool,
    #[serde(default)]
    pub contacts_allowed: bool,
    #[serde(default = "yes")]
    pub remind: bool,
    #[serde(default)]
    pub waiting: i64,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSettings {
    pub photos: bool,
    pub contacts: bool,
    pub wifi_only: bool,
    pub charging_only: bool,
    #[serde(default)]
    pub include_existing: bool,
    #[serde(default = "yes")]
    pub remind: bool,
}

#[cfg(target_os = "android")]
pub struct Backup<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(not(target_os = "android"))]
pub struct Backup<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> Backup<R> {
    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        payload: serde_json::Value,
    ) -> Result<T, String> {
        #[cfg(target_os = "android")]
        {
            self.0
                .run_mobile_plugin_async(command, payload)
                .await
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (command, payload);
            Err("This build has no background backup.".into())
        }
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("backup")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.silentsilo.mobile", "BackupPlugin")?;
                app.manage(Backup(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(Backup::<R>(std::marker::PhantomData));
            }
            Ok(())
        })
        .build()
}

fn plugin(app: &AppHandle) -> State<'_, Backup<tauri::Wry>> {
    app.state::<Backup<tauri::Wry>>()
}

#[tauri::command]
pub async fn backup_status(app: AppHandle) -> Result<BackupStatus, String> {
    plugin(&app).call("status", serde_json::json!({})).await
}

/// Turns backup on or changes what it does. Needs the silo open: the first
/// time, registering this phone as a sender takes the content KEK.
#[tauri::command]
pub async fn backup_configure(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: BackupSettings,
) -> Result<BackupStatus, String> {
    if !settings.photos && !settings.contacts {
        return backup_disable(app, state).await;
    }
    let silo = crate::commands::active_silo(&state)?;
    let kek = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&silo.id)
            .ok_or_else(|| "Unlock the silo first.".to_string())?
            .kek
            .clone()
    };
    let credential_id = crate::commands::this_phone_key(&app, &silo)
        .ok_or_else(|| "This phone has no key for this silo yet.".to_string())?;

    // The permission dialog pauses the app; that is not leaving it.
    let allowed: BackupStatus = {
        let lock = app.state::<BackgroundLock>();
        let _prompt = lock.prompt();
        plugin(&app)
            .call(
                "requestAccess",
                serde_json::json!({
                    "photos": settings.photos,
                    "contacts": settings.contacts,
                    "remind": settings.remind,
                }),
            )
            .await?
    };
    if settings.photos && !allowed.photos_allowed {
        return Err(
            "Photos were not allowed. Allow them in the phone's settings for SilentSilo.".into(),
        );
    }
    if settings.contacts && !allowed.contacts_allowed {
        return Err(
            "Contacts were not allowed. Allow them in the phone's settings for SilentSilo.".into(),
        );
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let label = silentsilo_vault::load_fido_keys(&silo.path)
        .ok()
        .and_then(|keys| {
            keys.active()
                .find(|k| k.credential_id == credential_id)
                .map(|k| k.label.clone())
        })
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| "This phone".into());

    if read_sender(&data_dir).is_none_or(|s| s.vault_id != silo.id) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Key {
            public_key: String,
        }
        let key: Key = plugin(&app)
            .call(
                "senderKey",
                serde_json::json!({ "vaultId": silo.id.to_string() }),
            )
            .await?;
        let target =
            send_target(silo.id).ok_or_else(|| "This silo has no storage set up.".to_string())?;
        let store = target.config.open().map_err(|e| e.to_string())?;
        let (key_id, inbox_public) = inbox::ensure_inbox_key(&*store, &kek)
            .await
            .map_err(|e| e.to_string())?;
        let sender_id = Uuid::new_v4();
        inbox::register_sender(
            &*store,
            &kek,
            &SenderRecord {
                version: INBOX_VERSION,
                sender_id,
                public_key: key.public_key,
                credential_id,
                label: label.clone(),
                created_at: now(),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        let file = SenderFile {
            vault_id: silo.id,
            sender_id,
            key_id,
            inbox_public: hex::encode(inbox_public),
        };
        std::fs::write(
            sender_path(&data_dir),
            serde_json::to_vec(&file).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }

    plugin(&app)
        .call(
            "configure",
            serde_json::json!({
                "vaultId": silo.id.to_string(),
                "label": label,
                "photos": settings.photos,
                "contacts": settings.contacts,
                "wifiOnly": settings.wifi_only,
                "chargingOnly": settings.charging_only,
                "includeExisting": settings.include_existing,
                "remind": settings.remind,
            }),
        )
        .await
}

/// Stops backup and forgets the signing key. The sender record is removed
/// from storage when storage answers; if it does not, the record stays
/// harmless, because the key that could sign for it is gone.
#[tauri::command]
pub async fn backup_disable(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BackupStatus, String> {
    let _ = state;
    stop(&app).await
}

pub async fn stop(app: &AppHandle) -> Result<BackupStatus, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(sender) = read_sender(&data_dir) {
        if let Some(target) = send_target(sender.vault_id)
            && let Ok(store) = target.config.open()
        {
            let _ = inbox::remove_sender(&*store, sender.sender_id).await;
        }
        let _ = std::fs::remove_file(sender_path(&data_dir));
    }
    plugin(app).call("disable", serde_json::json!({})).await
}

/// Items sent to the silo's inbox and not imported yet. Needs no key: the
/// envelopes are listed, not opened.
async fn waiting_for(vault_id: Uuid) -> Result<usize, String> {
    let target = send_target(vault_id).ok_or_else(|| "no storage".to_string())?;
    let store = target.config.open().map_err(|e| e.to_string())?;
    let items = store
        .list(inbox::INBOX_ITEMS_PREFIX)
        .await
        .map_err(|e| e.to_string())?;
    Ok(items.iter().filter(|o| o.key.ends_with(".env")).count())
}

/// `None` when backup is not set up here or storage did not answer.
#[tauri::command]
pub async fn backup_waiting(app: AppHandle) -> Result<Option<usize>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let Some(sender) = read_sender(&data_dir) else {
        return Ok(None);
    };
    Ok(waiting_for(sender.vault_id).await.ok())
}

/// For the job: the count, or -1 when it could not be read.
#[cfg(target_os = "android")]
pub fn waiting_from_job(data_dir: &Path) -> i64 {
    let Some(sender) = read_sender(data_dir) else {
        return -1;
    };
    tauri::async_runtime::block_on(waiting_for(sender.vault_id))
        .map(|n| n as i64)
        .unwrap_or(-1)
}

/// How many photos the phone holds and their size, before sending them all.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoCount {
    pub count: i64,
    pub bytes: i64,
}

#[tauri::command]
pub async fn backup_photo_count(app: AppHandle) -> Result<PhotoCount, String> {
    let lock = app.state::<BackgroundLock>();
    let _prompt = lock.prompt();
    plugin(&app).call("photoCount", serde_json::json!({})).await
}

#[tauri::command]
pub async fn backup_run_now(app: AppHandle) -> Result<(), String> {
    plugin(&app)
        .call::<serde_json::Value>("runNow", serde_json::json!({}))
        .await
        .map(|_| ())
}

/// One item as the job hands it over.
#[cfg(target_os = "android")]
pub struct JobItem {
    pub data_dir: PathBuf,
    pub source: PathBuf,
    pub item_id: String,
    pub name: String,
    pub mime_type: Option<String>,
    pub taken_at: Option<i64>,
    /// Folder names below the root, one per line.
    pub folder: String,
    pub kind: String,
}

/// `ok`, `retry: why` or `skip: why`, for `Backup.kt`.
#[cfg(target_os = "android")]
pub fn send_from_job(item: JobItem) -> String {
    let Some(sender) = read_sender(&item.data_dir) else {
        return "retry: backup is not set up on this phone".into();
    };
    let Ok(item_id) = Uuid::parse_str(&item.item_id) else {
        return "skip: the item has no valid id".into();
    };
    let Some(inbox_public) = hex::decode(&sender.inbox_public)
        .ok()
        .and_then(|b| b.try_into().ok())
    else {
        return "retry: the saved inbox key is unreadable".into();
    };
    let Some(target) = send_target(sender.vault_id) else {
        return "retry: this silo's storage settings could not be read".into();
    };
    let store = match target.config.open() {
        Ok(store) => store,
        Err(e) => return format!("retry: {e}"),
    };
    let identity = inbox::SenderIdentity {
        vault_id: sender.vault_id,
        sender_id: sender.sender_id,
        key_id: sender.key_id,
        inbox_public,
    };
    let outgoing = inbox::OutgoingItem {
        item_id,
        source: &item.source,
        name: item.name,
        mime_type: item.mime_type,
        taken_at: item.taken_at,
        folder: item
            .folder
            .split('\n')
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
            .collect(),
        source_kind: item.kind,
    };
    let vault = sender.vault_id.to_string();
    let sign = move |message: &[u8]| {
        let der = crate::android::sign(&vault, message)
            .ok_or_else(|| "this phone's signing key refused".to_string())?;
        silentsilo_crypto::inbox::signature_from_der(&der).map_err(|e| e.to_string())
    };
    match tauri::async_runtime::block_on(send(&*store, &identity, &outgoing, &sign)) {
        Ok(()) => "ok".into(),
        Err(e) => format!("retry: {e}"),
    }
}

#[cfg(target_os = "android")]
async fn send(
    store: &dyn silentsilo_store::ObjectStore,
    identity: &inbox::SenderIdentity,
    item: &inbox::OutgoingItem<'_>,
    sign: &inbox::ItemSigner<'_>,
) -> Result<(), String> {
    inbox::send_item(store, identity, item, sign)
        .await
        .map_err(|e| e.to_string())
}
