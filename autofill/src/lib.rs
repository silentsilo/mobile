//! The iPhone's AutoFill extension (`gen/apple/AutoFill/`), which iOS runs
//! in a process of its own, apart from the app. It opens the silo the app
//! shows first with this iPhone's Face ID key, as Android's autofill does,
//! lists its logins and closes it again. Nothing is written back to the
//! silo: the extension has its own scratch folder and empties it, so a silo
//! the app holds open at the same time is left alone.

#[cfg(target_os = "ios")]
#[path = "../../src-tauri/src/keychain.rs"]
mod keychain;

#[cfg(target_os = "ios")]
mod extension {
    use std::ffi::{CStr, CString, c_char};
    use std::path::Path;

    use serde_json::{Value, json};
    use silentsilo_app::flows;
    use silentsilo_vault::{KIND_SECURE_ENCLAVE, load_registry};
    use zeroize::Zeroize;

    fn text(raw: *const c_char) -> String {
        if raw.is_null() {
            return String::new();
        }
        // SAFETY: a NUL-terminated string Swift keeps alive for the call.
        unsafe { CStr::from_ptr(raw) }
            .to_string_lossy()
            .into_owned()
    }

    /// `{logins: [{service, username, password, url}]}` or `{error}`. Asks
    /// for Face ID, so it is called off the main thread.
    #[unsafe(no_mangle)]
    pub extern "C" fn ss_af_logins(
        data_dir: *const c_char,
        work_dir: *const c_char,
    ) -> *mut c_char {
        let answer = match logins(Path::new(&text(data_dir)), Path::new(&text(work_dir))) {
            Ok(logins) => json!({ "logins": logins }),
            Err(error) => json!({ "error": error }),
        };
        CString::new(answer.to_string())
            .unwrap_or_default()
            .into_raw()
    }

    /// Frees an answer, wiping it first: it holds passwords.
    #[unsafe(no_mangle)]
    pub extern "C" fn ss_af_free(raw: *mut c_char) {
        if !raw.is_null() {
            // SAFETY: made by `ss_af_logins`, freed once.
            let mut bytes = unsafe { CString::from_raw(raw) }.into_bytes();
            bytes.zeroize();
        }
    }

    fn logins(data_dir: &Path, work_dir: &Path) -> Result<Vec<Value>, String> {
        // Its own scratch, set before anything opens.
        silentsilo_vault::set_work_base(work_dir.to_path_buf());
        // The registry is sealed with the app's Keychain key.
        crate::keychain::install_protector();

        let registry = load_registry(data_dir);
        let silo = registry
            .active
            .and_then(|id| registry.get(id).cloned())
            .or_else(|| registry.silos.first().cloned())
            .ok_or("There is no silo on this iPhone yet. Open SilentSilo to make one.")?;
        let ids: Vec<Vec<u8>> = flows::device_key_ids(&silo.path, KIND_SECURE_ENCLAVE)
            .iter()
            .filter_map(|id| hex::decode(id).ok())
            .collect();
        if ids.is_empty() {
            return Err(
                "This iPhone has no Face ID key for this silo. Open SilentSilo to add one.".into(),
            );
        }
        let mut material =
            silentsilo_fido::device_enclave::derive_unlock_material(&ids, &silo.id.to_string())
                .map_err(|e| e.to_string())?;
        let opened = flows::open_with_device_key(
            silo.path.clone(),
            &hex::encode(&material.credential_id),
            &material.wrap_key,
            silo.id,
        );
        material.wrap_key.zeroize();
        let (session, _) = opened?;

        let paths = session.paths.clone();
        let rows = silentsilo_vfs::Vfs::new(&session).list_passwords();
        // Dropped, not locked: a lock writes the snapshot back into the silo,
        // which is the app's to do.
        drop(session);
        silentsilo_vault::wipe_plaintext_working_copy(&paths);
        let _ = std::fs::remove_dir_all(work_dir);

        Ok(rows
            .map_err(|e| e.to_string())?
            .iter()
            .filter_map(|row| serde_json::from_str::<Value>(row).ok())
            .filter(|entry| {
                entry
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("login")
                    == "login"
                    && !field(entry, "password").is_empty()
            })
            .map(|entry| {
                json!({
                    "service": field(&entry, "service"),
                    "username": field(&entry, "username"),
                    "password": field(&entry, "password"),
                    "url": field(&entry, "url"),
                })
            })
            .collect())
    }

    fn field<'a>(entry: &'a Value, name: &str) -> &'a str {
        entry.get(name).and_then(|v| v.as_str()).unwrap_or("")
    }
}
