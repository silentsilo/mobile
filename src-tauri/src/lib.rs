mod background;
mod commands;
mod device_key;
mod host;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(device_key::init())
        .manage(silentsilo_app::AppState::default())
        .manage(background::BackgroundLock::default())
        .register_asynchronous_uri_scheme_protocol("silo", |ctx, request, responder| {
            commands::serve_file(ctx.app_handle().clone(), request, responder)
        })
        .setup(|app| {
            // A phone has no per-user local directory for working copies and
            // fallback secrets: they live in the app's own private storage.
            let data = app.path().app_data_dir()?;
            silentsilo_vault::set_work_base(data.join("work"));
            let handle = app.handle().clone();
            commands::restore_focus(&handle, &app.state::<silentsilo_app::AppState>());
            commands::spawn_auto_sync(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(mobile)]
            match event {
                tauri::WindowEvent::Suspended => background::suspended(window.app_handle()),
                tauri::WindowEvent::Resumed => background::resumed(window.app_handle()),
                _ => {}
            }
            #[cfg(not(mobile))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            device_key::device_check,
            commands::app_bootstrap,
            commands::sftp_probe_host_key,
            commands::vault_preview_join,
            commands::vault_join_with_recovery,
            commands::device_key_enroll,
            commands::vault_unlock,
            commands::vault_unlock_with_recovery,
            commands::vault_lock,
            commands::vault_read_passwords,
            commands::vault_upsert_password,
            commands::vault_delete_password,
            commands::copy_secret_to_clipboard,
            commands::vault_root_folder,
            commands::vault_list_folder,
            commands::sync_status,
            commands::sync_now,
            commands::fido_list_keys,
            commands::fido_remove_key,
            commands::recovery_status,
            background::lock_after_get,
            background::lock_after_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SilentSilo");
}
