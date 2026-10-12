//! Asking for this phone's fingerprint or face again, where the silo being
//! open is not enough: the secrets of an entry marked to ask first, and
//! anything that lets someone in later (a new recovery code, a key added or
//! removed, another place for the silo's backup). The silo being open proves
//! who opened it, not who holds the phone now.
//!
//! Every answer is kept here, not in the page, and every lock forgets them.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use silentsilo_app::AppState;
use silentsilo_app::flows;
use silentsilo_vault::SiloEntry;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::background::since_boot;

/// How long one confirmation shows a protected entry, as on desktop.
pub const ENTRY_GRACE: Duration = Duration::from_secs(3 * 60);

/// How long an unlock or a confirmation counts as the owner being here for
/// a change that lets someone in later. Long enough for the steps of making
/// a silo, short enough that a phone handed over later asks again.
const FRESH: Duration = Duration::from_secs(2 * 60);

#[derive(Default)]
struct Answers {
    /// Each silo and when its owner last proved being here.
    silos: HashMap<Uuid, Duration>,
    /// Protected entries confirmed, by silo and entry, with when.
    entries: HashMap<(Uuid, Uuid), Duration>,
}

#[derive(Default)]
pub struct Presence(Mutex<Answers>);

impl Presence {
    /// The owner proved being here just now: a prompt passed.
    pub fn note(&self, silo: Uuid) {
        if let Ok(mut answers) = self.0.lock() {
            answers.silos.insert(silo, since_boot());
        }
    }

    /// The silo was just unlocked. Entries confirmed while it was open
    /// before count no more, whatever closed it.
    pub fn opened(&self, silo: Uuid) {
        if let Ok(mut answers) = self.0.lock() {
            answers.entries.retain(|(s, _), _| *s != silo);
            answers.silos.insert(silo, since_boot());
        }
    }

    fn note_entry(&self, silo: Uuid, entry: Uuid) {
        if let Ok(mut answers) = self.0.lock() {
            let now = since_boot();
            answers.silos.insert(silo, now);
            answers.entries.insert((silo, entry), now);
        }
    }

    /// For a lock: nothing confirmed before it counts after it.
    pub fn forget(&self, silo: Uuid) {
        if let Ok(mut answers) = self.0.lock() {
            answers.silos.remove(&silo);
            answers.entries.retain(|(s, _), _| *s != silo);
        }
    }

    pub fn forget_all(&self) {
        if let Ok(mut answers) = self.0.lock() {
            *answers = Answers::default();
        }
    }

    fn fresh(&self, silo: Uuid) -> bool {
        self.0.lock().ok().is_some_and(|answers| {
            answers
                .silos
                .get(&silo)
                .is_some_and(|at| since_boot().saturating_sub(*at) < FRESH)
        })
    }

    fn entry_shown(&self, silo: Uuid, entry: Uuid) -> bool {
        self.0.lock().ok().is_some_and(|answers| {
            answers
                .entries
                .get(&(silo, entry))
                .is_some_and(|at| since_boot().saturating_sub(*at) < ENTRY_GRACE)
        })
    }
}

fn silo_is_open(state: &AppState, silo: Uuid) -> Result<(), String> {
    if state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&silo)
    {
        Ok(())
    } else {
        Err("Unlock the silo first.".into())
    }
}

/// The fingerprint or face prompt. Counts only if the key it releases opens
/// this silo's key, as on desktop, so any unlocked phone prompt is not
/// enough.
async fn ask(app: &AppHandle, silo: &SiloEntry) -> Result<(), String> {
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

/// Asks now, whatever was confirmed before.
pub async fn confirm(app: &AppHandle, state: &AppState, silo: &SiloEntry) -> Result<(), String> {
    silo_is_open(state, silo.id)?;
    ask(app, silo).await?;
    app.state::<Presence>().note(silo.id);
    Ok(())
}

/// Before a change that lets someone in later. A silo opened or confirmed in
/// the last two minutes goes ahead; otherwise this phone's key is asked for.
/// A silo still being made, with no key and no backup storage yet, has
/// nothing to ask with and nothing to give away.
pub async fn require(app: &AppHandle, state: &AppState, silo: &SiloEntry) -> Result<(), String> {
    silo_is_open(state, silo.id)?;
    let presence = app.state::<Presence>();
    if presence.fresh(silo.id) || crate::create::keyless(silo) {
        return Ok(());
    }
    if flows::device_key_ids(&silo.path, crate::device_key::KIND).is_empty() {
        return Err(silentsilo_core::coded!(
            "err.confirm_by_unlocking",
            "Confirm it is you first: lock the silo, unlock it again, then try again."
        )
        .into());
    }
    ask(app, silo).await?;
    presence.note(silo.id);
    Ok(())
}

/// Before a protected entry's secrets leave Rust. One confirmation covers
/// the entry for a few minutes, and a prompt just passed covers a change
/// made to several entries at once.
pub async fn require_entry(
    app: &AppHandle,
    state: &AppState,
    silo: &SiloEntry,
    entry: Uuid,
) -> Result<(), String> {
    silo_is_open(state, silo.id)?;
    let presence = app.state::<Presence>();
    if presence.entry_shown(silo.id, entry) {
        return Ok(());
    }
    ask(app, silo).await?;
    presence.note_entry(silo.id, entry);
    Ok(())
}

/// Before a protected entry is deleted: confirmed in the last few minutes,
/// or the silo opened or confirmed just before, as for a delete of several
/// entries at once after one prompt.
pub async fn require_change(
    app: &AppHandle,
    state: &AppState,
    silo: &SiloEntry,
    entry: Uuid,
) -> Result<(), String> {
    silo_is_open(state, silo.id)?;
    let presence = app.state::<Presence>();
    if presence.entry_shown(silo.id, entry) || presence.fresh(silo.id) {
        return Ok(());
    }
    ask(app, silo).await?;
    presence.note_entry(silo.id, entry);
    Ok(())
}

/// The fingerprint again, for a change to several protected entries at once,
/// as `vault_reverify`.
#[tauri::command]
pub async fn vault_reverify(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let silo = crate::commands::active_silo(&state)?;
    confirm(&app, &state, &silo).await
}
