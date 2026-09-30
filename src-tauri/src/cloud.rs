//! Signing in to OneDrive, Dropbox and Google Drive from the phone.
//!
//! As on desktop: the provider's page opens in the phone's own browser, its
//! answer comes back to 127.0.0.1 in this app, and core keeps the tokens.
//! The screens get the account to show and an id that names the sign-in
//! when the storage is saved with it.

use std::sync::Mutex;

use silentsilo_app::StoreConfigInput;
use silentsilo_vault::{CloudProvider, CloudSignIn};
use tauri::{AppHandle, Manager};

/// Core's `SIGN_IN_TIMEOUT`: past it the sign-in has failed anyway.
const SIGN_IN_SECONDS: u64 = 5 * 60;

/// The sign-in in progress, so Cancel can stop it and free its port.
#[derive(Default)]
pub struct SignInSlot(Mutex<Option<tokio::sync::oneshot::Sender<()>>>);

/// Storage described by a screen, and the store to check it with. A cloud
/// storage being set up opens with the sign-in the app holds: nothing is
/// stored under it until it is saved.
pub(crate) struct Described {
    pub config: silentsilo_store::StoreConfig,
    pub store: Box<dyn silentsilo_store::ObjectStore>,
    sign_in: Option<uuid::Uuid>,
}

pub(crate) fn describe(
    input: StoreConfigInput,
    existing: Option<silentsilo_store::StoreConfig>,
) -> Result<Described, String> {
    let sign_in = input.sign_in();
    let config = input.into_config(existing)?;
    let store = match sign_in {
        Some(id) => silentsilo_vault::open_with_sign_in(id, &config),
        None => config.open(),
    }
    .map_err(|e| e.to_string())?;
    Ok(Described {
        config,
        store,
        sign_in,
    })
}

impl Described {
    /// Once the storage is saved: its sign-in is stored under it.
    pub(crate) async fn adopt(&self) -> Result<(), String> {
        match self.sign_in {
            Some(id) => silentsilo_vault::adopt_cloud_sign_in(id, &self.config)
                .await
                .map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }
}

/// The providers this build can sign in to, as storage kinds.
#[tauri::command]
pub fn cloud_providers() -> Vec<&'static str> {
    [
        CloudProvider::OneDrive,
        CloudProvider::Dropbox,
        CloudProvider::GoogleDrive,
    ]
    .into_iter()
    .filter(|p| p.available())
    .map(|p| p.kind())
    .collect()
}

/// Opens the provider's sign-in page and waits for it to come back, for at
/// most five minutes.
#[tauri::command]
pub async fn cloud_sign_in(app: AppHandle, kind: String) -> Result<CloudSignIn, String> {
    let provider = CloudProvider::from_kind(&kind)
        .ok_or_else(|| format!("Not a provider this app knows: {kind}"))?;
    let (stop, stopped) = tokio::sync::oneshot::channel();
    {
        let slot = app.state::<SignInSlot>();
        let mut current = slot.0.lock().map_err(|e| e.to_string())?;
        if let Some(previous) = current.replace(stop) {
            let _ = previous.send(());
        }
    }
    // The browser covers the app: an open silo waits for it as long as the
    // sign-in itself may take (five minutes in core), not the usual seconds.
    let lock = app.state::<crate::background::BackgroundLock>();
    let _prompt = lock.prompt_for(SIGN_IN_SECONDS);
    let opener = app.clone();
    let signing_in = silentsilo_vault::cloud_sign_in(provider, move |url| {
        opener
            .state::<crate::incoming::Files<tauri::Wry>>()
            .open_browser(url)
    });
    // Dropping the sign-in closes its listener.
    tokio::select! {
        result = signing_in => result.map_err(|e| e.to_string()),
        _ = stopped => Err("The sign-in was stopped.".into()),
    }
}

#[tauri::command]
pub fn cloud_cancel_sign_in(slot: tauri::State<'_, SignInSlot>) -> Result<(), String> {
    if let Some(stop) = slot.0.lock().map_err(|e| e.to_string())?.take() {
        let _ = stop.send(());
    }
    Ok(())
}

/// The silo folders a sign-in can see, for joining a silo.
#[tauri::command]
pub async fn cloud_list_silos(sign_in: String) -> Result<Vec<String>, String> {
    let id = uuid::Uuid::parse_str(sign_in.trim()).map_err(|_| "Sign in again.".to_string())?;
    silentsilo_vault::cloud_silo_folders(id)
        .await
        .map_err(|e| e.to_string())
}
