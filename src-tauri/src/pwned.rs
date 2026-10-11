//! The breach check: a password's hash prefix to Have I Been Pwned's range
//! API, the rest compared on the phone. Copied from desktop's pwned.rs.

use std::sync::OnceLock;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let built = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| built))
}

/// Five hexadecimal characters, nothing else: the most this sends.
fn is_prefix(prefix: &str) -> bool {
    prefix.len() == 5 && prefix.bytes().all(|b| b.is_ascii_hexdigit())
}

#[tauri::command]
pub async fn pwned_range(prefix: String) -> Result<String, String> {
    if !is_prefix(&prefix) {
        return Err("That is not a password hash prefix.".into());
    }
    let response = client()?
        .get(format!("https://api.pwnedpasswords.com/range/{prefix}"))
        // Padding makes every bucket the same shape, so the response size
        // reveals nothing about which prefix was asked about.
        .header("Add-Padding", "true")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "The breach service answered {}.",
            response.status()
        ));
    }
    response.text().await.map_err(|e| e.to_string())
}
