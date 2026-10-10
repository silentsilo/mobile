//! iPhone and iPad: the security key held to the phone, through the C entry
//! points `gen/apple/Sources/silentsilo-mobile/SecurityKeys.swift` exports.
//! Each call blocks while the system sheet or alert is up, so it is made from
//! a worker thread, never from the async runtime or the main thread.

use std::ffi::{CStr, CString, c_char};

use silentsilo_fido::ctap2::CtapError;
use zeroize::Zeroizing;

unsafe extern "C" {
    fn ss_nfc_available() -> bool;
    fn ss_nfc_wait_for_key(prompt: *const c_char, error: *mut c_char, capacity: usize) -> bool;
    fn ss_nfc_transceive(apdu: *const u8, length: usize, out: *mut u8, capacity: usize) -> isize;
    fn ss_nfc_release(error: *const c_char);
    fn ss_nfc_cancel();
    fn ss_ask_pin(
        note: *const c_char,
        offer_no_pin: bool,
        pin: *mut c_char,
        capacity: usize,
    ) -> i32;
}

/// Whether this iPhone has an NFC reader apps may use.
pub fn nfc_available() -> bool {
    // SAFETY: no arguments; CoreNFC answers from any thread.
    unsafe { ss_nfc_available() }
}

/// Opens the NFC sheet and waits for a key. The error is "Cancelled" when the
/// person dismissed the sheet.
pub fn wait_for_key(prompt: &str) -> Result<(), String> {
    let prompt = CString::new(prompt).unwrap_or_default();
    let mut error = [0 as c_char; 256];
    // SAFETY: `prompt` is NUL-terminated and outlives the call; `error` has
    // the capacity passed, and the callee writes a NUL-terminated string.
    let found = unsafe { ss_nfc_wait_for_key(prompt.as_ptr(), error.as_mut_ptr(), error.len()) };
    if found {
        Ok(())
    } else {
        // SAFETY: written NUL-terminated within `error` by the callee.
        Err(unsafe { CStr::from_ptr(error.as_ptr()) }
            .to_string_lossy()
            .into_owned())
    }
}

/// Closes the sheet, saying `error` on it when something failed.
pub fn release(error: Option<&str>) {
    let error = error.map(|e| CString::new(e).unwrap_or_default());
    // SAFETY: a NUL-terminated string that outlives the call, or null.
    unsafe { ss_nfc_release(error.as_ref().map_or(std::ptr::null(), |e| e.as_ptr())) }
}

/// Ends a wait for a key; the waiting call returns "Cancelled".
pub fn cancel() {
    // SAFETY: no arguments.
    unsafe { ss_nfc_cancel() }
}

pub enum Pin {
    Given(Zeroizing<String>),
    NotSet,
    Cancelled,
}

/// The key's PIN, from a system alert.
pub fn ask_pin(note: Option<&str>, offer_no_pin: bool) -> Pin {
    let note = note.map(|n| CString::new(n).unwrap_or_default());
    let mut buffer = Zeroizing::new([0 as c_char; 256]);
    // SAFETY: `note` is NUL-terminated or null; `buffer` has the capacity
    // passed and receives a NUL-terminated string.
    let outcome = unsafe {
        ss_ask_pin(
            note.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()),
            offer_no_pin,
            buffer.as_mut_ptr(),
            buffer.len(),
        )
    };
    match outcome {
        0 => {
            // SAFETY: as above.
            let pin = unsafe { CStr::from_ptr(buffer.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            Pin::Given(Zeroizing::new(pin))
        }
        1 => Pin::NotSet,
        _ => Pin::Cancelled,
    }
}

/// The security key held to the phone, one APDU at a time.
pub struct NfcKey;

impl silentsilo_fido::ctap2::nfc::Apdu for NfcKey {
    fn transmit(&mut self, apdu: &[u8]) -> Result<Vec<u8>, CtapError> {
        // A short APDU's answer is at most 256 bytes and SW1 SW2; an extended
        // one, which this crate does not send, would need more.
        let mut out = vec![0u8; 4096];
        // SAFETY: both buffers are live for the call with the lengths passed.
        let n =
            unsafe { ss_nfc_transceive(apdu.as_ptr(), apdu.len(), out.as_mut_ptr(), out.len()) };
        if n < 0 {
            return Err(CtapError::Transport("tag lost".into()));
        }
        out.truncate(n as usize);
        Ok(out)
    }
}

/// Debug builds: stderr into a file in the app's data, which the Mac copies
/// off the phone over the cable. iOS keeps an app's stderr nowhere.
#[cfg(debug_assertions)]
pub fn stderr_to_file(path: &std::path::Path) {
    use std::os::fd::AsRawFd;
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    unsafe extern "C" {
        fn dup2(old: std::ffi::c_int, new: std::ffi::c_int) -> std::ffi::c_int;
    }
    // SAFETY: a plain descriptor call; the file stays open for the process.
    unsafe { dup2(file.as_raw_fd(), 2) };
    std::mem::forget(file);
}

unsafe extern "C" {
    fn ss_pick_files() -> *mut c_char;
    fn ss_take_shared() -> *mut c_char;
    fn ss_take_photo(folder: *const c_char) -> *mut c_char;
    fn ss_open_with(path: *const c_char) -> bool;
    fn ss_open_url(url: *const c_char) -> bool;
    fn ss_sign_in_open(url: *const c_char) -> bool;
    fn ss_sign_in_close();
    fn ss_pdf_pages(path: *const c_char) -> i32;
    fn ss_pdf_page(path: *const c_char, index: i32, width: i32, length: *mut usize) -> *mut u8;
    fn ss_privacy_cover_install();
    fn ss_copy_secret(text: *const c_char);
    fn ss_clear_secret();
    fn ss_haptic(kind: *const c_char);
    fn ss_autofill_enabled() -> bool;
    fn ss_autofill_open_settings() -> bool;
    fn ss_group_dir() -> *mut c_char;
    fn ss_backup_call(command: *const c_char, payload: *const c_char) -> *mut c_char;
    fn ss_sender_sign(
        vault: *const c_char,
        message: *const u8,
        length: usize,
        out: *mut u8,
        capacity: usize,
    ) -> isize;
    fn ss_free(pointer: *mut std::ffi::c_void);
}

/// A string Swift allocated, copied and given back.
fn take_owned(raw: *mut c_char) -> Option<String> {
    if raw.is_null() {
        return None;
    }
    // SAFETY: a NUL-terminated string from `strdup`, freed right after.
    let text = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    // SAFETY: allocated by Swift with malloc, freed once.
    unsafe { ss_free(raw.cast()) };
    Some(text)
}

fn c(text: &str) -> CString {
    CString::new(text).unwrap_or_default()
}

/// The document picker: `{"files": [{uri, name, size, mimeType}]}`, the uri
/// being the path of iOS's copy in this app's temporary folder.
pub fn pick_files() -> serde_json::Value {
    // SAFETY: no arguments; the result is owned by us.
    take_owned(unsafe { ss_pick_files() })
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_else(|| serde_json::json!({ "files": [] }))
}

/// What other apps shared through the share extension since the last call,
/// moved into the app's temporary folder.
pub fn take_shared() -> serde_json::Value {
    // SAFETY: no arguments; the result is owned by us.
    take_owned(unsafe { ss_take_shared() })
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_else(|| serde_json::json!({ "files": [] }))
}

/// A photo from the camera, written into `folder`.
pub fn take_photo(folder: &std::path::Path) -> Option<String> {
    let folder = c(&folder.to_string_lossy());
    // SAFETY: a NUL-terminated string that outlives the call.
    take_owned(unsafe { ss_take_photo(folder.as_ptr()) })
}

/// The share sheet for a file, to open it in another app.
pub fn open_with(path: &std::path::Path) -> bool {
    let path = c(&path.to_string_lossy());
    // SAFETY: as above.
    unsafe { ss_open_with(path.as_ptr()) }
}

/// A link in Safari.
pub fn open_url(url: &str) -> bool {
    let url = c(url);
    // SAFETY: as above.
    unsafe { ss_open_url(url.as_ptr()) }
}

/// The provider's sign-in page, in a sheet that keeps the app running.
pub fn sign_in_open(url: &str) -> bool {
    let url = c(url);
    // SAFETY: as above.
    unsafe { ss_sign_in_open(url.as_ptr()) }
}

/// Closes the sign-in sheet, done or abandoned.
pub fn sign_in_close() {
    // SAFETY: no arguments.
    unsafe { ss_sign_in_close() }
}

pub fn pdf_pages(path: &str) -> Option<u32> {
    let path = c(path);
    // SAFETY: as above.
    u32::try_from(unsafe { ss_pdf_pages(path.as_ptr()) }).ok()
}

/// Page `index` as a PNG `width` pixels wide.
pub fn pdf_page(path: &str, index: u32, width: u32) -> Option<Vec<u8>> {
    let path = c(path);
    let mut length = 0usize;
    // SAFETY: `path` outlives the call; `length` is a valid out-pointer.
    let raw = unsafe {
        ss_pdf_page(
            path.as_ptr(),
            i32::try_from(index).ok()?,
            i32::try_from(width).ok()?,
            &mut length,
        )
    };
    if raw.is_null() {
        return None;
    }
    // SAFETY: `length` bytes Swift allocated; copied, then freed once.
    let png = unsafe { std::slice::from_raw_parts(raw, length) }.to_vec();
    unsafe { ss_free(raw.cast()) };
    Some(png)
}

/// Covers the window while the app is in the background, so the app
/// switcher's snapshot shows nothing of the silo.
pub fn install_privacy_cover() {
    // SAFETY: no arguments; the Swift side moves to the main thread.
    unsafe { ss_privacy_cover_install() }
}

/// One of `Backup.swift`'s calls: the answer's JSON, or its error.
pub fn backup_call(
    command: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let command = c(command);
    let payload = c(&payload.to_string());
    // SAFETY: NUL-terminated strings that outlive the call; the result is ours.
    let answer = take_owned(unsafe { ss_backup_call(command.as_ptr(), payload.as_ptr()) })
        .ok_or("The phone did not answer.")?;
    let value: serde_json::Value = serde_json::from_str(&answer).map_err(|e| e.to_string())?;
    match value.get("error").and_then(|e| e.as_str()) {
        Some(error) => Err(error.to_string()),
        None => Ok(value),
    }
}

/// A DER signature by this iPhone's sender key for `vault`.
pub fn sender_sign(vault: &str, message: &[u8]) -> Option<Vec<u8>> {
    let vault = c(vault);
    let mut out = [0u8; 128];
    // SAFETY: the message and the buffer with their lengths; Swift writes at
    // most `capacity` bytes.
    let written = unsafe {
        ss_sender_sign(
            vault.as_ptr(),
            message.as_ptr(),
            message.len(),
            out.as_mut_ptr(),
            out.len(),
        )
    };
    (written > 0).then(|| out[..written as usize].to_vec())
}

/// The app group's `Data` folder, made on first use; `None` when the build
/// has no app group.
pub fn group_data_dir() -> Option<std::path::PathBuf> {
    static DIR: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        // SAFETY: no arguments; the result is owned by us.
        let dir = std::path::PathBuf::from(take_owned(unsafe { ss_group_dir() })?);
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    })
    .clone()
}

/// A secret on the clipboard, this iPhone only, for 45 seconds.
pub fn copy_secret(text: &str) {
    // A NUL-terminated copy that is wiped after the call.
    let mut bytes = Zeroizing::new(Vec::with_capacity(text.len() + 1));
    bytes.extend(text.bytes().filter(|&b| b != 0));
    bytes.push(0);
    // SAFETY: a NUL-terminated buffer that outlives the call.
    unsafe { ss_copy_secret(bytes.as_ptr().cast()) }
}

/// Takes the copied secret back, unless something else was copied since.
pub fn clear_secret() {
    // SAFETY: no arguments.
    unsafe { ss_clear_secret() }
}

pub fn haptic(kind: &str) {
    let kind = c(kind);
    // SAFETY: a NUL-terminated string that outlives the call.
    unsafe { ss_haptic(kind.as_ptr()) }
}

/// Whether SilentSilo is on as an AutoFill provider in iOS's settings.
pub fn autofill_enabled() -> bool {
    // SAFETY: no arguments.
    unsafe { ss_autofill_enabled() }
}

/// Opens iOS's page for turning SilentSilo on as an AutoFill provider.
pub fn autofill_open_settings() -> bool {
    // SAFETY: no arguments.
    unsafe { ss_autofill_open_settings() }
}
