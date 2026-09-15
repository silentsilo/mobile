#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
mod autofill;
mod background;
mod backup;
mod commands;
mod device_key;
mod host;
mod incoming;
mod manage;
#[cfg(target_os = "android")]
mod passkeys;
mod security_key;
mod viewer;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(device_key::init())
        .plugin(backup::init())
        .plugin(incoming::init())
        .plugin(security_key::init())
        .manage(silentsilo_app::AppState::default())
        .manage(background::BackgroundLock::default())
        .register_asynchronous_uri_scheme_protocol("silo", |ctx, request, responder| {
            commands::serve_file(ctx.app_handle().clone(), request, responder)
        })
        .setup(|app| {
            // A phone has no per-user local directory for working copies and
            // fallback secrets: they live in the app's own private storage.
            background::remember(app.handle());
            let data = app.path().app_data_dir()?;
            silentsilo_vault::set_work_base(data.join("work"));
            #[cfg(target_os = "android")]
            android::seal_existing_secrets(&data);
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
            device_key::autofill_status,
            device_key::device_name,
            device_key::autofill_enable,
            device_key::passkeys_status,
            device_key::passkeys_enable,
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
            background::lock_on_screen_off_get,
            background::lock_on_screen_off_set,
            backup::backup_status,
            backup::backup_configure,
            backup::backup_disable,
            backup::backup_run_now,
            backup::backup_media_folders,
            backup::backup_waiting,
            incoming::files_pick,
            incoming::files_take_shared,
            incoming::files_take_photo,
            incoming::vault_import_offered,
            incoming::vault_import_photo,
            incoming::vault_create_folder,
            incoming::share_to_inbox,
            viewer::file_open_with,
            manage::vault_rename_file,
            manage::vault_rename_folder,
            manage::vault_move_file,
            manage::vault_move_folder,
            manage::vault_list_all_folders,
            manage::vault_search,
            manage::vault_trash_file,
            manage::vault_trash_folder,
            manage::vault_list_trash,
            manage::vault_restore_file,
            manage::vault_restore_folder,
            manage::vault_purge_trash,
            manage::silo_list,
            manage::silo_switch,
            manage::silo_remove,
            security_key::security_key_status,
            security_key::security_key_cancel,
            security_key::security_key_count,
            security_key::vault_unlock_with_security_key,
            security_key::security_key_enroll,
            security_key::vault_join_with_security_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SilentSilo");
}
