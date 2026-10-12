//! What the page gets of a password entry. An entry marked to ask before its
//! secrets show (`require_reauth`) comes with them emptied, and the names of
//! what was emptied in `secrets_withheld`; `vault_reveal_password` gives it
//! whole after the fingerprint. A passkey's private key never goes to the
//! page: nothing there uses it.

use serde_json::{Map, Value};

/// The marker on an entry whose secrets were held back.
pub const MARKER: &str = "secrets_withheld";

/// Text fields that are secrets of a protected entry, as on desktop.
const SECRET_TEXT: [&str; 6] = [
    "password",
    "notes",
    "card_number",
    "card_code",
    "ssh_private_key",
    "totp_secret",
];

/// What the page may change on an entry it holds without its secrets:
/// starring it and filing it elsewhere.
const ARRANGED: [&str; 3] = ["favorite", "category", "updated_at"];

pub fn is_protected(entry: &Value) -> bool {
    entry.get("require_reauth").and_then(Value::as_bool) == Some(true)
}

pub fn id_of(entry: &Value) -> Option<uuid::Uuid> {
    entry
        .get("id")
        .and_then(Value::as_str)
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
}

/// Empties the secrets of one entry or one of its earlier versions, and
/// returns the names of the text fields it emptied.
fn empty_secrets(object: &mut Map<String, Value>) -> Vec<&'static str> {
    let mut emptied = Vec::new();
    for key in SECRET_TEXT {
        if let Some(value) = object.get_mut(key)
            && value.as_str().is_some_and(|s| !s.is_empty())
        {
            *value = Value::String(String::new());
            emptied.push(key);
        }
    }
    if let Some(Value::Array(fields)) = object.get_mut("fields") {
        for field in fields.iter_mut().filter_map(Value::as_object_mut) {
            if field.get("hidden").and_then(Value::as_bool) == Some(true) {
                field.insert("value".into(), Value::String(String::new()));
            }
        }
    }
    if let Some(Value::Array(attachments)) = object.get_mut("attachments") {
        for attachment in attachments.iter_mut().filter_map(Value::as_object_mut) {
            attachment.insert("blob_key".into(), Value::String(String::new()));
        }
    }
    emptied
}

fn without_passkey_secret(object: &mut Map<String, Value>) {
    if let Some(Value::Object(passkey)) = object.get_mut("passkey") {
        passkey.remove("private_key");
    }
}

/// The entry as the list gives it to the page.
pub fn for_page(raw: &str) -> String {
    let Ok(mut entry) = serde_json::from_str::<Value>(raw) else {
        return raw.to_string();
    };
    let protected = is_protected(&entry);
    let Some(object) = entry.as_object_mut() else {
        return raw.to_string();
    };
    without_passkey_secret(object);
    if protected {
        let emptied = empty_secrets(object);
        if let Some(Value::Array(history)) = object.get_mut("history") {
            for version in history.iter_mut().filter_map(Value::as_object_mut) {
                empty_secrets(version);
            }
        }
        object.insert(MARKER.into(), Value::from(emptied));
    }
    entry.to_string()
}

/// The entry whole, for the page after the fingerprint, still without the
/// passkey's private key.
pub fn revealed(raw: &str) -> String {
    let Ok(mut entry) = serde_json::from_str::<Value>(raw) else {
        return raw.to_string();
    };
    if let Some(object) = entry.as_object_mut() {
        without_passkey_secret(object);
    }
    entry.to_string()
}

/// What to store when the page saves `incoming` over `stored`.
///
/// An entry the page holds without its secrets keeps everything stored and
/// takes only the star and the category from the page. A passkey whose
/// private key the page never had keeps the stored one.
pub fn merge(incoming: &str, stored: Option<&str>) -> Result<String, String> {
    let mut next: Value = serde_json::from_str(incoming)
        .map_err(|e| format!("This entry could not be read ({e})."))?;
    let stored: Option<Value> = stored.and_then(|s| serde_json::from_str(s).ok());
    let withheld = next.get(MARKER).is_some_and(|v| !v.is_null());
    if withheld {
        let Some(mut kept) = stored else {
            return Err(silentsilo_core::coded!(
                "err.entry_protected",
                "This entry is protected. Open it and confirm it is you first."
            )
            .into());
        };
        let (Some(kept_object), Some(next_object)) = (kept.as_object_mut(), next.as_object())
        else {
            return Err("This entry could not be read.".into());
        };
        for key in ARRANGED {
            match next_object.get(key) {
                Some(value) => {
                    kept_object.insert(key.into(), value.clone());
                }
                None => {
                    kept_object.remove(key);
                }
            }
        }
        return Ok(kept.to_string());
    }
    if let (Some(next_passkey), Some(stored_passkey)) = (
        next.get_mut("passkey").and_then(Value::as_object_mut),
        stored.as_ref().and_then(|s| s.get("passkey")),
    ) && next_passkey.get("private_key").is_none()
        && next_passkey.get("credential_id") == stored_passkey.get("credential_id")
        && let Some(secret) = stored_passkey.get("private_key")
    {
        next_passkey.insert("private_key".into(), secret.clone());
    }
    Ok(next.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROTECTED: &str = r#"{"id":"0b6f2c1e-6a3c-4d5e-8f00-000000000001","service":"Bank","username":"me","password":"hunter2","notes":"pin 1234","url":"https://bank.example","category":"General","require_reauth":true,"totp_secret":"JBSWY3DPEHPK3PXP","fields":[{"name":"PIN","value":"9999","hidden":true},{"name":"Branch","value":"North","hidden":false}],"attachments":[{"blob_id":"b","name":"card.pdf","size_bytes":1,"blob_key":"wrapped"}],"history":[{"password":"old","saved_at":1}],"passkey":{"credential_id":"c","rp_id":"bank.example","private_key":"secret"},"future_field":{"kept":true},"created_at":1,"updated_at":2}"#;

    #[test]
    fn a_protected_entry_reaches_the_page_without_its_secrets() {
        let page: Value = serde_json::from_str(&for_page(PROTECTED)).unwrap();
        assert_eq!(page["password"], "");
        assert_eq!(page["notes"], "");
        assert_eq!(page["totp_secret"], "");
        assert_eq!(page["fields"][0]["value"], "");
        assert_eq!(page["fields"][1]["value"], "North");
        assert_eq!(page["attachments"][0]["blob_key"], "");
        assert_eq!(page["history"][0]["password"], "");
        assert!(page["passkey"].get("private_key").is_none());
        assert_eq!(page["username"], "me");
        let withheld: Vec<&str> = page[MARKER]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(withheld, ["password", "notes", "totp_secret"]);
    }

    #[test]
    fn an_ordinary_entry_keeps_its_secrets_but_not_its_passkey_key() {
        let plain = PROTECTED.replace(r#""require_reauth":true"#, r#""require_reauth":false"#);
        let page: Value = serde_json::from_str(&for_page(&plain)).unwrap();
        assert_eq!(page["password"], "hunter2");
        assert!(page.get(MARKER).is_none());
        assert!(page["passkey"].get("private_key").is_none());
    }

    #[test]
    fn starring_a_withheld_entry_keeps_every_stored_secret() {
        let mut page: Value = serde_json::from_str(&for_page(PROTECTED)).unwrap();
        page["favorite"] = Value::Bool(true);
        page["category"] = Value::String("Money".into());
        // Anything else the page sends is not taken.
        page["require_reauth"] = Value::Bool(false);
        page["password"] = Value::String("changed".into());
        let saved: Value =
            serde_json::from_str(&merge(&page.to_string(), Some(PROTECTED)).unwrap()).unwrap();
        assert_eq!(saved["favorite"], true);
        assert_eq!(saved["category"], "Money");
        assert_eq!(saved["password"], "hunter2");
        assert_eq!(saved["require_reauth"], true);
        assert_eq!(saved["attachments"][0]["blob_key"], "wrapped");
        assert_eq!(saved["passkey"]["private_key"], "secret");
        assert_eq!(saved["future_field"]["kept"], true);
        assert!(saved.get(MARKER).is_none());
    }

    #[test]
    fn a_withheld_entry_with_nothing_stored_is_refused() {
        let page = for_page(PROTECTED);
        assert!(merge(&page, None).is_err());
    }

    #[test]
    fn an_edit_keeps_the_passkey_key_the_page_never_had() {
        let page = revealed(PROTECTED).replace("hunter2", "new password");
        let saved: Value = serde_json::from_str(&merge(&page, Some(PROTECTED)).unwrap()).unwrap();
        assert_eq!(saved["password"], "new password");
        assert_eq!(saved["passkey"]["private_key"], "secret");
    }
}
