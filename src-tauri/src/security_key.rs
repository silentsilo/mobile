//! Security keys (YubiKey and the like) held to the back of the phone or
//! plugged in. `SecurityKeys.kt` finds the key and moves bytes; CTAP2 is
//! core's `silentsilo_fido::ctap2`, the same unverified `hmac-secret` the
//! desktop derives from, so a key enrolled on a computer opens the silo here.

use serde::{Deserialize, Serialize};
use silentsilo_app::flows::{self, DeviceKey};
use silentsilo_core::VaultMeta;
use silentsilo_fido::ctap2::{self, Ctap, CtapError};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, State};
use zeroize::Zeroizing;

use crate::commands::{active_silo, host};
use silentsilo_app::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub nfc: bool,
    pub nfc_on: bool,
    pub usb: bool,
}

#[cfg(target_os = "android")]
pub struct Plugin<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(not(target_os = "android"))]
pub struct Plugin<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> Plugin<R> {
    #[cfg(target_os = "android")]
    async fn call<T: serde::de::DeserializeOwned>(&self, command: &str) -> Result<T, String> {
        self.0
            .run_mobile_plugin_async(command, serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "android"))]
    async fn call<T: serde::de::DeserializeOwned>(&self, _command: &str) -> Result<T, String> {
        Err("This build cannot reach a security key.".into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("security-key")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.silentsilo.mobile", "SecurityKeyPlugin")?;
                app.manage(Plugin(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(Plugin::<R>(std::marker::PhantomData));
            }
            Ok(())
        })
        .build()
}

fn plugin(app: &AppHandle) -> State<'_, Plugin<tauri::Wry>> {
    app.state::<Plugin<tauri::Wry>>()
}

/// Waits until a key is on the phone, then runs `f` against it on a worker
/// thread, and lets the key go whatever happened.
async fn with_key<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&mut dyn Ctap) -> Result<T, CtapError> + Send + 'static,
) -> Result<T, String> {
    #[derive(Deserialize)]
    struct Found {
        transport: String,
    }
    let found: Found = plugin(app).call("waitForKey").await?;
    let usb = found.transport == "usb";
    let outcome = tauri::async_runtime::spawn_blocking(move || run(usb, f)).await;
    let _ = plugin(app).call::<serde_json::Value>("release").await;
    outcome
        .map_err(|e| e.to_string())?
        .map_err(|e| describe(&e, usb))
}

#[cfg(target_os = "android")]
fn run<T>(
    usb: bool,
    f: impl FnOnce(&mut dyn Ctap) -> Result<T, CtapError>,
) -> Result<T, CtapError> {
    if usb {
        f(&mut ctap2::hid::Hid::new(crate::android::UsbKey))
    } else {
        f(&mut ctap2::nfc::Nfc::new(crate::android::NfcKey))
    }
}

#[cfg(not(target_os = "android"))]
fn run<T>(
    _usb: bool,
    _f: impl FnOnce(&mut dyn Ctap) -> Result<T, CtapError>,
) -> Result<T, CtapError> {
    Err(CtapError::Transport("no security key link in this build".into()))
}

/// What to tell someone holding the key.
fn describe(error: &CtapError, usb: bool) -> String {
    match error {
        CtapError::Transport(_) if usb => "The security key was unplugged.".into(),
        CtapError::Transport(_) => {
            "The key moved away from the phone. Hold it still against the back until it is done."
                .into()
        }
        CtapError::NoCredentials => "This security key is not one of this silo's keys.".into(),
        CtapError::PinRequired => PIN_REQUIRED.into(),
        CtapError::PinInvalid => "Wrong PIN.".into(),
        CtapError::PinBlocked => {
            "This security key's PIN is blocked. Unblock it with the key maker's tool.".into()
        }
        CtapError::Timeout => "No touch arrived in time. Try again and touch the key.".into(),
        CtapError::Unsupported(why) => format!("This security key cannot open a silo: {why}."),
        CtapError::Protocol(_) | CtapError::Status(_) => {
            format!("The security key did not answer as expected ({error}). Try again.")
        }
    }
}

/// The screen asks for the PIN when it sees this.
const PIN_REQUIRED: &str = "This security key asks for its PIN.";

/// The silo's security keys, as ids the key can be asked about.
fn security_key_ids(root: &std::path::Path) -> Vec<Vec<u8>> {
    silentsilo_vault::load_fido_keys(root)
        .map(|keys| {
            keys.active()
                .filter(|k| {
                    k.kind == silentsilo_vault::KIND_FIDO2
                        && k.derivation == silentsilo_vault::DERIVATION_HMAC_V1
                })
                .filter_map(|k| hex::decode(&k.credential_id).ok())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn security_key_status(app: AppHandle) -> Result<KeyStatus, String> {
    plugin(&app).call("status").await
}

/// Stops waiting for a key; the waiting command fails with "Cancelled".
#[tauri::command]
pub async fn security_key_cancel(app: AppHandle) -> Result<(), String> {
    plugin(&app).call::<serde_json::Value>("cancel").await.map(|_| ())
}

/// How many of the silo's keys are security keys, for the unlock screen.
#[tauri::command]
pub fn security_key_count(state: State<AppState>) -> Result<usize, String> {
    Ok(security_key_ids(&active_silo(&state)?.path).len())
}

#[tauri::command]
pub async fn vault_unlock_with_security_key(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VaultMeta, String> {
    let silo = active_silo(&state)?;
    let ids = security_key_ids(&silo.path);
    if ids.is_empty() {
        return Err("This silo has no security keys.".into());
    }
    let vault_id = silo.id.to_string();
    let (credential_id, wrap_key) = with_key(&app, move |dev| {
        let unlock = ctap2::derive_unlock_material(dev, &ids, &vault_id)?;
        Ok((
            hex::encode(&unlock.credential_id),
            Zeroizing::new(unlock.wrap_key),
        ))
    })
    .await?;
    let root = silo.path.clone();
    let (session, meta) = tauri::async_runtime::spawn_blocking(move || {
        flows::open_with_device_key(root, &credential_id, &wrap_key, silo.id)
    })
    .await
    .map_err(|e| e.to_string())??;
    state.open_session(&host(&app), silo.id, session)?;
    Ok(meta)
}

/// Adds a security key to the open silo. `pin` only after the key asked.
#[tauri::command]
pub async fn security_key_enroll(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
    pin: Option<String>,
) -> Result<(), String> {
    let silo = active_silo(&state)?;
    if !state.open_silo_ids().contains(&silo.id) {
        return Err("Unlock the silo first.".into());
    }
    // Android's USB permission dialog covers the app; that is not leaving it.
    let lock = app.state::<crate::background::BackgroundLock>();
    let _prompt = lock.prompt();
    let vault_id = silo.id.to_string();
    let (made, wrap_key) = with_key(&app, move |dev| {
        let pin = pin.map(Zeroizing::new);
        let made = ctap2::make_credential(dev, &vault_id, pin.as_deref().map(String::as_str))?;
        let unlock = ctap2::derive_unlock_material(
            dev,
            std::slice::from_ref(&made.credential_id),
            &vault_id,
        )?;
        Ok((made, Zeroizing::new(unlock.wrap_key)))
    })
    .await?;
    let label = label.trim();
    let key = DeviceKey {
        kind: silentsilo_vault::KIND_FIDO2.into(),
        derivation: silentsilo_vault::DERIVATION_HMAC_V1.into(),
        credential_id: hex::encode(&made.credential_id),
        public_key: hex::encode(&made.public_key),
        wrap_key: *wrap_key,
        label: if label.is_empty() { "Security key" } else { label }.to_string(),
    };
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&silo.id)
        .ok_or_else(|| "The silo locked while the key was added. Add it again.".to_string())?;
    flows::enrol_device_key(session, &key).map(|_| ())
}
