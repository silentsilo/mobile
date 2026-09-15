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
    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<T, String> {
        self.0
            .run_mobile_plugin_async(command, args)
            .await
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "android"))]
    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        _command: &str,
        _args: serde_json::Value,
    ) -> Result<T, String> {
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

/// Why a ceremony with the key stopped.
enum KeyError {
    Key {
        error: CtapError,
        usb: bool,
    },
    /// Cancelled, or the phone side failed: already words.
    Other(String),
}

impl KeyError {
    fn into_message(self) -> String {
        match self {
            KeyError::Key { error, usb } => {
                // Statuses and framing only; nothing secret is in a CTAP error.
                eprintln!("[security-key] {error:?}");
                describe(&error, usb)
            }
            KeyError::Other(message) => message,
        }
    }
}

/// Waits until a key is on the phone, runs `f` against it on a worker
/// thread, and lets the key go whatever happened.
async fn with_key<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&mut dyn Ctap) -> Result<T, CtapError> + Send + 'static,
) -> Result<T, KeyError> {
    #[derive(Deserialize)]
    struct Found {
        transport: String,
    }
    let found: Found = plugin(app)
        .call("waitForKey", serde_json::json!({}))
        .await
        .map_err(KeyError::Other)?;
    let usb = found.transport == "usb";
    let outcome = tauri::async_runtime::spawn_blocking(move || run(usb, f)).await;
    let _ = plugin(app)
        .call::<serde_json::Value>("release", serde_json::json!({}))
        .await;
    outcome
        .map_err(|e| KeyError::Other(e.to_string()))?
        .map_err(|error| KeyError::Key { error, usb })
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
    Err(CtapError::Transport(
        "no security key link in this build".into(),
    ))
}

/// The PIN, asked in Android's own dialog: typed there and handed to Rust,
/// it never passes through the web view, whose strings cannot be wiped.
enum PinAnswer {
    Pin(Zeroizing<String>),
    /// The person says the key they will use has no PIN.
    NoPin,
    Cancelled,
}

async fn ask_pin(app: &AppHandle, note: Option<&str>, offer_no_pin: bool) -> PinAnswer {
    #[derive(Deserialize)]
    struct Answer {
        pin: Option<String>,
        #[serde(default)]
        no_pin: bool,
    }
    let answer: Result<Answer, String> = plugin(app)
        .call(
            "askPin",
            serde_json::json!({ "note": note, "offerNoPin": offer_no_pin }),
        )
        .await;
    match answer {
        Ok(Answer { pin: Some(pin), .. }) if !pin.is_empty() => PinAnswer::Pin(Zeroizing::new(pin)),
        Ok(Answer { no_pin: true, .. }) => PinAnswer::NoPin,
        _ => PinAnswer::Cancelled,
    }
}

/// Runs a ceremony that may need the key's PIN, asking for it natively
/// when the key does and again after a wrong one.
async fn with_pin<T: Send + 'static>(
    app: &AppHandle,
    mut pin: Option<Zeroizing<String>>,
    ceremony: impl Fn(&mut dyn Ctap, Option<&str>) -> Result<T, CtapError>
    + Send
    + Sync
    + Clone
    + 'static,
) -> Result<(T, Option<Zeroizing<String>>), String> {
    loop {
        let attempt = std::sync::Arc::new(pin.clone());
        let run = ceremony.clone();
        let given = attempt.clone();
        let note = match with_key(app, move |dev| {
            run(dev, given.as_deref().map(String::as_str))
        })
        .await
        {
            Ok(done) => return Ok((done, pin)),
            Err(KeyError::Key {
                error: CtapError::PinRequired,
                ..
            }) if pin.is_none() => None,
            Err(KeyError::Key {
                error: error @ CtapError::PinInvalid { .. },
                usb,
            }) => Some(describe(&error, usb)),
            Err(other) => return Err(other.into_message()),
        };
        match ask_pin(app, note.as_deref(), false).await {
            PinAnswer::Pin(given) => pin = Some(given),
            PinAnswer::NoPin | PinAnswer::Cancelled => return Err(CANCELLED.into()),
        }
    }
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
        CtapError::PinRequired => "This security key asks for its PIN.".into(),
        CtapError::PinInvalid { retries: Some(n) } => {
            format!("Wrong PIN. {n} tries left before the key blocks its PIN.")
        }
        CtapError::PinInvalid { retries: None } => "Wrong PIN.".into(),
        CtapError::PinAuthBlocked => "Three wrong PINs in a row. Take the key away from the phone \
             or unplug it, then try again."
            .into(),
        CtapError::PinNotSet => {
            "This security key needs a PIN before it can be used. Set one with \
             the key maker's app (for a YubiKey, Yubico Authenticator), then add it again."
                .into()
        }
        CtapError::PinBlocked => "This security key's PIN is blocked after too many wrong tries. \
             Only a reset of the key unblocks it, and a reset erases it from every silo, so open \
             the silo another way: this phone's fingerprint, another key or the recovery code."
            .into(),
        CtapError::Timeout => "No touch arrived in time. Try again and touch the key.".into(),
        CtapError::TouchAgain => "The key wants another touch. Take it away from the phone or \
             unplug it, and try again."
            .into(),
        CtapError::Unsupported(why) => format!("This security key cannot open a silo: {why}."),
        CtapError::Protocol(_) | CtapError::Status(_) => {
            format!("The security key did not answer as expected ({error}). Try again.")
        }
    }
}

/// What the screens treat as the person stopping, not a failure.
const CANCELLED: &str = "Cancelled";

const NOT_OPENED: &str = "This security key could not open the silo.";

const ADDED_WITHOUT_PIN: &str = "This key was added without its PIN, which works only with the \
     key plugged in. To use it over NFC, remove it in Keys and add it again.";

/// The silo's security keys, as ids the key can be asked about.
fn security_key_ids(root: &std::path::Path) -> Vec<Vec<u8>> {
    silentsilo_vault::load_fido_keys(root)
        .map(|keys| {
            keys.active()
                .filter(|k| {
                    // Windows Hello and the like live in one computer, not a key.
                    k.kind == silentsilo_vault::KIND_FIDO2
                        && k.derivation == silentsilo_vault::DERIVATION_HMAC_V1
                        && !k.platform
                })
                .filter_map(|k| hex::decode(&k.credential_id).ok())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn security_key_status(app: AppHandle) -> Result<KeyStatus, String> {
    plugin(&app).call("status", serde_json::json!({})).await
}

/// Stops waiting for a key; the waiting command fails with "Cancelled".
#[tauri::command]
pub async fn security_key_cancel(app: AppHandle) -> Result<(), String> {
    plugin(&app)
        .call::<serde_json::Value>("cancel", serde_json::json!({}))
        .await
        .map(|_| ())
}

/// How many security keys the silo has, for the unlock screen's button.
#[tauri::command]
pub fn security_key_count(state: State<AppState>) -> Result<usize, String> {
    Ok(security_key_ids(&active_silo(&state)?.path).len())
}

/// Credential ids (not secret) that last opened a silo with their PIN.
fn pin_keys_path() -> Option<std::path::PathBuf> {
    crate::background::data_dir().map(|dir| dir.join("security-key-pin.json"))
}

fn pin_keys() -> Vec<String> {
    pin_keys_path()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn remember_pin_key(credential_id: &str, verified: bool) {
    let mut keys = pin_keys();
    let known = keys.iter().any(|k| k == credential_id);
    if known == verified {
        return;
    }
    keys.retain(|k| k != credential_id);
    if verified {
        keys.push(credential_id.to_string());
    }
    if let (Some(path), Ok(bytes)) = (pin_keys_path(), serde_json::to_vec(&keys)) {
        let _ = std::fs::write(path, bytes);
    }
}

/// Opens the silo with a security key.
///
/// The wrap key depends on how the silo was wrapped: Windows asks for the
/// PIN of a key that has one, which reaches the key's verified secret, and
/// PRF-style platforms hash the salt. So a key with a PIN is asked for it,
/// before the tap when one of the silo's keys needed it last time, each
/// answer is tried against the envelope while the key is still there, and
/// an unverified answer is tried last for a key enrolled somewhere that did
/// not verify.
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
    let envelopes: std::collections::HashMap<String, String> =
        silentsilo_vault::load_fido_keys(&silo.path)
            .map(|keys| {
                keys.active()
                    .map(|k| (k.credential_id.clone(), k.wrapped_dek.clone()))
                    .collect()
            })
            .unwrap_or_default();
    let remembered = pin_keys();
    let mut pin = None;
    if ids.iter().any(|id| remembered.contains(&hex::encode(id))) {
        match ask_pin(&app, None, true).await {
            PinAnswer::Pin(given) => pin = Some(given),
            PinAnswer::NoPin => {}
            PinAnswer::Cancelled => return Err(CANCELLED.into()),
        }
    }

    let vault_id = silo.id.to_string();
    let ceremony = move |dev: &mut dyn Ctap, pin: Option<&str>| {
        if pin.is_none() && ctap2::get_info(dev)?.pin_set {
            return Err(CtapError::PinRequired);
        }
        let opens = |c: &ctap2::UnlockCandidates| {
            let id = hex::encode(&c.credential_id);
            let wrapped = envelopes.get(&id)?;
            c.wrap_keys.iter().find_map(|(shape, key)| {
                silentsilo_vault::unwrap_dek_hex(wrapped, key)
                    .ok()
                    .map(|_| (id.clone(), *shape, c.verified, key.clone()))
            })
        };
        let first = ctap2::unlock_candidates(dev, &ids, &vault_id, pin, true)?;
        if let Some(hit) = opens(&first) {
            return Ok(Ok(hit));
        }
        if first.verified {
            // A key added somewhere that did not use its PIN. Over NFC the
            // key refuses a second assertion in one tap after a verified
            // one, so this may only work plugged in.
            return match ctap2::unlock_candidates(dev, &ids, &vault_id, None, false) {
                Ok(unverified) => Ok(opens(&unverified).ok_or(NOT_OPENED)),
                Err(CtapError::NoCredentials) => Ok(Err(NOT_OPENED)),
                Err(_) => Ok(Err(ADDED_WITHOUT_PIN)),
            };
        }
        Ok(Err(NOT_OPENED))
    };
    let (found, _) = with_pin(&app, pin, ceremony).await?;
    let (credential_id, _shape, verified, wrap_key) = found.map_err(str::to_string)?;
    remember_pin_key(&credential_id, verified);
    let root = silo.path.clone();
    let (session, meta) = tauri::async_runtime::spawn_blocking(move || {
        flows::open_with_device_key(root, &credential_id, &wrap_key, silo.id)
    })
    .await
    .map_err(|e| e.to_string())??;
    state.open_session(&host(&app), silo.id, session)?;
    Ok(meta)
}

/// Adds a security key to the open silo.
#[tauri::command]
pub async fn security_key_enroll(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
) -> Result<(), String> {
    use tauri::Emitter;

    let silo = active_silo(&state)?;
    if !state.open_silo_ids().contains(&silo.id) {
        return Err("Unlock the silo first.".into());
    }
    // Android's USB permission dialog covers the app; that is not leaving it.
    let lock = app.state::<crate::background::BackgroundLock>();
    let _prompt = lock.prompt();
    let vault_id = silo.id.to_string();

    // Two touches, or two taps: a key counts one presence per operation,
    // and over NFC one per tap, so the credential and its secret cannot
    // share one.
    let made_vault = vault_id.clone();
    let (made, pin) = with_pin(&app, None, move |dev, pin| {
        ctap2::make_credential(dev, &made_vault, pin)
    })
    .await?;
    let _ = app.emit("security-key-step", 2);

    let id = made.credential_id.clone();
    let (wrap_key, verified) = with_key(&app, move |dev| {
        let pin = pin.as_deref().map(String::as_str);
        // Verified when the key has a PIN, as Windows will be.
        let found = ctap2::unlock_candidates(dev, std::slice::from_ref(&id), &vault_id, pin, true)?;
        let verified = found.verified;
        let (_, key) = found
            .wrap_keys
            .into_iter()
            .find(|(shape, _)| *shape == ctap2::SaltShape::Raw)
            .ok_or_else(|| CtapError::Protocol("no raw hmac-secret output".into()))?;
        Ok((key, verified))
    })
    .await
    .map_err(KeyError::into_message)?;
    remember_pin_key(&hex::encode(&made.credential_id), verified);
    let label = label.trim();
    let key = DeviceKey {
        kind: silentsilo_vault::KIND_FIDO2.into(),
        derivation: silentsilo_vault::DERIVATION_HMAC_V1.into(),
        credential_id: hex::encode(&made.credential_id),
        public_key: hex::encode(&made.public_key),
        wrap_key: *wrap_key,
        label: if label.is_empty() {
            "Security key"
        } else {
            label
        }
        .to_string(),
    };
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&silo.id)
        .ok_or_else(|| "The silo locked while the key was added. Add it again.".to_string())?;
    flows::enrol_device_key(session, &key).map(|_| ())
}

/// Joins a silo from its storage with a security key already on it, for
/// someone without the recovery code at hand. The phone key comes after, as
/// with the code.
#[tauri::command]
pub async fn vault_join_with_security_key(
    app: AppHandle,
    state: State<'_, AppState>,
    config: silentsilo_app::StoreConfigInput,
    name: String,
) -> Result<VaultMeta, String> {
    let store_config = config.into_config(None)?;
    let store = store_config.open().map_err(|e| e.to_string())?;
    let offer = flows::key_join_begin(&*store).await?;
    let ids: Vec<Vec<u8>> = offer
        .keys
        .iter()
        .filter(|k| {
            k.kind == silentsilo_vault::KIND_FIDO2
                && k.derivation == silentsilo_vault::DERIVATION_HMAC_V1
                && !k.platform
        })
        .filter_map(|k| hex::decode(&k.credential_id).ok())
        .collect();
    if ids.is_empty() {
        return Err(
            "None of this silo's keys is a security key. Join with the recovery code.".into(),
        );
    }
    let envelopes: std::collections::HashMap<String, String> = offer
        .keys
        .iter()
        .map(|k| (k.credential_id.clone(), k.wrapped_dek.clone()))
        .collect();
    let vault_id = offer.vault_id.to_string();
    let ceremony = move |dev: &mut dyn Ctap, pin: Option<&str>| {
        if pin.is_none() && ctap2::get_info(dev)?.pin_set {
            return Err(CtapError::PinRequired);
        }
        let found = ctap2::unlock_candidates(dev, &ids, &vault_id, pin, true)?;
        let id = hex::encode(&found.credential_id);
        let hit = envelopes.get(&id).and_then(|wrapped| {
            found.wrap_keys.iter().find_map(|(_, key)| {
                silentsilo_vault::unwrap_dek_hex(wrapped, key)
                    .ok()
                    .map(|_| (id.clone(), key.clone(), found.verified))
            })
        });
        Ok(hit.ok_or(NOT_OPENED))
    };
    let (found, _) = with_pin(&app, None, ceremony).await?;
    let (credential_id, wrap_key, verified) = found.map_err(str::to_string)?;
    let join = flows::key_join_open(&*store, &offer, &credential_id, &wrap_key).await?;
    let meta =
        crate::commands::finish_join(&app, &state, &store_config, &*store, join, &name).await?;
    remember_pin_key(&credential_id, verified);
    Ok(meta)
}
