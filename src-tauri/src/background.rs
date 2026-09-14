//! Locking every open silo when the app has been in the background longer
//! than the user allows. Done here rather than in the page, because Android
//! stops a backgrounded page's timers, and a timer that never fires is a
//! silo left open.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use silentsilo_app::AppState;
use tauri::{AppHandle, Emitter, Manager};

use crate::host::MobileHost;

/// Seconds a silo stays open after the app leaves the screen.
const DEFAULT_LOCK_AFTER: u64 = 30;
const CHOICES: [u64; 4] = [0, 30, 60, 300];

pub struct BackgroundLock {
    suspended_at: Mutex<Option<Instant>>,
    /// Android cancels a fingerprint prompt started while the app is away.
    foreground: AtomicBool,
    /// Bumped on every suspend and resume, so a timer from an earlier trip to
    /// the background cannot lock a silo the user came back to.
    generation: AtomicU64,
    /// A biometric prompt covers the activity and pauses it. That is the
    /// user unlocking, not leaving.
    prompts: AtomicUsize,
}

impl Default for BackgroundLock {
    fn default() -> Self {
        Self {
            suspended_at: Mutex::new(None),
            foreground: AtomicBool::new(true),
            generation: AtomicU64::new(0),
            prompts: AtomicUsize::new(0),
        }
    }
}

/// Held while a system prompt is on screen.
pub struct PromptGuard<'a>(&'a BackgroundLock);

impl Drop for PromptGuard<'_> {
    fn drop(&mut self) {
        self.0.prompts.fetch_sub(1, Ordering::SeqCst);
    }
}

impl BackgroundLock {
    pub fn prompt(&self) -> PromptGuard<'_> {
        self.prompts.fetch_add(1, Ordering::SeqCst);
        PromptGuard(self)
    }

    /// Returns once the app is on screen, so a prompt started now is shown
    /// rather than cancelled by the system.
    pub async fn on_screen(&self) {
        if self.foreground.load(Ordering::SeqCst) {
            return;
        }
        while !self.foreground.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        // The activity reports resumed a moment before a prompt can attach.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("lock-after"))
}

pub fn lock_after(app: &AppHandle) -> u64 {
    prefs_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse().ok())
        .filter(|s| CHOICES.contains(s))
        .unwrap_or(DEFAULT_LOCK_AFTER)
}

pub fn lock_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    let host = MobileHost(app.clone());
    let open = state.open_silo_ids();
    if open.is_empty() {
        return;
    }
    for id in open {
        let _ = state.close_session(&host, id);
    }
    let _ = app.emit("silos-locked", ());
}

#[cfg_attr(not(mobile), allow(dead_code))]
pub fn suspended(app: &AppHandle) {
    let lock = app.state::<BackgroundLock>();
    if lock.prompts.load(Ordering::SeqCst) > 0 {
        return;
    }
    lock.foreground.store(false, Ordering::SeqCst);
    let generation = lock.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut at) = lock.suspended_at.lock() {
        *at = Some(Instant::now());
    }
    let delay = lock_after(app);
    if delay == 0 {
        lock_all(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(delay)).await;
        let lock = app.state::<BackgroundLock>();
        if lock.generation.load(Ordering::SeqCst) == generation {
            lock_all(&app);
        }
    });
}

/// The timer may not have run while Android had the process frozen, so the
/// elapsed time is checked again before anything is shown.
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn resumed(app: &AppHandle) {
    let lock = app.state::<BackgroundLock>();
    lock.generation.fetch_add(1, Ordering::SeqCst);
    lock.foreground.store(true, Ordering::SeqCst);
    crate::viewer::wipe_opened(app);
    let away = lock
        .suspended_at
        .lock()
        .ok()
        .and_then(|mut at| at.take())
        .map(|at| at.elapsed());
    if let Some(away) = away
        && away >= Duration::from_secs(lock_after(app))
    {
        lock_all(app);
    }
}

#[tauri::command]
pub fn lock_after_get(app: AppHandle) -> u64 {
    lock_after(&app)
}

#[tauri::command]
pub fn lock_after_set(app: AppHandle, seconds: u64) -> Result<(), String> {
    if !CHOICES.contains(&seconds) {
        return Err("That is not one of the choices.".into());
    }
    let path = prefs_path(&app).ok_or_else(|| "No place to save the setting.".to_string())?;
    std::fs::write(path, seconds.to_string()).map_err(|e| e.to_string())
}

/// The running app, for Kotlin code outside its window: the Quick Settings
/// tile and the screen-off receiver.
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn remember(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// Locks everything now, from outside the window. Nothing is open when the
/// app is not running, so there is nothing to do then.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn lock_from_outside() {
    if let Some(app) = APP.get() {
        lock_all(app);
        crate::viewer::wipe_opened(app);
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn any_open() -> bool {
    APP.get()
        .is_some_and(|app| !app.state::<AppState>().open_silo_ids().is_empty())
}

fn screen_off_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("lock-on-screen-off"))
}

/// On unless turned off: a phone left on a table with the silo open is the
/// case this exists for.
pub fn lock_on_screen_off(app: &AppHandle) -> bool {
    screen_off_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_none_or(|s| s.trim() != "0")
}

/// The screen went off: lock at once when the user wants that, whatever the
/// background delay.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn screen_off() {
    if let Some(app) = APP.get()
        && lock_on_screen_off(app)
    {
        lock_all(app);
    }
}

#[tauri::command]
pub fn lock_on_screen_off_get(app: AppHandle) -> bool {
    lock_on_screen_off(&app)
}

#[tauri::command]
pub fn lock_on_screen_off_set(app: AppHandle, on: bool) -> Result<(), String> {
    let path = screen_off_path(&app).ok_or_else(|| "No place to save the setting.".to_string())?;
    std::fs::write(path, if on { "1" } else { "0" }).map_err(|e| e.to_string())
}
