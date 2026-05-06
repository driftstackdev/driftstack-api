//! Driftstack GUI — Tauri backend library.
//!
//! Cross-platform (Windows / macOS / Linux). Currently exposes:
//!   * `ping` — health probe.
//!   * `secret_save` / `secret_load` / `secret_delete` (V-241 T3 #1) —
//!     cross-platform OS-keychain access for the API key. Transparently
//!     uses macOS Keychain, Windows Credential Manager, or
//!     Linux Secret Service / KWallet via the `keyring` crate.
//!
//! Future phases will add:
//!   * Local SQLite for session history + proxy presets,
//!   * SOCKS5 proxy testing + per-session config,
//!   * Driver-bridge to the modified WebKit fork process,
//!   * Live viewport (polling screenshots → WebRTC if scope allows).

use keyring::Entry;

/// Service identifier surfaced in OS-native keychain UI. Matches the
/// Tauri bundle identifier so the stored secrets show under the app's
/// identity (e.g. macOS Keychain shows "dev.driftstack.gui").
const KEYRING_SERVICE: &str = "dev.driftstack.gui";

/// Stable username used for the per-user-account secret. The current
/// design is single-account (one keyring entry per device); when
/// multi-account support lands, this becomes a per-account-id key.
const KEYRING_USER: &str = "default";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        // V-243 / D-2026-05-06-03 — auto-update via Tauri Updater.
        // Configuration (endpoint + pubkey) lives in tauri.conf.json
        // under `plugins.updater`; the customer's GUI checks the
        // endpoint on startup + offers a signed update download.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            ping,
            secret_save,
            secret_load,
            secret_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Health probe — the React shell calls this to confirm the Rust
/// backend is alive.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Save a secret (typically the API key) to the OS keychain under the
/// given key name. Returns `Ok(())` on success, `Err(message)` on
/// failure. Errors include OS-keychain access denial (user dismissed
/// the prompt on macOS, or LinuxSecret-Service is locked).
///
/// `key` is a logical name like `"api_key"`. Multiple keys can coexist
/// under the same service identifier; each gets a separate keychain
/// entry. The username slot is fixed (`KEYRING_USER`) to keep the
/// implementation simple; multi-account support adds per-account-id
/// usernames in a future revision.
#[tauri::command]
fn secret_save(key: String, value: String) -> Result<(), String> {
    let user = format!("{KEYRING_USER}:{key}");
    let entry = Entry::new(KEYRING_SERVICE, &user).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())?;
    Ok(())
}

/// Load a secret by key name. Returns `Ok(Some(value))` when present,
/// `Ok(None)` when not yet set, `Err(message)` on access failure.
///
/// `Ok(None)` is the expected first-run state — the wizard sets the
/// API key at signup, so until that lands the entry doesn't exist.
#[tauri::command]
fn secret_load(key: String) -> Result<Option<String>, String> {
    let user = format!("{KEYRING_USER}:{key}");
    let entry = Entry::new(KEYRING_SERVICE, &user).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret by key name. Returns `Ok(())` whether the entry
/// existed or not (idempotent — Settings logout flow shouldn't fail
/// if the entry was already removed).
#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    let user = format!("{KEYRING_USER}:{key}");
    let entry = match Entry::new(KEYRING_SERVICE, &user) {
        Ok(e) => e,
        Err(e) => return Err(e.to_string()),
    };
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    // Note on test strategy: keyring-rs hits real OS keychains, which
    // are stateful + sandboxed differently per CI environment. The
    // mock-keyring feature is the standard test seam upstream uses;
    // we lean on integration testing via `tauri:dev` for the real
    // path. The unit tests here are scoped to the namespace logic
    // (key formatting + service constant) which IS testable purely.

    use super::*;

    #[test]
    fn keyring_user_prefix_is_stable() {
        // Sanity: changing the username format would orphan all stored
        // secrets across customer upgrades. Lock the format.
        let key = "api_key";
        let user = format!("{KEYRING_USER}:{key}");
        assert_eq!(user, "default:api_key");
    }

    #[test]
    fn keyring_service_matches_tauri_bundle_id() {
        // If KEYRING_SERVICE drifts from tauri.conf.json's identifier,
        // OS-native keychain UI would show the wrong app name.
        // Visual verification of this happens via `tauri:dev` on each
        // platform; this test catches the constant-drift case.
        assert_eq!(KEYRING_SERVICE, "dev.driftstack.gui");
    }
}
