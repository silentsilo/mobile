//! The silo's activity log, as this app's commands write it. The same rules
//! as on desktop: what leaves the silo is recorded before it happens, a
//! change before it is stored, an import once with its count after. On an
//! organisation's silo an event that cannot be written locks the silo and
//! refuses the action; on a personal one it is a diagnostic.
//!
//! Never call these while holding the sessions lock: recording takes it.
//!
//! Not recorded yet: autofill and passkeys. The autofill service is handed
//! the logins and the person picks one in Android's own list, so this side
//! never learns which was filled.

use std::collections::HashMap;
use std::sync::Mutex;

use silentsilo_app::{AppState, Host};
use silentsilo_audit::Event;
pub use silentsilo_audit::codes;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::commands::{active_silo, host};

const UNRECORDED: &str = "This silo's activity log could not be written on this phone, so the silo was locked. Your organisation requires the log. Check that the phone has space, then unlock again.";

/// An event of `code`, happening now.
pub fn event(code: u16) -> Event {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Event::new(code, now_ms)
}

/// Records `event` in the open silo's log.
pub fn record(app: &AppHandle, event: Event) -> Result<(), String> {
    let id = active_silo(&app.state::<AppState>())?.id;
    record_in(app, id, event)
}

/// The key each open silo was unlocked with, as the log names it. Every
/// event the silo records while open carries it as `via`, as on desktop.
static UNLOCKED_WITH: Mutex<Option<HashMap<Uuid, String>>> = Mutex::new(None);

/// What the log calls this phone's own key.
pub const VIA_PHONE_KEY: &str = "phone key";
/// What the log calls an unlock with the recovery code.
pub const VIA_RECOVERY_CODE: &str = "recovery code";

/// Set where a session opens: `None` for one opened without a key the log
/// can name (a new silo, a join), so an earlier session's key never sticks.
pub fn set_unlocked_with(id: Uuid, via: Option<String>) {
    let Ok(mut map) = UNLOCKED_WITH.lock() else {
        return;
    };
    let map = map.get_or_insert_with(HashMap::new);
    match via.filter(|v| !v.is_empty()) {
        Some(via) => map.insert(id, via),
        None => map.remove(&id),
    };
}

fn unlocked_with(id: Uuid) -> Option<String> {
    UNLOCKED_WITH.lock().ok()?.as_ref()?.get(&id).cloned()
}

/// A security key as the log names it: its label, or its slot.
pub fn key_name(root: &std::path::Path, credential_id: &str) -> String {
    silentsilo_vault::load_fido_keys(root)
        .ok()
        .and_then(|keys| {
            keys.keys
                .into_iter()
                .find(|k| k.credential_id == credential_id)
        })
        .map(|k| {
            if k.label.is_empty() {
                format!("Security key {}", k.key_slot)
            } else {
                k.label
            }
        })
        .unwrap_or_else(|| "security key".into())
}

/// Records `event` in silo `id`'s log. An `Err` means the silo was locked
/// and the action must not happen.
pub fn record_in(app: &AppHandle, id: Uuid, mut event: Event) -> Result<(), String> {
    // The unlock itself already says how.
    if event.c != codes::UNLOCKED
        && !event.x.contains_key("via")
        && let Some(via) = unlocked_with(id)
    {
        event = event.with("via", via);
    }
    let state = app.state::<AppState>();
    let Err(e) = state.audit_record(id, event) else {
        return Ok(());
    };
    if !state.audit_is_mandatory(id) {
        host(app).warn("audit", &e);
        return Ok(());
    }
    host(app).warn("audit", &format!("locking the silo: {e}"));
    let _ = state.close_session(&host(app), id);
    crate::viewer::wipe_opened(app);
    crate::background::clear_clipboard(app);
    let _ = app.emit("silo-audit-locked", id.to_string());
    Err(UNRECORDED.into())
}

/// The log is on by default: a silo with no copies has nobody to ask
/// whether it was ever set, so it starts here, when opened, as on desktop.
/// One with copies gets it at its first sync pass. Best effort, and before
/// the unlock is recorded, so the unlock is in it.
pub fn start_by_default(app: &AppHandle, id: Uuid) {
    let state = app.state::<AppState>();
    if let Err(e) = state.start_audit_by_default(&host(app), id) {
        host(app).warn("audit", &e);
    }
}

/// [`start_by_default`] on the blocking pool: it writes the queue on disk.
pub async fn start_by_default_off_thread(app: &AppHandle, id: Uuid) {
    let app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || start_by_default(&app, id)).await;
}

/// [`record`] on the blocking pool, for an async command.
pub async fn record_off_thread(app: &AppHandle, event: Event) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || record(&app, event))
        .await
        .map_err(|e| e.to_string())?
}

/// A file about to be shown or handed on, by name, `how` saying where.
pub async fn file_opened(app: &AppHandle, file_id: Uuid, how: &str) -> Result<(), String> {
    let name = app
        .state::<AppState>()
        .with_vfs(|_session, vfs| vfs.get_file(file_id))
        .map(|f| f.name)
        .unwrap_or_default();
    record_off_thread(
        app,
        event(codes::FILE_OPENED)
            .on(file_id.to_string(), name)
            .with("in", how),
    )
    .await
}

/// A file added, by name and with its folder, after the import: it is in
/// the silo already, so this is never refused.
pub fn file_added(app: &AppHandle, file: &silentsilo_core::FileEntry) {
    let mut added = event(codes::FILE_ADDED).on(file.id.to_string(), file.name.clone());
    if let Ok(folder) = app
        .state::<AppState>()
        .with_vfs(|_session, vfs| vfs.get_folder(file.folder_id).map(|f| f.path))
    {
        added = added.with("folder", folder);
    }
    let _ = record(app, added);
}

/// The events the app may report itself: what happens on screen, which no
/// command sees.
#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Note {
    EntryRevealed,
}

/// Records that an entry's secrets are about to be shown.
#[tauri::command]
pub async fn audit_note(
    app: AppHandle,
    note: Note,
    entry_id: String,
    label: Option<String>,
) -> Result<(), String> {
    let event = event(match note {
        Note::EntryRevealed => codes::ENTRY_REVEALED,
    })
    .on(entry_id, label.unwrap_or_default());
    record_off_thread(&app, event).await
}

/// What a copied secret was, for the log. Sent with the copy, so the event
/// is written before the clipboard holds it.
#[derive(serde::Deserialize)]
pub struct CopiedSecret {
    pub entry_id: String,
    pub label: String,
    /// The field: "password", "card number", "one-time code".
    pub field: String,
}

impl CopiedSecret {
    pub fn event(self) -> Event {
        let code = if self.field == "one-time code" {
            codes::CODE_COPIED
        } else {
            codes::SECRET_COPIED
        };
        event(code)
            .on(self.entry_id, self.label)
            .with("field", self.field)
    }
}

/// What a save was. The app knows: whether the entry existed, and whether
/// this save restores or clears its history.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum EntryChange {
    Created,
    Edited,
    Restored,
    HistoryCleared,
}

impl EntryChange {
    pub fn code(self) -> u16 {
        match self {
            EntryChange::Created => codes::ENTRY_CREATED,
            EntryChange::Edited => codes::ENTRY_EDITED,
            EntryChange::Restored => codes::ENTRY_RESTORED,
            EntryChange::HistoryCleared => codes::HISTORY_CLEARED,
        }
    }
}

/// The open silo's log, as this phone knows it.
#[tauri::command]
pub async fn audit_status(app: AppHandle) -> Result<silentsilo_app::AuditStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let id = active_silo(&state)?.id;
        state.audit_status(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Turns the open silo's own log on or off, here at once and on the copies
/// at the next sync. An organisation's log is not turned on or off here.
#[tauri::command]
pub async fn audit_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<silentsilo_app::AuditStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let id = active_silo(&state)?.id;
        state.set_audit_log(id, enabled)?;
        state.audit_status(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_is_logged_as_what_it_was() {
        let copied = |field: &str| CopiedSecret {
            entry_id: "e1".into(),
            label: "Bank".into(),
            field: field.into(),
        };
        assert_eq!(copied("one-time code").event().c, codes::CODE_COPIED);
        let password = copied("password").event();
        assert_eq!(password.c, codes::SECRET_COPIED);
        assert_eq!(password.l.as_deref(), Some("Bank"));
    }

    #[test]
    fn the_app_may_note_only_what_it_alone_sees() {
        assert!(serde_json::from_str::<Note>(r#""entry_revealed""#).is_ok());
        assert!(serde_json::from_str::<Note>(r#""secret_copied""#).is_err());
    }
}
