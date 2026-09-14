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
        Some(Bridge {
            vm: env.get_java_vm().ok()?,
            secrets: env.new_global_ref(secrets).ok()?,
            senders: env.new_global_ref(senders).ok()?,
        })
    })();
    let _ = env.exception_clear();
    if let Some(bridge) = bridge
        && BRIDGE.set(bridge).is_ok()
    {
        silentsilo_vault::set_local_protector(Box::new(KeystoreProtector));
    }
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
        source: PathBuf::from(format!("/proc/self/fd/{fd}")),
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
