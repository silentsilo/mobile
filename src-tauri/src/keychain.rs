//! iOS: the local secret files sealed with AES-256-GCM under a key kept in
//! the Keychain, readable only on this iPhone after its first unlock. It
//! plays the part the Keystore key plays on Android: the files in the app's
//! data are useless without this device.

use std::sync::OnceLock;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::passwords::{
    PasswordOptions, generic_password, set_generic_password_options,
};
use zeroize::Zeroizing;

const SERVICE: &str = "com.silentsilo.mobile.local";
const ACCOUNT: &str = "local-secrets";
const NONCE_LEN: usize = 12;
/// `errSecItemNotFound`: the only answer that means there is no key yet.
const NOT_FOUND: i32 = -25300;

static KEY: OnceLock<Zeroizing<[u8; 32]>> = OnceLock::new();

/// Installs the protector once the key can be read or made. False leaves the
/// files as they are, in the clear, as on a build without one.
pub fn install_protector() -> bool {
    let Some(key) = load_or_create() else {
        return false;
    };
    let _ = KEY.set(key);
    silentsilo_vault::set_local_protector(Box::new(KeychainProtector))
}

fn load_or_create() -> Option<Zeroizing<[u8; 32]>> {
    match read() {
        Ok(key) => return Some(key),
        // Any other failure keeps the old key unreachable for now rather
        // than replacing it: a new key would orphan every sealed file.
        Err(code) if code != NOT_FOUND => return None,
        Err(_) => {}
    }
    let mut key = Zeroizing::new([0u8; 32]);
    rand::rng().fill_bytes(key.as_mut());
    let mut options = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
    let access = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
        0,
    )
    .ok()?;
    options.set_access_control(access);
    set_generic_password_options(key.as_ref(), options).ok()?;
    // Used only once it reads back the same.
    read().ok().filter(|stored| stored[..] == key[..])
}

fn read() -> Result<Zeroizing<[u8; 32]>, i32> {
    let bytes = Zeroizing::new(
        generic_password(PasswordOptions::new_generic_password(SERVICE, ACCOUNT))
            .map_err(|e| e.code())?,
    );
    let mut key = Zeroizing::new([0u8; 32]);
    if bytes.len() != key.len() {
        return Err(0);
    }
    key.copy_from_slice(&bytes);
    Ok(key)
}

struct KeychainProtector;

impl silentsilo_vault::LocalProtector for KeychainProtector {
    fn protect(&self, data: &[u8]) -> Option<Vec<u8>> {
        let cipher = Aes256Gcm::new_from_slice(KEY.get()?.as_ref()).ok()?;
        let mut nonce = [0u8; NONCE_LEN];
        rand::rng().fill_bytes(&mut nonce);
        let sealed = cipher.encrypt(Nonce::from_slice(&nonce), data).ok()?;
        Some([&nonce[..], &sealed].concat())
    }

    fn unprotect(&self, data: &[u8]) -> Option<Vec<u8>> {
        if data.len() < NONCE_LEN {
            return None;
        }
        let (nonce, sealed) = data.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new_from_slice(KEY.get()?.as_ref()).ok()?;
        cipher.decrypt(Nonce::from_slice(nonce), sealed).ok()
    }
}
