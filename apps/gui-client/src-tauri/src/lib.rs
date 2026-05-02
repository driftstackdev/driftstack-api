//! Driftstack GUI — Tauri backend library.
//!
//! GUI1 lands the scaffold + window shell only. Subsequent phases
//! (GUI2 → GUI8) will add:
//!   * IPC commands the React frontend invokes (`#[tauri::command]`),
//!   * Local SQLite for session history + proxy presets,
//!   * SOCKS5 proxy testing + per-session config,
//!   * Driver-bridge to the modified WebKit fork process,
//!   * Live viewport (polling screenshots → WebRTC if scope allows).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Health probe — the React shell calls this to confirm the Rust
/// backend is alive. Removed in favour of real commands once GUI2
/// adds the API integration.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}
