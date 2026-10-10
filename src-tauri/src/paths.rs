//! Where the app keeps its silos, the registry and the working copies.
//!
//! Android: the app's private storage. iOS: the app group's container, which
//! the AutoFill extension (`autofill/`) reads too; the app's own container
//! is out of an extension's reach.
//!
//! The working copies (`work`) stay in the app's own container on iOS. An
//! open silo keeps SQLite databases open there, and iOS ends a suspended app
//! that holds a lock on a file in an app group's container (0xdead10cc).
//! AutoFill does not need them: it opens the silo in a scratch of its own.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "ios")]
    if let Some(dir) = crate::ios::group_data_dir() {
        return Ok(dir);
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Where working copies, caches and the fallback secrets live.
pub fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "ios")]
    return app
        .path()
        .app_data_dir()
        .map(|d| d.join(WORK))
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "ios"))]
    data_dir(app).map(|d| d.join(WORK))
}

const WORK: &str = "work";

/// iOS, once: what a build before the app group kept in the app's own
/// container moves into the group's. Entry by entry, each a rename on the
/// same volume; anything already at the new place is left where it is, so
/// nothing is written over. `commands::rehome_silos` then points the
/// registry at the silos' new folders.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn move_into(old: &Path, new: &Path) {
    if old == new || !old.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(old) else {
        return;
    };
    if std::fs::create_dir_all(new).is_err() {
        return;
    }
    for entry in entries.flatten() {
        if entry.file_name() == WORK {
            continue;
        }
        let target = new.join(entry.file_name());
        if !target.exists() {
            let _ = std::fs::rename(entry.path(), &target);
        }
    }
}

/// iOS: a build of 10 October 2026 moved `work` into the app group too. It
/// comes back, with the secrets inside it, unless the app already has one.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn take_work_back(group: &Path, own: &Path) {
    let moved = group.join(WORK);
    let home = own.join(WORK);
    if moved.is_dir() && !home.exists() {
        let _ = std::fs::create_dir_all(own);
        let _ = std::fs::rename(&moved, &home);
    }
}

/// A silo folder under `silos/` the registry does not list, put back in it.
/// The registry is sealed with this device's key: when that key is gone (a
/// restore to another phone, a Keychain that will not answer) it reads as
/// empty, and the next save would drop every silo from the list. The
/// unreadable file is kept aside rather than written over.
pub fn recover_silos(data: &Path) {
    let mut registry = silentsilo_vault::load_registry(data);
    let Ok(folders) = std::fs::read_dir(data.join("silos")) else {
        return;
    };
    let mut found = Vec::new();
    for folder in folders.flatten() {
        let path = folder.path();
        if let Ok(marker) = silentsilo_vault::read_marker(&path)
            && registry.get(marker.vault_id).is_none()
            && !found.iter().any(|(id, _)| *id == marker.vault_id)
        {
            found.push((marker.vault_id, path));
        }
    }
    if found.is_empty() {
        return;
    }
    let file = silentsilo_vault::registry_path(data);
    if registry.silos.is_empty() && file.exists() {
        let aside = file.with_extension("json.unreadable");
        if !aside.exists() {
            let _ = std::fs::copy(&file, &aside);
        }
    }
    for (id, path) in found {
        registry.silos.push(silentsilo_vault::SiloEntry {
            id,
            name: "Silo".into(),
            path,
            last_opened: 0,
            auto_lock_minutes: None,
        });
    }
    let _ = silentsilo_vault::save_registry(data, &registry);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_silo_folder_the_registry_lost_is_listed_again() {
        let data = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4();
        let folder = data.path().join("silos").join(id.to_string());
        silentsilo_vault::write_marker(&folder, id).unwrap();
        recover_silos(data.path());
        let registry = silentsilo_vault::load_registry(data.path());
        assert_eq!(registry.silos.len(), 1);
        assert_eq!(registry.silos[0].id, id);
        assert_eq!(registry.silos[0].path, folder);
        recover_silos(data.path());
        assert_eq!(silentsilo_vault::load_registry(data.path()).silos.len(), 1);
    }

    #[test]
    fn the_work_folder_stays_behind_and_comes_back() {
        let own = tempfile::tempdir().unwrap();
        let group = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(own.path().join("work/secrets")).unwrap();
        move_into(own.path(), group.path());
        assert!(own.path().join("work/secrets").is_dir());
        assert!(!group.path().join("work").exists());

        let own2 = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(group.path().join("work/secrets")).unwrap();
        take_work_back(group.path(), own2.path());
        assert!(own2.path().join("work/secrets").is_dir());
        assert!(!group.path().join("work").exists());
    }

    #[test]
    fn what_was_kept_moves_and_nothing_is_written_over() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(old.path().join("silos/a")).unwrap();
        std::fs::write(old.path().join("silos/a/vault.db.enc"), b"old").unwrap();
        std::fs::write(old.path().join("registry.json"), b"old registry").unwrap();
        std::fs::write(new.path().join("registry.json"), b"new registry").unwrap();

        move_into(old.path(), new.path());

        assert_eq!(
            std::fs::read(new.path().join("silos/a/vault.db.enc")).unwrap(),
            b"old"
        );
        assert_eq!(
            std::fs::read(new.path().join("registry.json")).unwrap(),
            b"new registry"
        );
        assert!(old.path().join("registry.json").exists());
    }
}
