//! Files coming into the silo from the phone: the document picker, the
//! camera, and other apps' share sheet. The Kotlin side is `FilesPlugin.kt`;
//! it hands over a descriptor, so the plaintext is read in place and sealed
//! straight into the blob store.

use serde::{Deserialize, Serialize};
use silentsilo_app::AppState;
use silentsilo_core::FileEntry;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use uuid::Uuid;

use crate::background::BackgroundLock;

/// A file another app offered, before it is read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offered {
    pub uri: String,
    pub name: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub mime_type: String,
}

#[derive(Deserialize)]
struct OfferedList {
    #[serde(default)]
    files: Vec<Offered>,
}

#[cfg(target_os = "android")]
pub struct Files<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(not(target_os = "android"))]
pub struct Files<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> Files<R> {
    pub(crate) async fn call<T: serde::de::DeserializeOwned>(
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
        #[cfg(target_os = "ios")]
        {
            let _ = payload;
            let command = command.to_string();
            let answer = tauri::async_runtime::spawn_blocking(move || match command.as_str() {
                "pickFiles" => Ok(crate::ios::pick_files()),
                "takeShared" => Ok(crate::ios::take_shared()),
                "takePhoto" => {
                    let folder = crate::background::cache_dir()
                        .map(|d| d.join("camera"))
                        .ok_or("The app has not finished starting.")?;
                    Ok(serde_json::json!({ "path": crate::ios::take_photo(&folder) }))
                }
                other => Err(format!("no iOS answer for {other}")),
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::from_value(answer).map_err(|e| e.to_string())
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let _ = (command, payload);
            Err("This build cannot reach the phone's files.".into())
        }
    }
}

impl<R: Runtime> Files<R> {
    /// Opens a sign-in page in the phone's browser. Blocking, and short:
    /// the answer is whether the browser started.
    pub(crate) fn open_browser(&self, url: &str) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            self.0
                .run_mobile_plugin::<serde_json::Value>(
                    "openBrowser",
                    serde_json::json!({ "url": url }),
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(target_os = "ios")]
        {
            if crate::ios::sign_in_open(url) {
                Ok(())
            } else {
                Err("The sign-in page could not be opened.".into())
            }
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let _ = url;
            Err("This build cannot open the phone's browser.".into())
        }
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("files")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.silentsilo.mobile", "FilesPlugin")?;
                app.manage(Files(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(Files::<R>(std::marker::PhantomData));
            }
            Ok(())
        })
        .build()
}

/// Opens one of the project's own pages: the source code, the licence, the
/// site. Nothing else, so the page cannot be made to open any address.
#[tauri::command]
pub async fn app_open_link(app: AppHandle, url: String) -> Result<(), String> {
    const OURS: [&str; 2] = ["https://github.com/silentsilo/", "https://silentsilo.com/"];
    if !OURS.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("Only SilentSilo's own pages open from here.".into());
    }
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        if crate::ios::open_url(&url) {
            Ok(())
        } else {
            Err("The page could not be opened.".into())
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let url2 = url.clone();
        tauri::async_runtime::spawn_blocking(move || plugin(&app).open_browser(&url2))
            .await
            .map_err(|e| e.to_string())?
    }
}

fn plugin(app: &AppHandle) -> State<'_, Files<tauri::Wry>> {
    app.state::<Files<tauri::Wry>>()
}

/// The picker and the camera cover the app, which pauses it: that is not
/// the user leaving.
#[tauri::command]
pub async fn files_pick(app: AppHandle) -> Result<Vec<Offered>, String> {
    let lock = app.state::<BackgroundLock>();
    let _prompt = lock.prompt();
    let list: OfferedList = plugin(&app)
        .call("pickFiles", serde_json::json!({}))
        .await?;
    Ok(list.files)
}

#[tauri::command]
pub async fn files_take_shared(app: AppHandle) -> Result<Vec<Offered>, String> {
    let list: OfferedList = plugin(&app)
        .call("takeShared", serde_json::json!({}))
        .await?;
    Ok(list.files)
}

/// The path of the photo the camera wrote into the app's cache, or `None`
/// when no photo was taken.
#[tauri::command]
pub async fn files_take_photo(app: AppHandle) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct Taken {
        path: Option<String>,
    }
    let lock = app.state::<BackgroundLock>();
    let _prompt = lock.prompt();
    let taken: Taken = plugin(&app)
        .call("takePhoto", serde_json::json!({}))
        .await?;
    Ok(taken.path)
}

/// The file behind `uri`, read through the descriptor another app granted.
/// Its path is no use: opening it again checks this app's own access to the
/// gallery, which a share does not give.
#[cfg(target_os = "android")]
async fn open_offered(app: &AppHandle, uri: &str) -> Result<std::fs::File, String> {
    use std::os::fd::FromRawFd;
    #[derive(Deserialize)]
    struct Fd {
        fd: i32,
    }
    let opened: Fd = plugin(app)
        .call("openFd", serde_json::json!({ "uri": uri }))
        .await?;
    // SAFETY: `detachFd` handed this descriptor over; nothing else closes it.
    Ok(unsafe { std::fs::File::from_raw_fd(opened.fd) })
}

#[tauri::command]
pub async fn vault_import_offered(
    app: AppHandle,
    state: State<'_, AppState>,
    file: Offered,
    folder_id: String,
) -> Result<FileEntry, String> {
    let silo = crate::commands::active_silo(&state)?;
    let folder_id = Uuid::parse_str(&folder_id).map_err(|e| e.to_string())?;
    #[cfg(target_os = "android")]
    {
        let mut source = open_offered(&app, &file.uri).await?;
        let app2 = app.clone();
        let entry = tauri::async_runtime::spawn_blocking(move || {
            let state = app2.state::<AppState>();
            let mime = Some(file.mime_type.as_str()).filter(|m| !m.is_empty());
            silentsilo_app::files::import_file(
                &state,
                &silo,
                folder_id,
                &mut source,
                &file.name,
                mime,
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        crate::audit::file_added(&app, &entry);
        let _ = app.emit("vault-changed", ());
        Ok(entry)
    }
    // iOS: the picker's copy in this app's temporary folder, removed once
    // it is sealed into the silo. Only there: this command reads the path
    // it is given.
    #[cfg(target_os = "ios")]
    {
        let path = std::path::PathBuf::from(&file.uri);
        let inside = path
            .canonicalize()
            .ok()
            .zip(std::env::temp_dir().canonicalize().ok())
            .is_some_and(|(p, tmp)| p.starts_with(tmp));
        if !inside {
            return Err("That is not a file picked for the silo.".into());
        }
        let app2 = app.clone();
        let picked = path.clone();
        let entry = tauri::async_runtime::spawn_blocking(move || {
            let state = app2.state::<AppState>();
            let mut source = std::fs::File::open(&picked).map_err(|e| e.to_string())?;
            let mime = Some(file.mime_type.as_str()).filter(|m| !m.is_empty());
            silentsilo_app::files::import_file(
                &state,
                &silo,
                folder_id,
                &mut source,
                &file.name,
                mime,
            )
        })
        .await
        .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&path);
        let entry = entry?;
        crate::audit::file_added(&app, &entry);
        let _ = app.emit("vault-changed", ());
        Ok(entry)
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, silo, folder_id, file);
        Err("This build cannot reach the phone's files.".into())
    }
}

/// Adds the photo the camera just wrote, then removes it from the cache.
#[tauri::command]
pub async fn vault_import_photo(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: String,
    folder_id: String,
) -> Result<FileEntry, String> {
    let silo = crate::commands::active_silo(&state)?;
    let folder_id = Uuid::parse_str(&folder_id).map_err(|e| e.to_string())?;
    let path = std::path::PathBuf::from(path);
    // Only what the camera wrote for us: this command reads any path given.
    let camera = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("camera");
    let inside = path
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .zip(camera.canonicalize().ok())
        .is_some_and(|(dir, camera)| dir == camera);
    if !inside {
        return Err("That is not a photo taken for the silo.".into());
    }
    let app2 = app.clone();
    let taken = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<AppState>();
        let mut source = std::fs::File::open(&taken).map_err(|e| e.to_string())?;
        silentsilo_app::files::import_file(
            &state,
            &silo,
            folder_id,
            &mut source,
            &name,
            Some("image/jpeg"),
        )
    })
    .await
    .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&path);
    let entry = result??;
    crate::audit::file_added(&app, &entry);
    let _ = app.emit("vault-changed", ());
    Ok(entry)
}

#[tauri::command(async)]
pub fn vault_create_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    parent_id: String,
    name: String,
) -> Result<silentsilo_core::FolderEntry, String> {
    let parent_id = Uuid::parse_str(&parent_id).map_err(|e| e.to_string())?;
    let folder = state.with_vfs(|_session, vfs| vfs.create_folder(parent_id, name.trim()))?;
    let _ = crate::audit::record(
        &app,
        crate::audit::event(crate::audit::codes::FOLDER_CREATED)
            .on(folder.id.to_string(), folder.path.clone()),
    );
    Ok(folder)
}

/// Sends a shared file to the inbox without opening the silo, when this
/// phone is set up to send.
#[tauri::command]
pub async fn share_to_inbox(app: AppHandle, file: Offered) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        #[cfg(target_os = "android")]
        let mut source = open_offered(&app, &file.uri).await?;
        // The share extension's file, moved into this app's temporary folder.
        #[cfg(target_os = "ios")]
        let shared = std::path::PathBuf::from(&file.uri);
        #[cfg(target_os = "ios")]
        let mut source = {
            if !shared.starts_with(std::env::temp_dir()) {
                return Err("That file is not one this app was given.".into());
            }
            std::fs::File::open(&shared).map_err(|e| e.to_string())?
        };
        let data_dir = crate::paths::data_dir(&app)?;
        let label = crate::backup::sender_vault(&data_dir)
            .and_then(|vault| {
                silentsilo_vault::load_registry(&data_dir)
                    .get(vault)
                    .cloned()
            })
            .map(|silo| crate::backup::phone_label(&app, &silo))
            .unwrap_or_else(|| "This phone".into());
        let sent = tauri::async_runtime::spawn_blocking(move || {
            let mime = Some(file.mime_type).filter(|m| !m.is_empty());
            crate::backup::send_shared(
                &data_dir,
                &mut source,
                Uuid::new_v4(),
                file.name,
                mime,
                label,
            )
        })
        .await
        .map_err(|e| e.to_string())?;
        #[cfg(target_os = "ios")]
        if sent.is_ok()
            && let Some(folder) = shared.parent()
        {
            let _ = std::fs::remove_dir_all(folder);
        }
        sent
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, file);
        Err("This build cannot reach the phone's files.".into())
    }
}
