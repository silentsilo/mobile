//! The phone's own key storage, reached through the Kotlin plugin in
//! `gen/android/.../DeviceKeyPlugin.kt`. iOS gets its counterpart with the
//! Mac and the Apple Developer ID.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// What the phone measured about itself, by doing each operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCheck {
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

/// A key made for one silo: the credential id to publish and the wrap key
/// the DEK is wrapped under.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrolled {
    pub credential_id: String,
    pub wrap_key: String,
}

/// The wrap key for whichever of the offered credentials this phone holds.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unlocked {
    pub credential_id: String,
    pub wrap_key: String,
}

#[cfg(target_os = "android")]
pub struct DeviceKey<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// Any other build runs the same commands with nowhere to keep a key, which
/// is what `tauri dev` on a computer is for: every screen past the key.
#[cfg(not(target_os = "android"))]
pub struct DeviceKey<R: Runtime>(std::marker::PhantomData<fn() -> R>);

#[cfg(not(target_os = "android"))]
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
    pub async fn remove(&self, _credential_id: &str) -> Result<(), String> {
        Err(Self::ABSENT.into())
    }
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

    pub async fn remove(&self, credential_id: &str) -> Result<(), String> {
        self.call::<serde_json::Value>(
            "remove",
            serde_json::json!({ "credentialId": credential_id }),
        )
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
