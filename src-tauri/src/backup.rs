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
    /// This phone's name in the silo, for the folders items go to.
    #[serde(default = "this_phone")]
    label: String,
}

fn this_phone() -> String {
    "This phone".into()
}

fn sender_path(data_dir: &Path) -> PathBuf {
    data_dir.join("backup-sender.json")
}

/// This phone's name in a silo: the label of its key there. Every folder
/// the phone sends to is named by it, so photos, contacts and shared files
/// land side by side.
pub fn phone_label(app: &AppHandle, silo: &silentsilo_vault::SiloEntry) -> String {
    crate::commands::this_phone_key(app, silo)
        .and_then(|credential_id| {
            silentsilo_vault::load_fido_keys(&silo.path)
                .ok()
                .and_then(|keys| {
                    keys.active()
                        .find(|k| k.credential_id == credential_id)
                        .map(|k| k.label.clone())
                })
        })
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(this_phone)
}

/// The silo this phone sends backups to, if any.
pub fn sender_vault(data_dir: &Path) -> Option<Uuid> {
    read_sender(data_dir).map(|s| s.vault_id)
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
    #[serde(default)]
    pub videos: bool,
    #[serde(default)]
    pub videos_allowed: bool,
    /// Gallery folders backed up; empty means all of them.
    #[serde(default)]
    pub folders: Vec<String>,
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
    #[serde(default)]
    pub videos: bool,
    #[serde(default)]
    pub folders: Vec<String>,
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
    if !settings.photos && !settings.videos && !settings.contacts {
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
                    "videos": settings.videos,
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
    if settings.videos && !allowed.videos_allowed {
        return Err(
            "Videos were not allowed. Allow them in the phone's settings for SilentSilo.".into(),
        );
    }
    if settings.contacts && !allowed.contacts_allowed {
        return Err(
            "Contacts were not allowed. Allow them in the phone's settings for SilentSilo.".into(),
        );
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let label = phone_label(&app, &silo);

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
            label: label.clone(),
        };
        std::fs::write(
            sender_path(&data_dir),
            serde_json::to_vec(&file).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    } else if let Some(mut file) = read_sender(&data_dir)
        && file.label != label
    {
        // One name for every folder this phone sends to: photos and
        // contacts take it from the job's settings, shared files from here.
        file.label = label.clone();
        let _ = std::fs::write(
            sender_path(&data_dir),
            serde_json::to_vec(&file).map_err(|e| e.to_string())?,
        );
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
                "videos": settings.videos,
                "folders": settings.folders,
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

// ── Items that went missing ─────────────────────────────────────────
//
// Sending is not arriving: storage can lose an item before any device
// imports it. The phone keeps a ledger of what it sent; once the silo is
// open here, an item the silo knows is done, and one that is neither in the
// silo nor still in the inbox is sent again from the phone. The item id is
// the same, so an item that did arrive after all is skipped, never doubled.

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sent {
    item_id: Uuid,
    /// `photo` or `contacts`.
    kind: String,
    /// What `Backup.kt` needs to send it again: `<media id>:<date added>`
    /// for a photo, the vCard hash for contacts.
    reference: String,
    sent_at: i64,
    /// Found in neither place by the last check. Lost only when the next
    /// check agrees: an import finishing elsewhere during this device's pass
    /// takes the item from the inbox before its record reaches here.
    #[serde(default)]
    missing: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Ledger {
    #[serde(default)]
    sent: Vec<Sent>,
    /// Missing items the job has not sent again yet.
    #[serde(default)]
    resend: Vec<Sent>,
}

/// The job and the app run in one process and both write the ledger.
static LEDGER: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Seconds an item may be absent from both the silo and the inbox before
/// it counts as lost: long enough for an import finishing elsewhere.
const LOST_AFTER: i64 = 600;

fn ledger_path(data_dir: &Path) -> PathBuf {
    data_dir.join("backup-sent.json")
}

fn load_ledger(data_dir: &Path) -> Ledger {
    std::fs::read(ledger_path(data_dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_ledger(data_dir: &Path, ledger: &Ledger) {
    let path = ledger_path(data_dir);
    let temp = path.with_extension("json.part");
    if let Ok(bytes) = serde_json::to_vec(ledger)
        && std::fs::write(&temp, bytes).is_ok()
    {
        let _ = std::fs::rename(&temp, &path);
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn record_sent(data_dir: &Path, item_id: Uuid, kind: &str, reference: &str) {
    let _held = LEDGER.lock();
    let mut ledger = load_ledger(data_dir);
    ledger.sent.retain(|s| s.item_id != item_id);
    ledger.resend.retain(|s| s.item_id != item_id);
    ledger.sent.push(Sent {
        item_id,
        kind: kind.into(),
        reference: reference.into(),
        sent_at: now(),
        missing: false,
    });
    save_ledger(data_dir, &ledger);
}

/// What the job should send again, as `[{kind, reference}]`.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn resends(data_dir: &Path) -> String {
    let _held = LEDGER.lock();
    let ledger = load_ledger(data_dir);
    serde_json::to_string(
        &ledger
            .resend
            .iter()
            .map(|s| serde_json::json!({ "kind": s.kind, "reference": s.reference }))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".into())
}

/// The job sent it again, or it no longer exists on the phone.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn resolve_resend(data_dir: &Path, kind: &str, reference: &str) {
    let _held = LEDGER.lock();
    let mut ledger = load_ledger(data_dir);
    ledger
        .resend
        .retain(|s| !(s.kind == kind && s.reference == reference));
    save_ledger(data_dir, &ledger);
}

/// After a sync pass on this phone: settles what the ledger says was sent.
pub async fn confirm_sent(app: &AppHandle, silo: &silentsilo_vault::SiloEntry) {
    let Some(data_dir) = crate::background::data_dir() else {
        return;
    };
    if sender_vault(data_dir) != Some(silo.id) {
        return;
    }
    let pending = {
        let _held = LEDGER.lock();
        load_ledger(data_dir).sent
    };
    if pending.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    let known: Vec<Uuid> = pending
        .iter()
        .filter(|s| {
            state
                .with_session_id(silo.id, |_session, vfs| vfs.file_id_known(s.item_id))
                .unwrap_or(false)
        })
        .map(|s| s.item_id)
        .collect();

    let mut absent = Vec::new();
    let old: Vec<&Sent> = pending
        .iter()
        .filter(|s| !known.contains(&s.item_id) && now() - s.sent_at > LOST_AFTER)
        .collect();
    if !old.is_empty()
        && let Some(target) = send_target(silo.id)
        && let Ok(store) = target.config.open()
    {
        for sent in old {
            let envelope = format!("{}{}.env", inbox::INBOX_ITEMS_PREFIX, sent.item_id);
            // Unreachable storage says nothing either way: try again later.
            if let Ok(None) = store.head(&envelope).await {
                absent.push(sent.item_id);
            }
        }
    }
    let _held = LEDGER.lock();
    let mut ledger = load_ledger(data_dir);
    if settle_ledger(&mut ledger, &known, &absent) {
        save_ledger(data_dir, &ledger);
    }
}

/// Drops what the silo knows, and moves to the resend list what two checks
/// in a row found nowhere. True when anything changed.
fn settle_ledger(ledger: &mut Ledger, known: &[Uuid], absent: &[Uuid]) -> bool {
    let mut changed = false;
    let mut moved = Vec::new();
    ledger.sent.retain_mut(|s| {
        if known.contains(&s.item_id) {
            changed = true;
            return false;
        }
        let now_absent = absent.contains(&s.item_id);
        if now_absent && s.missing {
            moved.push(s.clone());
            changed = true;
            return false;
        }
        if s.missing != now_absent {
            s.missing = now_absent;
            changed = true;
        }
        true
    });
    ledger.resend.extend(moved);
    changed
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

/// One folder of the phone's gallery: Camera, Screenshots, WhatsApp Images.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFolder {
    pub id: String,
    pub name: String,
    pub photos: i64,
    pub videos: i64,
    pub bytes: i64,
}

/// The gallery's folders, asking for photo and video access first.
#[tauri::command]
pub async fn backup_media_folders(app: AppHandle) -> Result<Vec<MediaFolder>, String> {
    #[derive(Deserialize)]
    struct Folders {
        #[serde(default)]
        folders: Vec<MediaFolder>,
    }
    let lock = app.state::<BackgroundLock>();
    let _prompt = lock.prompt();
    let listed: Folders = plugin(&app)
        .call("mediaFolders", serde_json::json!({}))
        .await?;
    Ok(listed.folders)
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
    /// Kotlin's descriptor, open until the call returns; read through a copy.
    pub source: std::os::fd::BorrowedFd<'static>,
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
    let Ok(item_id) = Uuid::parse_str(&item.item_id) else {
        return "skip: the item has no valid id".into();
    };
    let mut source = match item.source.try_clone_to_owned() {
        Ok(fd) => std::fs::File::from(fd),
        Err(e) => return format!("skip: the item could not be read: {e}"),
    };
    let folder = item
        .folder
        .split('\n')
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .collect();
    match send_one(
        &item.data_dir,
        &mut source,
        item_id,
        item.name,
        item.mime_type,
        item.taken_at,
        folder,
        item.kind,
    ) {
        Ok(()) => "ok".into(),
        Err(e) => format!("retry: {e}"),
    }
}

/// A file another app shared, sent without opening the silo.
#[cfg(target_os = "android")]
pub fn send_shared(
    data_dir: &Path,
    source: &mut std::fs::File,
    item_id: Uuid,
    name: String,
    mime_type: Option<String>,
    label: String,
) -> Result<(), String> {
    if read_sender(data_dir).is_none() {
        return Err("Turn on Phone backup to save without unlocking.".into());
    }
    send_one(
        data_dir,
        source,
        item_id,
        name,
        mime_type,
        Some(now()),
        vec!["Phone backup".into(), label, "Shared".into()],
        "shared".into(),
    )
}

/// Content is read from `source`, never reopened by path: a descriptor
/// another app granted has no path this app may open.
#[cfg(target_os = "android")]
#[allow(clippy::too_many_arguments)]
fn send_one(
    data_dir: &Path,
    source: &mut std::fs::File,
    item_id: Uuid,
    name: String,
    mime_type: Option<String>,
    taken_at: Option<i64>,
    folder: Vec<String>,
    kind: String,
) -> Result<(), String> {
    let sender = read_sender(data_dir).ok_or("backup is not set up on this phone")?;
    let inbox_public = hex::decode(&sender.inbox_public)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the saved inbox key is unreadable")?;
    let target =
        send_target(sender.vault_id).ok_or("this silo's storage settings could not be read")?;
    let store = target.config.open().map_err(|e| e.to_string())?;
    let identity = inbox::SenderIdentity {
        vault_id: sender.vault_id,
        sender_id: sender.sender_id,
        key_id: sender.key_id,
        inbox_public,
    };
    let outgoing = inbox::OutgoingItem {
        item_id,
        source: Path::new(""),
        name,
        mime_type,
        taken_at,
        folder,
        source_kind: kind,
    };
    let vault = sender.vault_id.to_string();
    let sign = move |message: &[u8]| {
        let der = crate::android::sign(&vault, message)
            .ok_or_else(|| "this phone's signing key refused".to_string())?;
        silentsilo_crypto::inbox::signature_from_der(&der).map_err(|e| e.to_string())
    };
    tauri::async_runtime::block_on(async {
        inbox::send_item_from(&*store, &identity, &outgoing, source, &sign)
            .await
            .map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_resend_is_listed_until_resolved_and_a_new_send_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let item = Uuid::new_v4();
        record_sent(dir.path(), item, "photo", "42:1700000000");
        assert_eq!(resends(dir.path()), "[]");

        // What confirm_sent does with a lost item.
        let mut ledger = load_ledger(dir.path());
        let lost = ledger.sent.remove(0);
        ledger.resend.push(lost);
        save_ledger(dir.path(), &ledger);
        assert!(resends(dir.path()).contains("42:1700000000"));

        // Sent again: back in the ledger as sent, gone from the resend list.
        record_sent(dir.path(), item, "photo", "42:1700000000");
        assert_eq!(resends(dir.path()), "[]");
        assert_eq!(load_ledger(dir.path()).sent.len(), 1);

        let mut ledger = load_ledger(dir.path());
        let again = ledger.sent.remove(0);
        ledger.resend.push(again);
        save_ledger(dir.path(), &ledger);
        resolve_resend(dir.path(), "photo", "42:1700000000");
        assert_eq!(resends(dir.path()), "[]");
    }

    #[test]
    fn an_item_is_lost_only_when_two_checks_in_a_row_find_it_nowhere() {
        let dir = tempfile::tempdir().unwrap();
        let (item, other) = (Uuid::new_v4(), Uuid::new_v4());
        record_sent(dir.path(), item, "photo", "1:1");
        record_sent(dir.path(), other, "photo", "2:2");
        let mut ledger = load_ledger(dir.path());

        // Finished elsewhere during this pass: absent, record not here yet.
        assert!(settle_ledger(&mut ledger, &[], &[item]));
        assert!(ledger.resend.is_empty());
        // The next pass brought the record.
        assert!(settle_ledger(&mut ledger, &[item], &[]));
        assert!(ledger.resend.is_empty());
        assert_eq!(ledger.sent.len(), 1);

        // Twice nowhere: sent again.
        settle_ledger(&mut ledger, &[], &[other]);
        settle_ledger(&mut ledger, &[], &[other]);
        assert_eq!(ledger.resend.len(), 1);
        assert!(ledger.sent.is_empty());
    }
}
