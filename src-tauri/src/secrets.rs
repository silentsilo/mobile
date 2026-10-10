//! The local secret files (registry, storage settings, device credentials),
//! sealed by the platform's protector: the Keystore on Android, the Keychain
//! on iOS.

/// Rewrites the secret files a build before the protector left in the clear.
/// Each one is read back after the rewrite; one that does not read back the
/// same gets its original bytes again, so nothing is lost to a Keystore
/// or Keychain that misbehaves. Only once a protector is set.
pub fn seal_existing(app_data: &std::path::Path) {
    let registry_path = silentsilo_vault::registry_path(app_data);
    if let Some(original) = plaintext(&registry_path) {
        let before = silentsilo_vault::load_registry(app_data);
        let same = silentsilo_vault::save_registry(app_data, &before).is_ok()
            && json(&silentsilo_vault::load_registry(app_data)) == json(&before);
        if !same {
            let _ = std::fs::write(&registry_path, original);
        }
    }

    for silo in silentsilo_vault::load_registry(app_data).silos {
        let dir = silentsilo_vault::workdir::secrets_dir_for(silo.id);

        let config_path = dir.join("s3.config.json");
        if let Some(original) = plaintext(&config_path)
            && let Some(before) = silentsilo_vault::load_s3_config(silo.id)
        {
            let same = silentsilo_vault::save_s3_config(silo.id, &before).is_ok()
                && silentsilo_vault::load_s3_config(silo.id).map(|c| json(&c))
                    == Some(json(&before));
            if !same {
                let _ = std::fs::write(&config_path, original);
            }
        }

        let credentials_path = dir.join("credentials.json");
        if let Some(original) = plaintext(&credentials_path)
            && let Ok(before) = silentsilo_vault::load_credentials(silo.id)
        {
            let same = silentsilo_vault::save_credentials(&before).is_ok()
                && silentsilo_vault::load_credentials(silo.id)
                    .is_ok_and(|after| after.device_secret == before.device_secret);
            if !same {
                let _ = std::fs::write(&credentials_path, original);
            }
        }
    }
}

/// The file's bytes, when it exists and is not sealed yet.
fn plaintext(path: &std::path::Path) -> Option<Vec<u8>> {
    std::fs::read(path)
        .ok()
        .filter(|b| !b.starts_with(b"SSDPAPI1"))
}

fn json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_default()
}
