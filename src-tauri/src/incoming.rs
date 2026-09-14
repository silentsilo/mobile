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
        #[cfg(not(target_os = "android"))]
        {
            let _ = (command, payload);
            Err("This build cannot reach the phone's files.".into())
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
        let _ = app.emit("vault-changed", ());
        Ok(entry)
    }
    #[cfg(not(target_os = "android"))]
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
    let _ = app.emit("vault-changed", ());
    Ok(entry)
}

#[tauri::command]
pub fn vault_create_folder(
    state: State<'_, AppState>,
    parent_id: String,
    name: String,
) -> Result<silentsilo_core::FolderEntry, String> {
    let parent_id = Uuid::parse_str(&parent_id).map_err(|e| e.to_string())?;
    state.with_vfs(|_session, vfs| vfs.create_folder(parent_id, name.trim()))
}

/// Sends a shared file to the inbox without opening the silo, when this
/// phone is set up to send.
#[tauri::command]
pub async fn share_to_inbox(app: AppHandle, file: Offered) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let mut source = open_offered(&app, &file.uri).await?;
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let label = crate::backup::sender_vault(&data_dir)
            .and_then(|vault| {
                silentsilo_vault::load_registry(&data_dir)
                    .get(vault)
                    .cloned()
            })
            .map(|silo| crate::backup::phone_label(&app, &silo))
            .unwrap_or_else(|| "This phone".into());
        tauri::async_runtime::spawn_blocking(move || {
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
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, file);
        Err("This build cannot reach the phone's files.".into())
    }
}
