//! Opening files beyond the image and text preview: PDF pages drawn by
//! Android's renderer inside the app, and any file handed to another app.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use silentsilo_app::AppState;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::commands::{active_silo, host};

#[derive(Clone, serde::Serialize)]
struct FileDownload {
    file_id: String,
    done: u64,
    total: u64,
}

/// Reports a file coming down from storage until dropped, by the size of
/// the `.part` it streams into. A file that is on the phone gets none.
pub struct DownloadWatch(Arc<AtomicBool>);

impl Drop for DownloadWatch {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// The screen waiting on a file that is only in storage says how far the
/// download is: on a phone it is the long part, the decrypt is quick.
pub fn watch_download(app: &AppHandle, file_id: Uuid) -> Option<DownloadWatch> {
    let state = app.state::<AppState>();
    let silo = active_silo(&state).ok()?;
    let entry = state.with_vfs(|_s, vfs| vfs.get_file(file_id)).ok()?;
    let blob = silentsilo_vault::VaultPaths::new(silo.path.clone()).blob_path(entry.blob_id);
    if blob.is_file() {
        return None;
    }
    let mut part = blob.into_os_string();
    part.push(".part");
    let part = PathBuf::from(part);
    let total = entry.size_bytes.max(0) as u64;
    let stop = Arc::new(AtomicBool::new(false));
    let watching = stop.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while !watching.load(Ordering::Relaxed) {
            let done = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let _ = app.emit(
                "file-download",
                FileDownload {
                    file_id: file_id.to_string(),
                    done: done.min(total),
                    total,
                },
            );
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    });
    Some(DownloadWatch(stop))
}

/// A decrypted copy of a PDF for the renderer, in the silo's scratch
/// directory: every lock wipes it, and reopening the same file reuses it.
async fn pdf_copy(app: &AppHandle, file_id: Uuid) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let silo = active_silo(&state)?;
    let dir = silentsilo_app::open_scratch_dir(&silo.path);
    silentsilo_vault::create_private_dir(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("pdf-{file_id}.pdf"));
    if !dest.is_file() {
        let _watch = watch_download(app, file_id);
        silentsilo_app::files::decrypt_to_file(&state, &host(app), &silo, file_id, &dest).await?;
    }
    Ok(dest)
}

/// `silo://localhost/pdf/<file id>/pages` and `.../<page>?w=<width>`.
pub async fn serve_pdf(
    app: &AppHandle,
    file_id: Uuid,
    what: &str,
    width: u32,
) -> Result<(&'static str, Vec<u8>), String> {
    let path = pdf_copy(app, file_id).await?;
    let path = path.to_string_lossy().into_owned();
    #[cfg(target_os = "android")]
    {
        if what == "pages" {
            let pages =
                tauri::async_runtime::spawn_blocking(move || crate::android::pdf_pages(&path))
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("This PDF could not be read.")?;
            return Ok((
                "application/json",
                format!("{{\"pages\":{pages}}}").into_bytes(),
            ));
        }
        let index: u32 = what.parse().map_err(|_| "No such page.".to_string())?;
        let png = tauri::async_runtime::spawn_blocking(move || {
            crate::android::pdf_page(&path, index, width)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or("This page could not be drawn.")?;
        Ok(("image/png", png))
    }
    #[cfg(target_os = "ios")]
    {
        if what == "pages" {
            let pages = tauri::async_runtime::spawn_blocking(move || crate::ios::pdf_pages(&path))
                .await
                .map_err(|e| e.to_string())?
                .ok_or("This PDF could not be read.")?;
            return Ok((
                "application/json",
                format!("{{\"pages\":{pages}}}").into_bytes(),
            ));
        }
        let index: u32 = what.parse().map_err(|_| "No such page.".to_string())?;
        let png =
            tauri::async_runtime::spawn_blocking(move || crate::ios::pdf_page(&path, index, width))
                .await
                .map_err(|e| e.to_string())?
                .ok_or("This page could not be drawn.")?;
        Ok(("image/png", png))
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (path, what, width);
        Err("This build cannot draw PDF pages.".into())
    }
}

fn opened_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    crate::background::cache_dir()
        .map(|d| d.join("open"))
        .ok_or_else(|| "The app has not finished starting.".to_string())
}

/// Files handed to other apps are removed when the user comes back to this
/// app, locks by hand, or starts it again. Not when it locks in the
/// background: that happens while the other app is still showing the file.
/// The other app may keep its own copy; the screen that offers this says so.
pub fn wipe_opened(app: &AppHandle) {
    if let Ok(dir) = opened_dir(app) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Whether a file's content is on this phone, or comes down from storage
/// before it can be shown or handed over: the details page says which.
#[tauri::command(async)]
pub fn file_on_phone(state: State<'_, AppState>, file_id: String) -> Result<bool, String> {
    let file_id = Uuid::parse_str(&file_id).map_err(|e| e.to_string())?;
    let silo = active_silo(&state)?;
    let entry = state.with_vfs(|_session, vfs| vfs.get_file(file_id))?;
    Ok(silentsilo_vault::VaultPaths::new(silo.path.clone())
        .blob_path(entry.blob_id)
        .is_file())
}

#[tauri::command]
pub async fn file_open_with(
    app: AppHandle,
    state: State<'_, AppState>,
    file_id: String,
    how: Option<String>,
) -> Result<bool, String> {
    let file_id = Uuid::parse_str(&file_id).map_err(|e| e.to_string())?;
    let silo = active_silo(&state)?;
    let entry = state.with_vfs(|_session, vfs| vfs.get_file(file_id))?;
    let dir = opened_dir(&app)?.join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // The other app shows this name, so it keeps its own, made safe.
    let name: String = entry
        .name
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let dest = dir.join(if name.trim().is_empty() {
        "file".into()
    } else {
        name
    });
    crate::audit::file_opened(&app, file_id, "another app").await?;
    {
        let _watch = watch_download(&app, file_id);
        silentsilo_app::files::decrypt_to_file(&state, &host(&app), &silo, file_id, &dest).await?;
    }
    hand_over(
        &app,
        dest,
        entry.mime_type.unwrap_or_default(),
        how.as_deref(),
    )
    .await
}

/// Opens a password entry's attached file in another app, as a file of the
/// silo opens: fetched from backup storage when this phone does not hold
/// it, decrypted with its own key, then handed over.
#[tauri::command]
pub async fn password_open_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    blob_id: String,
    name: String,
    blob_key: String,
    entry_label: Option<String>,
    how: Option<String>,
) -> Result<bool, String> {
    let blob_id = Uuid::parse_str(&blob_id).map_err(|e| e.to_string())?;
    let silo = active_silo(&state)?;
    let kek = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&silo.id)
            .ok_or("Unlock the silo first.")?
            .kek
            .clone()
    };
    let blob_path = silentsilo_vault::VaultPaths::new(silo.path.clone()).blob_path(blob_id);
    if !blob_path.is_file() {
        let configured = silentsilo_vault::load_targets(silo.id);
        let every_target: Vec<Uuid> = configured.iter().map(|t| t.config.target_id()).collect();
        let opened: Vec<(Uuid, Box<dyn silentsilo_store::ObjectStore>)> = configured
            .into_iter()
            .filter_map(|t| {
                t.config
                    .open()
                    .ok()
                    .map(|store| (t.config.target_id(), store))
            })
            .collect();
        if opened.is_empty() {
            return Err(
                "This file isn't on this phone, and no backup storage is connected.".into(),
            );
        }
        let stores: Vec<(Uuid, &dyn silentsilo_store::ObjectStore)> =
            opened.iter().map(|(id, s)| (*id, &**s)).collect();
        let every_copy = stores.len() == every_target.len();
        silentsilo_sync::fetch_blob_from_targets(&stores, &silo.path, blob_id, every_copy)
            .await
            .map_err(|e| format!("The file could not be downloaded: {e}"))?;
        let _ = silentsilo_vault::settle_blob_delivery(&silo.path, &every_target);
    }
    crate::audit::record_off_thread(
        &app,
        crate::audit::event(crate::audit::codes::FILE_OPENED)
            .on(blob_id.to_string(), &name)
            .with("in", "another app")
            .with("entry", entry_label.unwrap_or_default()),
    )
    .await?;

    let dir = opened_dir(&app)?.join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(safe_name(&name));
    let key = silentsilo_crypto::unwrap_content_key(&blob_key, &kek)
        .map_err(|_| "This file's key could not be read, so it cannot be opened.".to_string())?;
    let target = dest.clone();
    tauri::async_runtime::spawn_blocking(move || {
        silentsilo_crypto::decrypt_blob(&blob_path, &target, &key, blob_id).map_err(|e| {
            let _ = std::fs::remove_file(&target);
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let mime = silentsilo_vfs::guess_mime(&dest).unwrap_or_default();
    hand_over(&app, dest, mime, how.as_deref()).await
}

/// The name another app shows, made safe as a file name.
fn safe_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    if name.trim().is_empty() {
        "file".into()
    } else {
        name
    }
}

/// Hands a decrypted copy out of the silo. `how` is `save` (a copy kept on
/// the phone, where the user chooses), `share` (to another app as a file) or
/// `open` (the default, viewed in another app). On iOS the share sheet does
/// all three. True unless the user backed out of a save.
async fn hand_over(
    app: &AppHandle,
    dest: PathBuf,
    mime: String,
    how: Option<&str>,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let command = match how {
            Some("save") => "saveAs",
            Some("share") => "share",
            _ => "openWith",
        };
        let lock = app.state::<crate::background::BackgroundLock>();
        let _prompt = lock.prompt();
        app.state::<crate::incoming::Files<tauri::Wry>>()
            .call::<serde_json::Value>(
                command,
                serde_json::json!({
                    "path": dest.to_string_lossy(),
                    "mimeType": mime,
                }),
            )
            .await
            .map(|answer| answer.get("done").and_then(|d| d.as_bool()).unwrap_or(true))
    }
    #[cfg(target_os = "ios")]
    {
        let lock = app.state::<crate::background::BackgroundLock>();
        let _prompt = lock.prompt();
        let _ = (mime, how);
        let shown = tauri::async_runtime::spawn_blocking(move || crate::ios::open_with(&dest))
            .await
            .map_err(|e| e.to_string())?;
        if shown {
            Ok(true)
        } else {
            Err("The file could not be handed to another app.".into())
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, mime, how);
        let _ = std::fs::remove_file(dest);
        Err("This build cannot open files in other apps.".into())
    }
}
