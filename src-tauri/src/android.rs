//! What Rust calls in Kotlin, and what Kotlin calls in Rust, without going
//! through the app's window: the Keystore protector for local secrets, the
//! sender's signing key, and the backup job's entry point. The Kotlin side
//! is `Native.kt`, `LocalSecrets.kt` and `SenderKeys.kt`.

use std::path::PathBuf;
use std::sync::OnceLock;

use jni::objects::{GlobalRef, JByteArray, JClass, JObject, JString, JValue};
use jni::sys::{jint, jlong, jstring};
use jni::{JNIEnv, JavaVM};

struct Bridge {
    vm: JavaVM,
    secrets: GlobalRef,
    senders: GlobalRef,
    pdf: GlobalRef,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

/// `Native.init`, from the first activity or job: classes are looked up
/// here, on a thread that can see the app's classes.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_init(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
) {
    let Ok(data_dir) = env.get_string(&data_dir).map(String::from) else {
        return;
    };
    silentsilo_vault::set_work_base(PathBuf::from(&data_dir).join("work"));
    let bridge = (|| {
        let secrets = env.find_class("com/silentsilo/mobile/LocalSecrets").ok()?;
        let senders = env.find_class("com/silentsilo/mobile/SenderKeys").ok()?;
        let pdf = env.find_class("com/silentsilo/mobile/PdfPages").ok()?;
        Some(Bridge {
            vm: env.get_java_vm().ok()?,
            secrets: env.new_global_ref(secrets).ok()?,
            senders: env.new_global_ref(senders).ok()?,
            pdf: env.new_global_ref(pdf).ok()?,
        })
    })();
    let _ = env.exception_clear();
    if let Some(bridge) = bridge
        && BRIDGE.set(bridge).is_ok()
    {
        silentsilo_vault::set_local_protector(Box::new(KeystoreProtector));
    }
}

/// Rewrites the secret files a build before the protector left in the clear.
/// Each one is read back after the rewrite; one that does not read back the
/// same gets its original bytes again, so nothing is lost to a Keystore
/// that misbehaves.
pub fn seal_existing_secrets(app_data: &std::path::Path) {
    if BRIDGE.get().is_none() {
        return;
    }
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

struct KeystoreProtector;

impl silentsilo_vault::LocalProtector for KeystoreProtector {
    fn protect(&self, data: &[u8]) -> Option<Vec<u8>> {
        call_bytes(|b| &b.secrets, "protect", "([B)[B", None, data)
    }
    fn unprotect(&self, data: &[u8]) -> Option<Vec<u8>> {
        call_bytes(|b| &b.secrets, "unprotect", "([B)[B", None, data)
    }
}

/// A DER signature by this phone's sender key for `vault_id`.
pub fn sign(vault_id: &str, message: &[u8]) -> Option<Vec<u8>> {
    call_bytes(
        |b| &b.senders,
        "sign",
        "(Ljava/lang/String;[B)[B",
        Some(vault_id),
        message,
    )
}

/// Calls a static `byte[]` method taking an optional string and a `byte[]`.
fn call_bytes(
    class: fn(&Bridge) -> &GlobalRef,
    method: &str,
    signature: &str,
    text: Option<&str>,
    data: &[u8],
) -> Option<Vec<u8>> {
    let bridge = BRIDGE.get()?;
    let mut env = bridge.vm.attach_current_thread().ok()?;
    let result = (|| {
        let array = env.byte_array_from_slice(data).ok()?;
        let class: &JClass = class(bridge).as_obj().into();
        let returned = match text {
            Some(text) => {
                let text = env.new_string(text).ok()?;
                env.call_static_method(
                    class,
                    method,
                    signature,
                    &[JValue::Object(&text), JValue::Object(&array)],
                )
            }
            None => env.call_static_method(class, method, signature, &[JValue::Object(&array)]),
        }
        .ok()?
        .l()
        .ok()?;
        if returned.is_null() {
            return None;
        }
        env.convert_byte_array(JByteArray::from(returned)).ok()
    })();
    let _ = env.exception_clear();
    result
}

/// `Native.sendItem`, from the backup job.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_sendItem(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    fd: jint,
    item_id: JString,
    name: JString,
    mime_type: JString,
    taken_at: jlong,
    folder: JString,
    kind: JString,
) -> jstring {
    let mut text =
        |value: &JString| -> String { env.get_string(value).map(String::from).unwrap_or_default() };
    let item = crate::backup::JobItem {
        data_dir: PathBuf::from(text(&data_dir)),
        // SAFETY: Kotlin keeps the descriptor open until this call returns.
        source: unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) },
        item_id: text(&item_id),
        name: text(&name),
        mime_type: Some(text(&mime_type)).filter(|m| !m.is_empty()),
        taken_at: Some(taken_at).filter(|t| *t > 0),
        folder: text(&folder),
        kind: text(&kind),
    };
    let outcome = crate::backup::send_from_job(item);
    env.new_string(outcome)
        .map(|s| s.into_raw())
        .unwrap_or(JObject::null().into_raw())
}

/// `Native.waitingCount`, from the backup job.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_waitingCount(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
) -> jlong {
    let Ok(data_dir) = env.get_string(&data_dir).map(String::from) else {
        return -1;
    };
    crate::backup::waiting_from_job(std::path::Path::new(&data_dir))
}

/// How many pages the PDF at `path` has.
pub fn pdf_pages(path: &str) -> Option<u32> {
    let bridge = BRIDGE.get()?;
    let mut env = bridge.vm.attach_current_thread().ok()?;
    let result = (|| {
        let path = env.new_string(path).ok()?;
        let class: &JClass = bridge.pdf.as_obj().into();
        let count = env
            .call_static_method(
                class,
                "count",
                "(Ljava/lang/String;)I",
                &[JValue::Object(&path)],
            )
            .ok()?
            .i()
            .ok()?;
        u32::try_from(count).ok()
    })();
    let _ = env.exception_clear();
    result
}

/// Page `index` of the PDF at `path`, as a PNG `width` pixels wide.
pub fn pdf_page(path: &str, index: u32, width: u32) -> Option<Vec<u8>> {
    let bridge = BRIDGE.get()?;
    let mut env = bridge.vm.attach_current_thread().ok()?;
    let result = (|| {
        let path = env.new_string(path).ok()?;
        let class: &JClass = bridge.pdf.as_obj().into();
        let png = env
            .call_static_method(
                class,
                "render",
                "(Ljava/lang/String;II)[B",
                &[
                    JValue::Object(&path),
                    JValue::Int(index as i32),
                    JValue::Int(width as i32),
                ],
            )
            .ok()?
            .l()
            .ok()?;
        if png.is_null() {
            return None;
        }
        env.convert_byte_array(JByteArray::from(png)).ok()
    })();
    let _ = env.exception_clear();
    result
}

/// `Native.lockAll`, from the Quick Settings tile.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_lockAll(_env: JNIEnv, _class: JClass) {
    crate::background::lock_from_outside();
}

/// `Native.anyOpen`, for the tile's state.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_anyOpen(
    _env: JNIEnv,
    _class: JClass,
) -> jni::sys::jboolean {
    crate::background::any_open().into()
}

/// `Native.screenOff`, from the activity's receiver.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_screenOff(_env: JNIEnv, _class: JClass) {
    crate::background::screen_off();
}

/// `Native.recordSent`, after the job sent an item.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_recordSent(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    item_id: JString,
    kind: JString,
    reference: JString,
) {
    let mut text =
        |value: &JString| -> String { env.get_string(value).map(String::from).unwrap_or_default() };
    let (data_dir, item_id, kind, reference) = (
        text(&data_dir),
        text(&item_id),
        text(&kind),
        text(&reference),
    );
    if let Ok(item_id) = uuid::Uuid::parse_str(&item_id) {
        crate::backup::record_sent(std::path::Path::new(&data_dir), item_id, &kind, &reference);
    }
}

/// `Native.resends`: `[{kind, reference}]` the job should send again.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_resends(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
) -> jstring {
    let data_dir = env
        .get_string(&data_dir)
        .map(String::from)
        .unwrap_or_default();
    let json = crate::backup::resends(std::path::Path::new(&data_dir));
    env.new_string(json)
        .map(|s| s.into_raw())
        .unwrap_or(JObject::null().into_raw())
}

/// `Native.resolveResend`: sent again, or gone from the phone.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_silentsilo_mobile_Native_resolveResend(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    kind: JString,
    reference: JString,
) {
    let mut text =
        |value: &JString| -> String { env.get_string(value).map(String::from).unwrap_or_default() };
    let (data_dir, kind, reference) = (text(&data_dir), text(&kind), text(&reference));
    crate::backup::resolve_resend(std::path::Path::new(&data_dir), &kind, &reference);
}
