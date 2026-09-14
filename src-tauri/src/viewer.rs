//! Opening files beyond the image and text preview: PDF pages drawn by
//! Android's renderer inside the app, and any file handed to another app.

use std::path::PathBuf;

use silentsilo_app::AppState;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::commands::{active_silo, host};

/// A decrypted copy of a PDF for the renderer, in the silo's scratch
/// directory: every lock wipes it, and reopening the same file reuses it.
async fn pdf_copy(app: &AppHandle, file_id: Uuid) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let silo = active_silo(&state)?;
    let dir = silentsilo_app::open_scratch_dir(&silo.path);
    silentsilo_vault::create_private_dir(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("pdf-{file_id}.pdf"));
    if !dest.is_file() {
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
    #[cfg(not(target_os = "android"))]
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
    silentsilo_app::files::decrypt_to_file(&state, &host(&app), &silo, file_id, &dest).await?;

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
    #[cfg(not(target_os = "android"))]
    {
        let _ = std::fs::remove_file(dest);
        Err("This build cannot open files in other apps.".into())
    }
}
