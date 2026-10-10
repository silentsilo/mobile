#[cfg(target_os = "android")]
mod android;
mod audit;
#[cfg(target_os = "android")]
mod autofill;
mod background;
mod backup;
mod cloud;
mod commands;
mod copies;
mod create;
mod device_key;
mod history;
mod host;
mod incoming;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "ios")]
mod keychain;
mod manage;
#[cfg(target_os = "android")]
mod passkeys;
mod paths;
#[cfg(mobile)]
mod secrets;
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
        .manage(cloud::SignInSlot::default())
        .register_asynchronous_uri_scheme_protocol("silo", |ctx, request, responder| {
            commands::serve_file(ctx.app_handle().clone(), request, responder)
        })
        .setup(|app| {
            // A phone has no per-user local directory for working copies and
            // fallback secrets: they live in the app's own private storage.
            #[cfg(all(target_os = "android", debug_assertions))]
            android::stderr_to_logcat();
            // The app group's container, from the release with AutoFill: what
            // an earlier build kept in the app's own moves there first.
            #[cfg(target_os = "ios")]
            if let (Ok(old), Ok(new)) = (app.path().app_data_dir(), paths::data_dir(app.handle())) {
                paths::move_into(&old, &new);
                paths::take_work_back(&new, &old);
            }
            background::remember(app.handle());
            #[cfg(target_os = "ios")]
            ios::install_privacy_cover();
            let data = paths::data_dir(app.handle())?;
            #[cfg(all(target_os = "ios", debug_assertions))]
            {
                let _ = std::fs::create_dir_all(&data);
                ios::stderr_to_file(&data.join("stderr.log"));
            }
            silentsilo_vault::set_work_base(paths::work_dir(app.handle())?);
            // Out of iCloud and computer backups: the keys stay on this phone.
            #[cfg(target_os = "ios")]
            for dir in [Some(data.clone()), app.path().app_data_dir().ok()]
                .into_iter()
                .flatten()
            {
                ios::exclude_from_backup(&dir);
            }
            // Before the first secret file is read or written.
            #[cfg(target_os = "ios")]
            let sealed = keychain::install_protector();
            #[cfg(target_os = "android")]
            let sealed = android::protector_ready();
            // OneDrive, Dropbox and Google Drive open through the tokens the
            // vault keeps.
            silentsilo_vault::install_cloud();
            // Nothing is unlocked yet: any scratch left is from a process
            // Android killed while a silo was open.
            let _ = app.state::<silentsilo_app::AppState>().sweep_scratch();
            #[cfg(mobile)]
            if sealed {
                secrets::seal_existing(&data);
            }
            commands::rehome_silos(&data);
            // Only with the key that seals the registry: without it the
            // registry reads as empty, and this would rename every silo.
            #[cfg(mobile)]
            if sealed {
                paths::clear_unfinished_joins(&data);
                paths::recover_silos(&data);
            }
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
                // iOS: tao sends Suspended when the scene resigns active, which
                // a Face ID sheet does, but Resumed only after a trip to the
                // background. Becoming active again is the matching event.
                #[cfg(target_os = "ios")]
                tauri::WindowEvent::Focused(true) => background::resumed(window.app_handle()),
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
            device_key::app_theme_set,
            device_key::haptic,
            commands::app_bootstrap,
            commands::sftp_probe_host_key,
            commands::vault_preview_join,
            commands::vault_join_with_recovery,
            commands::device_key_enroll,
            commands::phone_key_state,
            commands::vault_unlock,
            commands::vault_reverify,
            commands::vault_unlock_with_recovery,
            commands::vault_lock,
            commands::vault_read_passwords,
            commands::vault_upsert_password,
            commands::vault_delete_password,
            commands::copy_secret_to_clipboard,
            audit::audit_note,
            audit::audit_status,
            audit::audit_set_enabled,
            commands::vault_root_folder,
            commands::vault_list_folder,
            commands::sync_status,
            commands::sync_now,
            commands::vault_rebuild,
            commands::fido_list_keys,
            commands::fido_remove_key,
            commands::recovery_status,
            background::lock_after_get,
            background::lock_after_set,
            history::history_policy_get,
            history::history_policy_set,
            background::lock_on_screen_off_get,
            background::lock_on_screen_off_set,
            background::app_busy,
            backup::backup_status,
            backup::backup_configure,
            backup::backup_disable,
            backup::backup_run_now,
            backup::backup_media_folders,
            backup::backup_waiting,
            incoming::app_open_link,
            incoming::files_pick,
            incoming::files_take_shared,
            incoming::files_take_photo,
            incoming::vault_import_offered,
            incoming::vault_import_photo,
            incoming::files_left_photos,
            incoming::files_discard_shared,
            incoming::files_discard_left_photos,
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
            create::silo_create,
            create::silo_resume_new,
            create::recovery_create,
            create::storage_view,
            create::storage_save,
            cloud::cloud_providers,
            cloud::cloud_sign_in,
            cloud::cloud_cancel_sign_in,
            cloud::cloud_discard_sign_in,
            cloud::cloud_list_silos,
            copies::backup_targets_list,
            copies::backup_target_add,
            copies::backup_target_remove,
            copies::backup_target_fill,
            copies::backup_target_fill_stop,
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
