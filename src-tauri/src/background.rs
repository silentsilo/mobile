//! Locking every open silo when the app has been in the background longer
//! than the user allows. Done here rather than in the page, because Android
//! stops a backgrounded page's timers, and a timer that never fires is a
//! silo left open.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use silentsilo_app::AppState;
use tauri::{AppHandle, Emitter, Manager};

use crate::host::MobileHost;

/// Seconds a silo stays open after the app leaves the screen.
const DEFAULT_LOCK_AFTER: u64 = 15 * 60;
const CHOICES: [u64; 7] = [0, 30, 60, 300, 900, 1800, 3600];
/// The longest a system prompt, picker or key wait may keep a silo open
/// with the app away: someone who pressed Home there has left.
const PROMPT_LIMIT: u64 = 120;

/// Time since boot, the time the phone slept included. `Instant` and tokio's
/// timers stop in deep sleep on Android, so a phone that slept all night came
/// back counting minutes, with its silo still open.
#[cfg(target_os = "android")]
pub(crate) fn since_boot() -> Duration {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `now` is a valid place for the answer.
    if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut now) } == 0 {
        Duration::new(now.tv_sec as u64, now.tv_nsec as u32)
    } else {
        Duration::ZERO
    }
}

/// iOS: `Instant` is CLOCK_UPTIME_RAW there, which stops while the iPhone
/// sleeps, so a silo left open at night came back counting only the minutes
/// the phone was awake. Darwin's CLOCK_MONOTONIC keeps counting asleep.
#[cfg(target_os = "ios")]
pub(crate) fn since_boot() -> Duration {
    const CLOCK_MONOTONIC: u32 = 6;
    unsafe extern "C" {
        fn clock_gettime_nsec_np(clock: u32) -> u64;
    }
    // SAFETY: a plain query; 0 means it failed.
    Duration::from_nanos(unsafe { clock_gettime_nsec_np(CLOCK_MONOTONIC) })
}

/// Elsewhere, only for building and testing on a computer.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn since_boot() -> Duration {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed()
}

/// How long ago `at`, a reading of [`since_boot`], was.
fn since(at: Duration) -> Duration {
    since_boot().saturating_sub(at)
}

/// The longest a lock timer sleeps before it looks at the clock again: a
/// sleep of its own stops while the phone does.
const TIMER_STEP: Duration = Duration::from_secs(30);

pub struct BackgroundLock {
    suspended_at: Mutex<Option<Duration>>,
    /// Suspended while a prompt was up, which may be the prompt itself, and
    /// how long that prompt may keep a silo open.
    prompt_suspended_at: Mutex<Option<(Duration, u64)>>,
    /// The longest any prompt up now may keep a silo open with the app away.
    prompt_limit: AtomicU64,
    /// Android cancels a fingerprint prompt started while the app is away.
    foreground: AtomicBool,
    /// On screen right now, prompts or not: a sign-in in the browser also
    /// counts as a prompt, and its next request must wait for this.
    visible: AtomicBool,
    /// Bumped on every suspend and resume, so a timer from an earlier trip to
    /// the background cannot lock a silo the user came back to.
    generation: AtomicU64,
    /// A biometric prompt covers the activity and pauses it. That is the
    /// user unlocking, not leaving.
    prompts: AtomicUsize,
    /// Long work under way (a join, an import): the screen stays on and a
    /// lock that falls due waits for it to end.
    busy: AtomicUsize,
    /// A lock fell due while busy work ran.
    lock_held: AtomicBool,
    /// When the armed lock falls due, on the clock that counts sleep. Read on
    /// every way in, because Android may freeze the timer's process past it.
    deadline: Mutex<Option<Duration>>,
}

impl Default for BackgroundLock {
    fn default() -> Self {
        Self {
            suspended_at: Mutex::new(None),
            prompt_suspended_at: Mutex::new(None),
            prompt_limit: AtomicU64::new(PROMPT_LIMIT),
            foreground: AtomicBool::new(true),
            visible: AtomicBool::new(true),
            generation: AtomicU64::new(0),
            prompts: AtomicUsize::new(0),
            busy: AtomicUsize::new(0),
            lock_held: AtomicBool::new(false),
            deadline: Mutex::new(None),
        }
    }
}

/// Held while a system prompt is on screen.
pub struct PromptGuard<'a>(&'a BackgroundLock);

impl Drop for PromptGuard<'_> {
    fn drop(&mut self) {
        if self.0.prompts.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.prompt_limit.store(PROMPT_LIMIT, Ordering::SeqCst);
        }
    }
}

impl BackgroundLock {
    pub fn prompt(&self) -> PromptGuard<'_> {
        self.prompts.fetch_add(1, Ordering::SeqCst);
        PromptGuard(self)
    }

    /// A prompt that runs longer than a system one: a sign-in in the browser,
    /// with a password and a second factor to type, gets its own time out.
    pub fn prompt_for(&self, seconds: u64) -> PromptGuard<'_> {
        self.prompt_limit.fetch_max(seconds, Ordering::SeqCst);
        self.prompt()
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

    pub fn is_visible(&self) -> bool {
        self.visible.load(Ordering::SeqCst)
    }

    /// Returns once the app is on screen again, prompt or not.
    pub async fn visible_again(&self) {
        while !self.visible.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
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
    // What was saved and not sent yet goes first: once locked, nothing can
    // send it until the next unlock on this phone, which may be days away.
    let unsent = with_unsent(&app.state::<AppState>());
    if !unsent.is_empty() {
        #[cfg(target_os = "ios")]
        let task = crate::ios::background_begin();
        tauri::async_runtime::block_on(push_unsent(app, unsent, PUSH_LIMIT));
        #[cfg(target_os = "ios")]
        crate::ios::background_end(task);
    }
    close_all(app);
}

/// The longest a lock waits for unsent changes to go out.
const PUSH_LIMIT: Duration = Duration::from_secs(20);

/// Locks without sending first: for a deadline already past.
fn close_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    let host = MobileHost(app.clone());
    if let Ok(mut deadline) = app.state::<BackgroundLock>().deadline.lock() {
        *deadline = None;
    }
    let open = state.open_silo_ids();
    if open.is_empty() {
        return;
    }
    for id in open {
        let _ = state.close_session(&host, id);
    }
    let _ = state.sweep_scratch();
    clear_clipboard(app);
    // No silo open: a sign-in nothing saved has nothing left to be for.
    tauri::async_runtime::spawn(silentsilo_vault::forget_cloud_sign_ins());
    let _ = app.emit("silos-locked", ());
}

/// A copied secret goes with the lock instead of waiting out its 45 s.
pub fn clear_clipboard(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app
            .state::<crate::device_key::DeviceKey<tauri::Wry>>()
            .clear_secret()
            .await;
    });
}

#[cfg_attr(not(mobile), allow(dead_code))]
pub fn suspended(app: &AppHandle) {
    let lock = app.state::<BackgroundLock>();
    lock.visible.store(false, Ordering::SeqCst);
    if lock.prompts.load(Ordering::SeqCst) > 0 {
        // Most likely the prompt covering the app, which is not leaving. It
        // may also be Home pressed from a picker or a key wait, so a longer
        // timer still runs; coming back cancels it.
        let limit = lock.prompt_limit.load(Ordering::SeqCst).max(PROMPT_LIMIT);
        if let Ok(mut at) = lock.prompt_suspended_at.lock() {
            at.get_or_insert_with(|| (since_boot(), limit));
        }
        arm(app, lock_after(app).max(limit));
        return;
    }
    lock.foreground.store(false, Ordering::SeqCst);
    if let Ok(mut at) = lock.suspended_at.lock() {
        *at = Some(since_boot());
    }
    let delay = lock_after(app);
    // "At once" locks right away, and the lock sends what is waiting itself.
    if delay > 0 {
        sync_on_the_way_out(app);
    }
    arm(app, delay);
}

/// The phone stops the app soon after it leaves the screen (iOS within
/// seconds, Android once it is cached), and the sync loop with it: what was
/// saved just before would wait for the next time the app is opened. So a
/// silo with changes not sent yet gets one pass now; on iOS in the time it
/// grants for it, about 30 seconds. An upload that does not fit goes on at
/// the next opening. On iOS the snapshot is written first, off the main
/// thread: AutoFill opens the silo from it, in another process.
fn sync_on_the_way_out(app: &AppHandle) {
    let waiting = with_unsent(&app.state::<AppState>());
    if waiting.is_empty() && !cfg!(target_os = "ios") {
        return;
    }
    #[cfg(target_os = "ios")]
    let task = crate::ios::background_begin();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        #[cfg(target_os = "ios")]
        {
            let flushing = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                flushing
                    .state::<AppState>()
                    .flush_all(&MobileHost(flushing.clone()));
            })
            .await;
        }
        push_unsent(&app, waiting, PUSH_LIMIT).await;
        #[cfg(target_os = "ios")]
        crate::ios::background_end(task);
    });
}

/// The open silos with changes not sent yet.
pub fn with_unsent(state: &AppState) -> Vec<uuid::Uuid> {
    state
        .open_silo_ids()
        .into_iter()
        .filter(|id| {
            state
                .sessions
                .lock()
                .ok()
                .and_then(|s| {
                    s.get(id)
                        .and_then(|s| silentsilo_vfs::pending_count(&s.conn).ok())
                })
                .unwrap_or(0)
                > 0
        })
        .collect()
}

/// One sync pass for each silo, within `limit`. A pass already running is
/// waited out, then this one sends what is left.
pub async fn push_unsent(app: &AppHandle, silos: Vec<uuid::Uuid>, limit: Duration) {
    let Some(data) = data_dir().cloned() else {
        return;
    };
    let registry = silentsilo_vault::load_registry(&data);
    let state = app.state::<AppState>();
    let _ = tokio::time::timeout(limit, async {
        for id in silos {
            let Some(silo) = registry.get(id).cloned() else {
                continue;
            };
            loop {
                match silentsilo_app::run_sync_pass(&state, &MobileHost(app.clone()), &silo).await {
                    Ok(report) if report.skipped => {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    _ => break,
                }
            }
        }
    })
    .await;
}

/// Long work starts or ends, from the page: a join, an import of many
/// files. While any runs, the screen stays on, iOS grants time if the app is
/// left, and a lock that falls due waits for the work to end.
#[tauri::command]
pub async fn app_busy(app: AppHandle, on: bool) -> Result<(), String> {
    let lock = app.state::<BackgroundLock>();
    if on {
        if lock.busy.fetch_add(1, Ordering::SeqCst) == 0 {
            keep_awake(&app, true).await;
        }
    } else if lock
        .busy
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
        == Ok(1)
    {
        keep_awake(&app, false).await;
        if lock.lock_held.swap(false, Ordering::SeqCst) {
            lock_soon(&app);
        }
    }
    Ok(())
}

async fn keep_awake(app: &AppHandle, on: bool) {
    let _ = app
        .state::<crate::device_key::DeviceKey<tauri::Wry>>()
        .keep_awake(on)
        .await;
}

/// Whether the armed lock's deadline passed while the process could not act
/// on it (Android freezes a cached app's timers). If so the lock starts now,
/// and the caller treats the silo as locked: nothing is read from a session
/// that is overdue. Asked first on every way in from outside the window.
pub fn past_deadline(app: &AppHandle) -> bool {
    let lock = app.state::<BackgroundLock>();
    let due = lock
        .deadline
        .lock()
        .ok()
        .and_then(|d| *d)
        .is_some_and(|d| since_boot() >= d);
    if due && lock.busy.load(Ordering::SeqCst) == 0 {
        lock_soon(app);
        return true;
    }
    false
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
    let armed = since_boot();
    let delay = Duration::from_secs(delay);
    if let Ok(mut deadline) = lock.deadline.lock() {
        *deadline = Some(armed + delay);
    }
    tauri::async_runtime::spawn(async move {
        // In steps, reading the clock that counts sleep each time, so a
        // phone that slept past the deadline locks soon after it wakes.
        loop {
            let left = delay.saturating_sub(since(armed));
            if left.is_zero() {
                break;
            }
            tokio::time::sleep(left.min(TIMER_STEP)).await;
            if app
                .state::<BackgroundLock>()
                .generation
                .load(Ordering::SeqCst)
                != generation
            {
                return;
            }
        }
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
    lock.visible.store(true, Ordering::SeqCst);
    if let Ok(mut deadline) = lock.deadline.lock() {
        *deadline = None;
    }
    crate::viewer::wipe_opened(app);
    let away = lock
        .suspended_at
        .lock()
        .ok()
        .and_then(|mut at| at.take())
        .map(since);
    let away_prompting = lock
        .prompt_suspended_at
        .lock()
        .ok()
        .and_then(|mut at| at.take());
    if away.is_some_and(|away| away >= Duration::from_secs(lock_after(app)))
        || away_prompting
            .is_some_and(|(at, limit)| since(at) >= Duration::from_secs(lock_after(app).max(limit)))
    {
        lock_soon(app);
    }
}

/// Window events arrive on the main thread, which closing a silo must not
/// hold: it writes the database and then needs that thread to tell the page.
fn lock_soon(app: &AppHandle) {
    let lock = app.state::<BackgroundLock>();
    if lock.busy.load(Ordering::SeqCst) > 0 {
        lock.lock_held.store(true, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || lock_all(&app));
}

#[tauri::command(async)]
pub fn lock_after_get(app: AppHandle) -> u64 {
    lock_after(&app)
}

#[tauri::command(async)]
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
    if let (Ok(data), Ok(cache)) = (crate::paths::data_dir(app), app.path().app_cache_dir()) {
        keep_the_old_default(&data);
        let _ = DIRS.set((data, cache));
    }
}

/// A phone that had silos before this release and never chose a time keeps
/// the 30 seconds it had: an update should not keep a silo open longer
/// without asking. Written on the first start of this release, so a new
/// install gets the new default and keeps it.
fn keep_the_old_default(data: &std::path::Path) {
    let path = data.join("lock-after");
    if path.exists() {
        return;
    }
    let had_silos = silentsilo_vault::registry_path(data).exists();
    let seconds = if had_silos { 30 } else { DEFAULT_LOCK_AFTER };
    // The folder may not exist yet on a first start, and a write lost then
    // would read a later start, with silos, as an update.
    let _ = std::fs::create_dir_all(data);
    let _ = std::fs::write(path, seconds.to_string());
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
    APP.get().is_some_and(|app| {
        !past_deadline(app) && !app.state::<AppState>().open_silo_ids().is_empty()
    })
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

#[tauri::command(async)]
pub fn lock_on_screen_off_get(app: AppHandle) -> bool {
    lock_on_screen_off(&app)
}

#[tauri::command(async)]
pub fn lock_on_screen_off_set(app: AppHandle, on: bool) -> Result<(), String> {
    let path = screen_off_path(&app).ok_or_else(|| "No place to save the setting.".to_string())?;
    std::fs::write(path, if on { "1" } else { "0" }).map_err(|e| e.to_string())
}
