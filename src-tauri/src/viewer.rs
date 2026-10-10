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

#[tauri::command]
pub async fn file_open_with(
    app: AppHandle,
    state: State<'_, AppState>,
    file_id: String,
) -> Result<(), String> {
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

    #[cfg(target_os = "android")]
    {
        let lock = app.state::<crate::background::BackgroundLock>();
        let _prompt = lock.prompt();
        app.state::<crate::incoming::Files<tauri::Wry>>()
            .call::<serde_json::Value>(
                "openWith",
                serde_json::json!({
                    "path": dest.to_string_lossy(),
                    "mimeType": entry.mime_type.unwrap_or_default(),
                }),
            )
            .await
            .map(|_| ())
    }
    #[cfg(target_os = "ios")]
    {
        let lock = app.state::<crate::background::BackgroundLock>();
        let _prompt = lock.prompt();
        let _ = entry;
        let shown = tauri::async_runtime::spawn_blocking(move || crate::ios::open_with(&dest))
            .await
            .map_err(|e| e.to_string())?;
        if shown {
            Ok(())
        } else {
            Err("The file could not be handed to another app.".into())
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = std::fs::remove_file(dest);
        Err("This build cannot open files in other apps.".into())
    }
}
