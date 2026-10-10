//! An entry's earlier versions, for the writers that change an entry without
//! the window: autofill saving a new password. The same rules as
//! `src/shared/entryHistory.ts`, which every edit in the app goes through;
//! keep the two in step.

// Only autofill writes through here, and autofill is Android's alone.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::path::Path;

use serde_json::{Map, Value};
use tauri::AppHandle;

/// Most a history may take, as JSON. Core refuses an entry over 512 KB.
const HISTORY_BYTES: usize = 256 * 1024;

/// Kept on the entry rather than in a version.
const NOT_VERSIONED: [&str; 10] = [
    "id",
    "history",
    "saved_at",
    "attachments",
    "passkey",
    "favorite",
    "category",
    "created_at",
    "updated_at",
    "require_reauth",
];

const DEFAULT_COUNT: usize = 10;
const CHOICES: [&str; 3] = ["10", "30", "fit"];
const FILE: &str = "password-history";

/// How many versions to keep: a number, or as many as fit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Count(usize),
    Fit,
}

pub fn policy(data_dir: &Path) -> Policy {
    match std::fs::read_to_string(data_dir.join(FILE))
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("fit") => Policy::Fit,
        Some(n) => n
            .parse()
            .map(Policy::Count)
            .unwrap_or(Policy::Count(DEFAULT_COUNT)),
        None => Policy::Count(DEFAULT_COUNT),
    }
}

fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

/// Adds `entry` as it is now to the front of its own history, before a
/// writer changes it, and trims the history to `policy` and the budget.
pub fn keep_version(entry: &mut Value, policy: Policy) {
    let Some(fields) = entry.as_object() else {
        return;
    };
    let mut version: Map<String, Value> = fields
        .iter()
        .filter(|(key, value)| !NOT_VERSIONED.contains(&key.as_str()) && !is_empty(value))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    version.insert(
        "saved_at".into(),
        fields.get("updated_at").cloned().unwrap_or(Value::from(0)),
    );
    let mut history: Vec<Value> = fields
        .get("history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    history.insert(0, Value::Object(version));
    if let Policy::Count(n) = policy {
        history.truncate(n);
    }
    while !history.is_empty()
        && serde_json::to_string(&history).map_or(0, |s| s.len()) > HISTORY_BYTES
    {
        history.pop();
    }
    entry["history"] = Value::Array(history);
}

#[tauri::command(async)]
pub fn history_policy_get(_app: AppHandle) -> String {
    match crate::background::data_dir().map(|d| policy(d)) {
        Some(Policy::Fit) => "fit".into(),
        Some(Policy::Count(n)) => n.to_string(),
        None => DEFAULT_COUNT.to_string(),
    }
}

#[tauri::command(async)]
pub fn history_policy_set(_app: AppHandle, policy: String) -> Result<(), String> {
    if !CHOICES.contains(&policy.as_str()) {
        return Err("That is not one of the choices.".into());
    }
    let dir = crate::background::data_dir().ok_or("No place to save the setting.")?;
    std::fs::write(dir.join(FILE), policy).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(password: &str, updated_at: i64) -> Value {
        json!({
            "id": "e1", "service": "Bank", "username": "ana", "password": password,
            "url": "https://bank.example", "notes": "", "category": "Money",
            "created_at": 1, "updated_at": updated_at, "favorite": true,
            "attachments": [{ "blob_id": "b" }], "unknown_from_later": "kept"
        })
    }

    #[test]
    fn the_version_holds_what_the_entry_said_and_not_where_it_was_filed() {
        let mut e = entry("first", 1000);
        keep_version(&mut e, Policy::Count(10));
        let version = &e["history"][0];
        assert_eq!(version["password"], "first");
        assert_eq!(version["saved_at"], 1000);
        assert_eq!(version["unknown_from_later"], "kept");
        for key in [
            "id",
            "category",
            "favorite",
            "attachments",
            "notes",
            "updated_at",
        ] {
            assert!(version.get(key).is_none(), "{key} is not in a version");
        }
    }

    #[test]
    fn newest_first_and_cut_to_the_count() {
        let mut e = entry("p0", 0);
        for i in 1..=12 {
            keep_version(&mut e, Policy::Count(10));
            e["password"] = format!("p{i}").into();
            e["updated_at"] = i.into();
        }
        let history = e["history"].as_array().unwrap();
        assert_eq!(history.len(), 10);
        assert_eq!(history[0]["password"], "p11");
        assert_eq!(history[9]["password"], "p2");
    }

    #[test]
    fn as_many_as_fit_stays_under_the_budget() {
        let mut e = entry("p", 0);
        e["notes"] = "n".repeat(10_000).into();
        for _ in 0..60 {
            keep_version(&mut e, Policy::Fit);
        }
        let size = serde_json::to_string(&e["history"]).unwrap().len();
        assert!(size <= HISTORY_BYTES);
        assert!(e["history"].as_array().unwrap().len() > 10);
    }

    #[test]
    fn the_setting_reads_back_and_defaults_to_ten() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(policy(dir.path()), Policy::Count(10));
        std::fs::write(dir.path().join(FILE), "fit").unwrap();
        assert_eq!(policy(dir.path()), Policy::Fit);
        std::fs::write(dir.path().join(FILE), "30").unwrap();
        assert_eq!(policy(dir.path()), Policy::Count(30));
    }
}
