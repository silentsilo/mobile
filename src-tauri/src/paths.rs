//! Where the app keeps its silos, the registry and the working copies.
//!
//! Android: the app's private storage. iOS: the app group's container, which
//! the AutoFill extension (`autofill/`) reads too; the app's own container
//! is out of an extension's reach.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "ios")]
    if let Some(dir) = crate::ios::group_data_dir() {
        return Ok(dir);
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

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
        let target = new.join(entry.file_name());
        if !target.exists() {
            let _ = std::fs::rename(entry.path(), &target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
