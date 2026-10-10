//! The phone's own key storage: on Android the Kotlin plugin in
//! `gen/android/.../DeviceKeyPlugin.kt`, on iOS the Secure Enclave through
//! core (`silentsilo_fido::device_enclave`), the same key kind a Mac uses.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// What the phone measured about itself, by doing each operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCheck {
    /// `android` or `ios`: which checks the screen shows.
    #[serde(default = "android")]
    pub platform: String,
    pub android_release: String,
    pub android_supported: bool,
    pub secure_lock: bool,
    pub strong_biometric: bool,
    /// `strongbox`, `tee` or `failed`.
    pub keystore: String,
    pub webview_version: String,
    pub webview_ok: bool,
    pub free_bytes: u64,
}

/// The kind and derivation this phone's own key carries in a silo's key
/// envelopes. Envelopes from both platforms sit side by side; each phone
/// only offers the kind it can answer.
#[cfg(target_os = "ios")]
pub const KIND: &str = silentsilo_vault::KIND_SECURE_ENCLAVE;
#[cfg(target_os = "ios")]
pub const DERIVATION: &str = silentsilo_vault::DERIVATION_ECDH_P256_V1;
#[cfg(not(target_os = "ios"))]
pub const KIND: &str = silentsilo_vault::KIND_ANDROID_KEYSTORE;
#[cfg(not(target_os = "ios"))]
pub const DERIVATION: &str = silentsilo_vault::DERIVATION_KEYSTORE_AES_GCM_V1;

fn android() -> String {
    "android".into()
}

/// A key made for one silo: the credential id to publish, the device key's
/// public half where the kind has one (hex, empty on Android), and the wrap
/// key the DEK is wrapped under.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrolled {
    pub credential_id: String,
    #[serde(default)]
    pub public_key: String,
    pub wrap_key: String,
}

/// The wrap key for whichever of the offered credentials this phone holds.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unlocked {
    pub credential_id: String,
    pub wrap_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutofillStatus {
    pub supported: bool,
    pub enabled: bool,
}

#[cfg(target_os = "android")]
pub struct DeviceKey<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// Any other build runs the same commands with nowhere to keep a key, which
/// is what `tauri dev` on a computer is for: every screen past the key. iOS
/// has no plugin either: core reaches the enclave itself.
#[cfg(not(target_os = "android"))]
pub struct DeviceKey<R: Runtime>(std::marker::PhantomData<fn() -> R>);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl<R: Runtime> DeviceKey<R> {
    const ABSENT: &str = "This build has no phone key storage.";

    pub async fn check(&self) -> Result<DeviceCheck, String> {
        Err(Self::ABSENT.into())
    }
    pub async fn enrol(&self, _vault_id: &str) -> Result<Enrolled, String> {
        Err(Self::ABSENT.into())
    }
    pub async fn unlock(&self, _vault_id: &str, _ids: &[String]) -> Result<Unlocked, String> {
        Err(Self::ABSENT.into())
    }
    pub async fn copy_secret(&self, _text: &str) -> Result<(), String> {
        Err(Self::ABSENT.into())
    }
    pub async fn clear_secret(&self) -> Result<(), String> {
        Ok(())
    }
    pub async fn remove(&self, _credential_id: &str) -> Result<(), String> {
        Err(Self::ABSENT.into())
    }
    pub async fn key_state(&self, _credential_id: &str) -> Result<String, String> {
        Err(Self::ABSENT.into())
    }
    pub async fn autofill_status(&self) -> Result<AutofillStatus, String> {
        Err(Self::ABSENT.into())
    }
    pub async fn device_name(&self) -> Result<String, String> {
        Err(Self::ABSENT.into())
    }
    pub async fn autofill_enable(&self) -> Result<(), String> {
        Err(Self::ABSENT.into())
    }
    pub async fn passkeys_status(&self) -> Result<AutofillStatus, String> {
        Err(Self::ABSENT.into())
    }
    pub async fn passkeys_enable(&self) -> Result<(), String> {
        Err(Self::ABSENT.into())
    }
    pub async fn set_theme(&self, _choice: &str) -> Result<(), String> {
        Ok(())
    }
    pub async fn haptic(&self, _kind: &str) -> Result<(), String> {
        Ok(())
    }
    pub async fn keep_awake(&self, _on: bool) -> Result<(), String> {
        Ok(())
    }
}

/// What a key iOS retired answers with; the unlock screen turns it into the
/// recovery code offer, as for Android.
#[cfg(target_os = "ios")]
const GONE: &str = "[invalidated] This phone's Face ID or Touch ID key for this silo is gone. Unlock with the recovery code.";

/// The enrolled faces or fingerprints when a key last worked. Keys are made
/// with `BiometryCurrentSet`, so any change since retires every one of them.
#[cfg(target_os = "ios")]
fn biometry_file() -> Option<std::path::PathBuf> {
    crate::background::data_dir().map(|d| d.join("biometry-state"))
}

#[cfg(target_os = "ios")]
fn remember_biometry() {
    if let (Some(file), Some(state)) = (biometry_file(), crate::ios::biometry_state()) {
        let _ = std::fs::write(file, state);
    }
}

/// True only when both the remembered and the current value are known and
/// differ: a phone with no record yet is not told its key is gone.
#[cfg(target_os = "ios")]
fn biometry_changed() -> bool {
    let before = biometry_file().and_then(|f| std::fs::read_to_string(f).ok());
    match (before, crate::ios::biometry_state()) {
        (Some(before), Some(now)) => before.trim() != now,
        _ => false,
    }
}

/// iPhone and iPad: the key is made and used in the Secure Enclave behind
/// Face ID or Touch ID. Each call blocks while the system sheet is up, so
/// it runs off the async runtime. Not yet on iOS: passkeys, and the device
/// name, which iOS gives an app only with an entitlement Apple grants.
#[cfg(target_os = "ios")]
impl<R: Runtime> DeviceKey<R> {
    const NOT_YET: &str = "Not available on iPhone yet.";

    pub async fn check(&self) -> Result<DeviceCheck, String> {
        let ready = blocking(silentsilo_fido::device_enclave::available).await?;
        Ok(DeviceCheck {
            platform: "ios".into(),
            android_release: String::new(),
            android_supported: true,
            secure_lock: ready,
            strong_biometric: ready,
            keystore: if ready { "strongbox" } else { "failed" }.into(),
            webview_version: String::new(),
            webview_ok: true,
            free_bytes: u64::MAX,
        })
    }

    pub async fn enrol(&self, vault_id: &str) -> Result<Enrolled, String> {
        let vault_id = vault_id.to_string();
        blocking(move || {
            silentsilo_fido::device_enclave::enrol(&vault_id)
                .inspect(|_| remember_biometry())
                .map(|m| Enrolled {
                    credential_id: hex::encode(&m.credential_id),
                    public_key: hex::encode(&m.device_public),
                    wrap_key: hex::encode(*m.wrap_key),
                })
                .map_err(|e| e.to_string())
        })
        .await?
    }

    pub async fn unlock(
        &self,
        vault_id: &str,
        credential_ids: &[String],
    ) -> Result<Unlocked, String> {
        let vault_id = vault_id.to_string();
        let ids: Vec<Vec<u8>> = credential_ids
            .iter()
            .filter_map(|id| hex::decode(id).ok())
            .collect();
        blocking(move || {
            // No key left behind these ids: iOS deleted it when the passcode
            // was removed, or it went with a change to the faces or
            // fingerprints. Said the way Android says it, so the unlock
            // screen offers the recovery code instead of a bare error.
            if !silentsilo_fido::device_enclave::holds_any(&ids) {
                return Err(GONE.to_string());
            }
            silentsilo_fido::device_enclave::derive_unlock_material(&ids, &vault_id)
                .inspect(|_| remember_biometry())
                .map(|m| Unlocked {
                    credential_id: hex::encode(&m.credential_id),
                    wrap_key: hex::encode(m.wrap_key),
                })
                .map_err(|e| {
                    // The key is still there, but the faces or fingerprints
                    // changed since it last worked: iOS retired it.
                    let e = e.to_string();
                    if !e.to_lowercase().contains("cancel") && biometry_changed() {
                        GONE.to_string()
                    } else {
                        e
                    }
                })
        })
        .await?
    }

    pub async fn copy_secret(&self, text: &str) -> Result<(), String> {
        let text = zeroize::Zeroizing::new(text.to_string());
        blocking(move || crate::ios::copy_secret(&text)).await
    }

    pub async fn clear_secret(&self) -> Result<(), String> {
        blocking(crate::ios::clear_secret).await
    }

    pub async fn remove(&self, credential_id: &str) -> Result<(), String> {
        let id = hex::decode(credential_id).map_err(|e| e.to_string())?;
        blocking(move || silentsilo_fido::device_enclave::remove(&id).map_err(|e| e.to_string()))
            .await?
    }

    /// `ok` or `invalidated`; asking prompts for nothing. This phone made
    /// the key, so one it no longer holds was taken by iOS: the passcode
    /// removed, or the faces or fingerprints changed. A change iOS leaves
    /// the key for is only found out at its next use.
    pub async fn key_state(&self, credential_id: &str) -> Result<String, String> {
        let id = hex::decode(credential_id).map_err(|e| e.to_string())?;
        let usable = blocking(move || {
            silentsilo_fido::device_enclave::holds_any(&[id]) && !biometry_changed()
        })
        .await?;
        Ok(if usable { "ok" } else { "invalidated" }.into())
    }

    pub async fn autofill_status(&self) -> Result<AutofillStatus, String> {
        let enabled = blocking(crate::ios::autofill_enabled).await?;
        Ok(AutofillStatus {
            supported: true,
            enabled,
        })
    }

    pub async fn device_name(&self) -> Result<String, String> {
        Ok("iPhone".into())
    }

    pub async fn autofill_enable(&self) -> Result<(), String> {
        if blocking(crate::ios::autofill_open_settings).await? {
            Ok(())
        } else {
            Err("This iPhone did not open its AutoFill settings.".into())
        }
    }

    pub async fn passkeys_status(&self) -> Result<AutofillStatus, String> {
        Ok(AutofillStatus {
            supported: false,
            enabled: false,
        })
    }

    pub async fn passkeys_enable(&self) -> Result<(), String> {
        Err(Self::NOT_YET.into())
    }

    pub async fn set_theme(&self, _choice: &str) -> Result<(), String> {
        Ok(())
    }

    pub async fn haptic(&self, kind: &str) -> Result<(), String> {
        crate::ios::haptic(kind);
        Ok(())
    }

    /// The screen stays on, and the app gets time if it is left, while long
    /// work runs.
    pub async fn keep_awake(&self, on: bool) -> Result<(), String> {
        crate::ios::keep_awake(on);
        Ok(())
    }
}

#[cfg(target_os = "ios")]
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
impl<R: Runtime> DeviceKey<R> {
    pub async fn check(&self) -> Result<DeviceCheck, String> {
        self.call("check", serde_json::json!({})).await
    }

    pub async fn enrol(&self, vault_id: &str) -> Result<Enrolled, String> {
        self.call("enrol", serde_json::json!({ "vaultId": vault_id }))
            .await
    }

    pub async fn unlock(
        &self,
        vault_id: &str,
        credential_ids: &[String],
    ) -> Result<Unlocked, String> {
        self.call(
            "unlock",
            serde_json::json!({ "vaultId": vault_id, "credentialIds": credential_ids }),
        )
        .await
    }

    /// Puts a secret on the clipboard marked sensitive, cleared after 45 s.
    pub async fn copy_secret(&self, text: &str) -> Result<(), String> {
        self.call::<serde_json::Value>("copySecret", serde_json::json!({ "text": text }))
            .await
            .map(|_| ())
    }

    /// Takes a secret this app copied off the clipboard now, for a lock.
    pub async fn clear_secret(&self) -> Result<(), String> {
        self.call::<serde_json::Value>("clearSecret", serde_json::json!({}))
            .await
            .map(|_| ())
    }

    pub async fn remove(&self, credential_id: &str) -> Result<(), String> {
        self.call::<serde_json::Value>(
            "remove",
            serde_json::json!({ "credentialId": credential_id }),
        )
        .await
        .map(|_| ())
    }

    /// `ok`, `invalidated` or `missing` for a credential this phone
    /// published, asked without a fingerprint prompt.
    pub async fn key_state(&self, credential_id: &str) -> Result<String, String> {
        #[derive(Deserialize)]
        struct State {
            state: String,
        }
        self.call::<State>(
            "keyState",
            serde_json::json!({ "credentialId": credential_id }),
        )
        .await
        .map(|s| s.state)
    }

    pub async fn autofill_status(&self) -> Result<AutofillStatus, String> {
        self.call("autofillStatus", serde_json::json!({})).await
    }

    pub async fn device_name(&self) -> Result<String, String> {
        #[derive(Deserialize)]
        struct Named {
            name: String,
        }
        self.call::<Named>("deviceName", serde_json::json!({}))
            .await
            .map(|n| n.name)
    }

    pub async fn autofill_enable(&self) -> Result<(), String> {
        self.call::<serde_json::Value>("autofillEnable", serde_json::json!({}))
            .await
            .map(|_| ())
    }

    pub async fn passkeys_status(&self) -> Result<AutofillStatus, String> {
        self.call("passkeysStatus", serde_json::json!({})).await
    }

    pub async fn passkeys_enable(&self) -> Result<(), String> {
        self.call::<serde_json::Value>("passkeysEnable", serde_json::json!({}))
            .await
            .map(|_| ())
    }

    /// A short vibration: `tick`, `confirm`, `reject` or `heavy`.
    pub async fn haptic(&self, kind: &str) -> Result<(), String> {
        self.call::<serde_json::Value>("haptic", serde_json::json!({ "kind": kind }))
            .await
            .map(|_| ())
    }

    /// The screen stays on while long work runs.
    pub async fn keep_awake(&self, on: bool) -> Result<(), String> {
        self.call::<serde_json::Value>("keepAwake", serde_json::json!({ "on": on }))
            .await
            .map(|_| ())
    }

    /// The theme chosen in the app, for the system bars and the window.
    pub async fn set_theme(&self, choice: &str) -> Result<(), String> {
        self.call::<serde_json::Value>("setTheme", serde_json::json!({ "choice": choice }))
            .await
            .map(|_| ())
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        payload: serde_json::Value,
    ) -> Result<T, String> {
        self.0
            .run_mobile_plugin_async(command, payload)
            .await
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("device-key")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.silentsilo.mobile", "DeviceKeyPlugin")?;
                app.manage(DeviceKey(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(DeviceKey::<R>(std::marker::PhantomData));
            }
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn device_check(app: tauri::AppHandle) -> Result<DeviceCheck, String> {
    app.state::<DeviceKey<tauri::Wry>>().check().await
}

#[tauri::command]
pub async fn autofill_status(app: tauri::AppHandle) -> Result<AutofillStatus, String> {
    app.state::<DeviceKey<tauri::Wry>>().autofill_status().await
}

/// Android's settings screen covers the app; that is not leaving it.
#[tauri::command]
pub async fn autofill_enable(app: tauri::AppHandle) -> Result<(), String> {
    let lock = app.state::<crate::background::BackgroundLock>();
    let _prompt = lock.prompt();
    app.state::<DeviceKey<tauri::Wry>>().autofill_enable().await
}

/// The phone's own name, to suggest for its key.
#[tauri::command]
pub async fn device_name(app: tauri::AppHandle) -> Result<String, String> {
    app.state::<DeviceKey<tauri::Wry>>().device_name().await
}

#[tauri::command]
pub async fn passkeys_status(app: tauri::AppHandle) -> Result<AutofillStatus, String> {
    app.state::<DeviceKey<tauri::Wry>>().passkeys_status().await
}

/// Android's settings screen covers the app; that is not leaving it.
#[tauri::command]
pub async fn passkeys_enable(app: tauri::AppHandle) -> Result<(), String> {
    let lock = app.state::<crate::background::BackgroundLock>();
    let _prompt = lock.prompt();
    app.state::<DeviceKey<tauri::Wry>>().passkeys_enable().await
}

/// `system`, `dark` or `light`: the system bars and the window background
/// follow the app's theme rather than the phone's.
#[tauri::command]
pub async fn app_theme_set(app: tauri::AppHandle, choice: String) -> Result<(), String> {
    if !matches!(choice.as_str(), "system" | "dark" | "light") {
        return Err("Unknown theme.".into());
    }
    app.state::<DeviceKey<tauri::Wry>>()
        .set_theme(&choice)
        .await
}

/// Touch feedback for a copy, a switch, a destructive confirm or an unlock.
#[tauri::command]
pub async fn haptic(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    if !matches!(kind.as_str(), "tick" | "confirm" | "reject" | "heavy") {
        return Err("Unknown haptic.".into());
    }
    app.state::<DeviceKey<tauri::Wry>>().haptic(&kind).await
}
