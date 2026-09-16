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
/// The longest a system prompt, picker or key wait may keep a silo open
/// with the app away: someone who pressed Home there has left.
const PROMPT_LIMIT: u64 = 120;

pub struct BackgroundLock {
    suspended_at: Mutex<Option<Instant>>,
    /// Suspended while a prompt was up, which may be the prompt itself.
    prompt_suspended_at: Mutex<Option<Instant>>,
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
            prompt_suspended_at: Mutex::new(None),
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

/// The app's data and cache directories, read once at startup. On Android
/// asking Tauri for them calls into Kotlin and waits on the main thread, so
/// asking from the main thread (a window event, the screen-off receiver)
/// never returns.
static DIRS: std::sync::OnceLock<(PathBuf, PathBuf)> = std::sync::OnceLock::new();

pub fn data_dir() -> Option<&'static PathBuf> {
    DIRS.get().map(|(data, _)| data)
}

pub fn cache_dir() -> Option<&'static PathBuf> {
    DIRS.get().map(|(_, cache)| cache)
}

fn prefs_path(_app: &AppHandle) -> Option<PathBuf> {
    data_dir().map(|d| d.join("lock-after"))
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
    let _ = state.sweep_scratch();
    let _ = app.emit("silos-locked", ());
}

#[cfg_attr(not(mobile), allow(dead_code))]
pub fn suspended(app: &AppHandle) {
    let lock = app.state::<BackgroundLock>();
    if lock.prompts.load(Ordering::SeqCst) > 0 {
        // Most likely the prompt covering the app, which is not leaving. It
        // may also be Home pressed from a picker or a key wait, so a longer
        // timer still runs; coming back cancels it.
        if let Ok(mut at) = lock.prompt_suspended_at.lock() {
            at.get_or_insert_with(Instant::now);
        }
        arm(app, lock_after(app).max(PROMPT_LIMIT));
        return;
    }
    lock.foreground.store(false, Ordering::SeqCst);
    if let Ok(mut at) = lock.suspended_at.lock() {
        *at = Some(Instant::now());
    }
    arm(app, lock_after(app));
}

/// Locks after `delay` unless the app comes back or goes away again first.
fn arm(app: &AppHandle, delay: u64) {
    let lock = app.state::<BackgroundLock>();
    let generation = lock.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if delay == 0 {
        lock_soon(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(delay)).await;
        let lock = app.state::<BackgroundLock>();
        if lock.generation.load(Ordering::SeqCst) == generation {
            lock_soon(&app);
        }
    });
}

/// Autofill or a passkey opened a silo into the app while it is away. The
/// suspend timer already ran or was never started for this, so one starts
/// now. A short grace when the choice is "at once", so the fill that opened
/// it can finish.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn opened_while_away(app: &AppHandle) {
    let lock = app.state::<BackgroundLock>();
    if lock.foreground.load(Ordering::SeqCst) {
        return;
    }
    arm(app, lock_after(app).max(5));
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
    let away_prompting = lock
        .prompt_suspended_at
        .lock()
        .ok()
        .and_then(|mut at| at.take())
        .map(|at| at.elapsed());
    if away.is_some_and(|away| away >= Duration::from_secs(lock_after(app)))
        || away_prompting
            .is_some_and(|away| away >= Duration::from_secs(lock_after(app).max(PROMPT_LIMIT)))
    {
        lock_soon(app);
    }
}

/// Window events arrive on the main thread, which closing a silo must not
/// hold: it writes the database and then needs that thread to tell the page.
fn lock_soon(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || lock_all(&app));
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

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

pub fn remember(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if let (Ok(data), Ok(cache)) = (app.path().app_data_dir(), app.path().app_cache_dir()) {
        let _ = DIRS.set((data, cache));
    }
}

/// Locks everything now, from outside the window. Nothing is open when the
/// app is not running, so there is nothing to do then.
///
/// Off the calling thread: Kotlin calls this on the main thread, and closing
/// a silo both writes its database and tells the page, which needs that same
/// thread. Doing it inline froze the app until Android killed it.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn lock_from_outside() {
    if let Some(app) = APP.get().cloned() {
        tauri::async_runtime::spawn_blocking(move || {
            lock_all(&app);
            crate::viewer::wipe_opened(&app);
        });
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn any_open() -> bool {
    APP.get()
        .is_some_and(|app| !app.state::<AppState>().open_silo_ids().is_empty())
}

fn screen_off_path(_app: &AppHandle) -> Option<PathBuf> {
    data_dir().map(|d| d.join("lock-on-screen-off"))
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
        lock_soon(app);
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
