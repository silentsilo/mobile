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
    fn ss_take_photo(folder: *const c_char) -> *mut c_char;
    fn ss_open_with(path: *const c_char) -> bool;
    fn ss_open_url(url: *const c_char) -> bool;
    fn ss_sign_in_open(url: *const c_char) -> bool;
    fn ss_sign_in_close();
    fn ss_pdf_pages(path: *const c_char) -> i32;
    fn ss_pdf_page(path: *const c_char, index: i32, width: i32, length: *mut usize) -> *mut u8;
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
