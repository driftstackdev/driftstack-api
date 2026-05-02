// Tauri main entry. Keep this file thin — the bulk of the Rust
// backend lives in lib.rs so it can be built as a library for tests
// + bound from the iOS / Android targets if those are ever added.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    driftstack_gui_lib::run()
}
