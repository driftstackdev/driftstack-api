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
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

/// Wall-clock ceiling on each blocking socket op in the SOCKS5 probe.
/// Eight seconds is generous for a reachable proxy yet short enough
/// that the GUI's "Test proxy" spinner doesn't feel hung when a host
/// is dead.
const PROXY_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Service identifier surfaced in OS-native keychain UI. Matches the
/// Tauri bundle identifier so the stored secrets show under the app's
/// identity (e.g. macOS Keychain shows "dev.driftstack.gui").
const KEYRING_SERVICE: &str = "dev.driftstack.gui";

/// Stable username used for the per-user-account secret. The current
/// design is single-account (one keyring entry per device); when
/// multi-account support lands, this becomes a per-account-id key.
const KEYRING_USER: &str = "default";

/// #137 — native crash breadcrumb. The founder reported the GUI window "just
/// closing on its own even if the browser remains open." main.tsx already
/// fails-visible on every JS `error` + `unhandledrejection` (with a RootErrorBoundary
/// + a fatal overlay), so a SILENT window vanish is a NATIVE tear-down — a Rust panic
/// (e.g. in a spawned proxy-probe thread or the event loop) or a webview-process
/// crash — not a JS fault. This panic hook persists the panic's location + message to
/// a stable log file BEFORE the process unwinds, turning an un-diagnosable "it just
/// disappeared" into a concrete report the founder can hand back. Best-effort +
/// append-only; the hook never itself panics, and it CHAINS the default hook so the
/// stderr backtrace still prints for a terminal/Console.app launch.
fn install_crash_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // ~/Library/Logs/Driftstack/crash.log on macOS (HOME-relative elsewhere) —
        // a location the founder can `cat` without dev tooling.
        if let Ok(home) = std::env::var("HOME") {
            let dir = std::path::Path::new(&home).join("Library/Logs/Driftstack");
            let _ = std::fs::create_dir_all(&dir);
            let loc = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "<unknown location>".to_string());
            let msg = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<non-string panic payload>".to_string());
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let line = format!("[unix {secs}] PANIC at {loc}: {msg}\n");
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("crash.log"))
            {
                let _ = f.write_all(line.as_bytes());
            }
        }
        // Preserve default behaviour (stderr backtrace) so nothing is lost.
        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // #137 — install the crash breadcrumb before anything else can panic.
    install_crash_logger();
    tauri::Builder::default()
        // Single-instance guard (founder-hit 2026-06-13: two stacked
        // instances wedged into a "not responding" window). MUST be the
        // first plugin registered (tauri requirement). On a second launch,
        // focus + unminimize the existing main window instead of spawning a
        // duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Manager;
            // The relaunch's session payload (b64, ps-safe — carries the LiveKit token)
            // + the plain, non-secret session label (window key).
            let b64 = argv
                .iter()
                .find(|a| a.starts_with("--ds-session="))
                .map(|a| a.trim_start_matches("--ds-session=").to_string())
                .filter(|p| is_valid_b64_payload(p));
            let label = argv
                .iter()
                .find(|a| a.starts_with("--ds-label="))
                .map(|a| a.trim_start_matches("--ds-label=").to_string())
                .filter(|l| is_safe_session_label(l));

            // MULTI-WINDOW simulator (founder 2026-06-23: "can't open multiple iPhones at
            // once, only 1 window opens"). A 2nd launch opens a NEW iPhone window for the
            // new session instead of re-pointing the single window; re-opening a session
            // focuses its existing window. The main GUI (different identifier, never
            // launched with --ds-session) keeps the focus-the-existing-window behaviour.
            if app.config().identifier == "dev.driftstack.simulator" {
                match (b64.as_deref(), label.as_deref()) {
                    (Some(payload), Some(lbl)) => open_or_focus_sim_window(app, lbl, payload),
                    _ => {
                        if let Some(win) = app.webview_windows().values().next() {
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                }
                return;
            }

            // Main GUI: focus the existing window (legacy re-point via event if a
            // payload rode along — preserved for the in-app simulator path).
            if let Some(win) = app.get_webview_window("main") {
                use tauri::Emitter;
                if let Some(payload) = b64.as_deref() {
                    let _ = win.emit("ds-session", payload);
                }
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        // V-243 / D-2026-05-06-03 — auto-update via Tauri Updater.
        // Configuration (endpoint + pubkey) lives in tauri.conf.json
        // under `plugins.updater`; the GUI checks the endpoint on
        // startup (src/lib/updater.ts) + offers a signed update.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // V-243 — process plugin powers relaunch() after an update
        // install (Tauri v2 downloadAndInstall does not auto-restart on
        // macOS/Linux; the in-app flow calls relaunch()).
        .plugin(tauri_plugin_process::init())
        // V-328 — register the `driftstack://` URL scheme so browser
        // redirects from the customer dashboard's auth-callback page
        // hand off to this app immediately. The TypeScript side
        // listens via `@tauri-apps/plugin-deep-link.onOpenUrl`. Per-
        // OS registration (Info.plist on macOS, registry on Windows,
        // .desktop on Linux) is declared in tauri.conf.json. Duplicate
        // launches are collapsed by the single-instance plugin above
        // (which focuses the existing window).
        .plugin(tauri_plugin_deep_link::init())
        // Multi-window simulator (founder 2026-06-23): tracks which session the
        // config-created `main` window holds, so a re-open focuses it vs. duplicating.
        .manage(MainSession(std::sync::Mutex::new(None)))
        // W434 (founder W232 item b) — macOS WKWebView blank-until-redraw on the
        // Overlay-titlebar window: the packaged release `.app` mounts + polls the
        // backend but the webview never composites (blank window) until a redraw
        // event; dev-mode hot-reloads mask it. Force ONE compositing pass at
        // startup by nudging the window size by 1px and immediately back. Benign
        // no-op if the quirk differs; compiled only on macOS. Highest-confidence /
        // lowest-risk fix from docs/internal/2026-06-10-gui-release-paint-bug-diagnosis.md
        // (#2). Needs the release `.app` observed to confirm it composites.
        .setup(|app| {
            use tauri::Manager;
            // Stage 2 (separate Driftstack Simulator app): on FIRST launch the
            // main app passes the live session as `--ds-session=<b64 query string>`;
            // decode it into the window's location.search so the existing
            // SimulatorWindow (which reads window.location.search) connects. b64 is
            // an injection-safe charset inside the JS string literal. No-op for the
            // main GUI (never launched with this arg).
            if let Some(arg) = std::env::args().find(|a| a.starts_with("--ds-session=")) {
                let b64 = arg.trim_start_matches("--ds-session=").to_string();
                // SECURITY (audit wf_aa84c103): validate against the strict base64
                // alphabet BEFORE interpolating into the eval'd JS string literal. A
                // quote/backslash/newline in the arg would otherwise break out of the
                // string and run arbitrary JS in the privileged (csp:null) webview that
                // can invoke secret_load/sim_key_take → keychain API key + control-key
                // exfil. The single-instance relaunch path already guards this (the
                // `is_valid_b64_payload` filter above); setup() MUST too — the base64
                // alphabet contains no JS-breaking chars, so this fully closes the
                // breakout. (is_valid_b64_payload is unit-tested against the exact
                // `'); alert(1) //` payload below.)
                if is_valid_b64_payload(&b64) {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.eval(&format!("window.location.search = atob('{b64}')"));
                    }
                }
            }
            // Multi-window simulator (founder 2026-06-23): record which session `main`
            // holds, so a re-open of that SAME session focuses `main` instead of opening a
            // duplicate window (open_or_focus_sim_window checks this).
            if let Some(arg) = std::env::args().find(|a| a.starts_with("--ds-label=")) {
                let lbl = arg.trim_start_matches("--ds-label=").to_string();
                if is_safe_session_label(&lbl) {
                    if let Ok(mut g) = app.state::<MainSession>().0.lock() {
                        *g = Some(lbl);
                    }
                }
            }
            #[cfg(target_os = "macos")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(size) = win.outer_size() {
                        let _ = win.set_size(tauri::PhysicalSize::new(size.width + 1, size.height));
                        let _ = win.set_size(size);
                    }
                }
            }
            // Separate Driftstack Simulator app ONLY: it is single-window, so quit
            // the process when its window is destroyed. Otherwise macOS keeps the
            // app alive with no window and its Dock icon lingers (apps don't
            // auto-quit on last-window-close). Gated on the simulator bundle id, so
            // the main GUI (a different identifier) is never affected — if the id
            // doesn't match we attach nothing and behaviour is unchanged.
            if app.config().identifier == "dev.driftstack.simulator" {
                if let Some(win) = app.get_webview_window("main") {
                    // Multi-window: quit only when the LAST simulator window closes (not
                    // on `main`'s close), so closing one iPhone doesn't kill the others.
                    attach_quit_when_last_window_closes(app.handle().clone(), &win);
                    // When `main` is closed, drop its session claim so re-opening that
                    // SAME first session opens a fresh window instead of focusing a
                    // window that no longer exists (which silently did nothing).
                    let main_session_handle = app.handle().clone();
                    win.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            if let Ok(mut g) = main_session_handle.state::<MainSession>().0.lock() {
                                *g = None;
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            secret_save,
            secret_load,
            secret_delete,
            proxy_test,
            proxy_exit_probe,
            endpoint_resolve,
            launch_simulator,
            sim_key_write,
            sim_key_take,
            set_dock_tile,
            reset_dock_tile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Cheap sanity check on a `--ds-session=<payload>` value before we hand it to
/// the SPA: non-empty and limited to the standard base64 alphabet (the JS side
/// decodes it with `atob`). This guards the relaunch event from firing with an
/// empty or obviously-garbled payload (which would leave the window on a blank,
/// session-less page). It does NOT fully validate the decoded query string —
/// the SPA re-parses it the same way it parses the initial `location.search`.
fn is_valid_b64_payload(payload: &str) -> bool {
    !payload.is_empty()
        && payload
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

/// A `--ds-label` (session id, e.g. `agt_<uuid>`) is the KEY for a per-session simulator
/// window (`sim-<label>`). Validate it's a safe, bounded, window-label-legal token before
/// we use it in a window label / lookup (multi-window, founder 2026-06-23).
fn is_safe_session_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// The session label held by the simulator app's config-created `main` window (the FIRST
/// session). Lets the single-instance handler FOCUS `main` rather than open a duplicate
/// window when that same session is re-opened (multi-window, founder 2026-06-23).
struct MainSession(std::sync::Mutex<Option<String>>);

/// Multi-window simulator: open a NEW per-session iPhone window for `label`, or focus the
/// existing one (`main` for the first session, else `sim-<label>`). The b64 query (ps-safe
/// over the launch arg) is decoded HERE and baked into the new window's internal URL — which
/// is NOT argv-visible — so the window loads the session directly with no eval-timing race.
/// Window props mirror tauri.simulator.conf.json's `main`; windows cascade so they don't
/// stack exactly. Best-effort: a build failure is logged, never panics. (founder 2026-06-23)
fn open_or_focus_sim_window(app: &tauri::AppHandle, label: &str, b64: &str) {
    use base64::Engine;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    // First session lives in `main` — focus it instead of duplicating.
    let is_main_session = app
        .state::<MainSession>()
        .0
        .lock()
        .map(|g| g.as_deref() == Some(label))
        .unwrap_or(false);
    if is_main_session {
        if let Some(win) = app.get_webview_window("main") {
            // Hand the FRESH payload (a brand-new LiveKit join token) to the
            // already-open window so it swaps the session in place — without
            // this, re-opening a session whose stream/token has expired only
            // focused the dead window (the user's only recovery, "relaunch the
            // profile", silently did nothing). The SimulatorWindow's `ds-session`
            // listener (atob → setQuery) + AgentSessionPanel's connect effect
            // (re-runs on a changed token) handle the in-place reconnect.
            // Emitting an unchanged token is a safe no-op (effect deps don't
            // change). Mirrors the `dev.driftstack.gui` main-window emit above.
            use tauri::Emitter;
            let _ = win.emit("ds-session", b64);
            let _ = win.unminimize();
            let _ = win.set_focus();
            return;
        }
        // `main` claims this session but its window is GONE (the user closed
        // it). Without this fall-through we'd silently return → re-opening the
        // first session did nothing. Clear the stale claim and build a fresh
        // `sim-<label>` window below (the Destroyed handler on `main` normally
        // clears MainSession; this is a belt-and-suspenders guard in case the
        // close raced this re-open).
        if let Ok(mut g) = app.state::<MainSession>().0.lock() {
            *g = None;
        }
    }
    let win_label = format!("sim-{label}");
    if let Some(win) = app.get_webview_window(&win_label) {
        // Same in-place reconnect as the `main`-session branch above: hand the
        // fresh payload to the existing per-session window so an expired-token
        // window can actually recover via "relaunch the profile" instead of
        // only being brought to the front with its stream still dead.
        use tauri::Emitter;
        let _ = win.emit("ds-session", b64);
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    let query = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| "window=simulator".to_string());
    let count = app.webview_windows().len() as f64;
    let off = 30.0 * count;
    match WebviewWindowBuilder::new(
        app,
        &win_label,
        WebviewUrl::App(format!("index.html?{query}").into()),
    )
    .title("Driftstack Simulator")
    .inner_size(330.0, 718.0)
    .min_inner_size(280.0, 560.0)
    .resizable(true)
    .maximizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .position(120.0 + off, 120.0 + off)
    .build()
    {
        Ok(win) => attach_quit_when_last_window_closes(app.clone(), &win),
        Err(e) => eprintln!("[simulator] failed to open session window {win_label}: {e}"),
    }
}

/// Quit the simulator process when the LAST window closes (founder 2026-06-23 multi-window:
/// closing one iPhone must not kill the others, and a borderless macOS app with no windows
/// would otherwise linger with a dead Dock icon). On a window's `Destroyed`, exit only if no
/// OTHER simulator window remains (excludes this one by label, robust to map-update timing).
fn attach_quit_when_last_window_closes(app: tauri::AppHandle, win: &tauri::WebviewWindow) {
    use tauri::Manager;
    let label = win.label().to_string();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let others = app
                .webview_windows()
                .into_keys()
                .filter(|k| *k != label)
                .count();
            if others == 0 {
                app.exit(0);
            }
        }
    });
}

/// Health probe — the React shell calls this to confirm the Rust
/// backend is alive.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Stage 2 — launch the separate "Driftstack Simulator" app (its own Dock icon)
/// and hand off the live session via `--ds-session=<b64 query string>`. macOS
/// only; returns `Err` when the app isn't installed so the caller falls back to
/// the in-process simulator window. The API key is NOT passed here (it would be
/// visible in `ps`) — the sim app reads it from the shared OS keychain
/// (`KEYRING_SERVICE`) with a one-time macOS allow prompt. `payload` is the
/// base64 of the simulator query string (window=simulator&ws=…&token=…).
#[tauri::command]
fn launch_simulator(payload: String, session_label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_path = "/Applications/Driftstack Simulator.app";
        if !std::path::Path::new(app_path).exists() {
            return Err("Driftstack Simulator.app is not installed".to_string());
        }
        // `--ds-label` = the plain (non-secret) session id, the per-session window KEY
        // (multi-window, founder 2026-06-23). The single-instance handler opens/focuses
        // one window per label. `--ds-session` stays the b64 (ps-safe) payload.
        std::process::Command::new("open")
            .args([
                "-n",
                "-a",
                app_path,
                "--args",
                &format!("--ds-session={payload}"),
                &format!("--ds-label={session_label}"),
            ])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (payload, session_label);
        Err("the separate simulator app is macOS-only".to_string())
    }
}

/// Deterministic, collision-free temp path for a session's
/// gui_control_key handoff file. The session id is sanitised to the
/// `[A-Za-z0-9._-]` charset (everything else → `_`) so a hostile id
/// can never escape the temp dir (no `/`, no `..`). Lives in the OS
/// temp dir (shared between the main app and the separate simulator
/// app since neither is sandboxed — see Entitlements.plist: no
/// `com.apple.security.app-sandbox`).
fn sim_key_path(session_id: &str) -> std::path::PathBuf {
    let safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    std::env::temp_dir().join(format!("driftstack-sim-{safe}.key"))
}

/// Write the per-session gui_control_key to a 0600 temp file the
/// separate simulator app reads (then unlinks) on launch. This keeps
/// the key OFF argv (`ps`-visible) and OFF the keychain (the separate
/// app can't read the main app's keychain entry). The key is the
/// per-session, 24h-TTL gui_control_key — NOT the account API key.
///
/// On macOS/Unix the file is created with mode 0600 (owner-only) so
/// another local user can't read it. Best-effort caller: a failure
/// just means the simulator falls back to (failing) keychain reads.
#[tauri::command]
fn sim_key_write(session_id: String, key: String) -> Result<(), String> {
    if session_id.is_empty() {
        return Err("session_id is empty".to_string());
    }
    if key.is_empty() {
        return Err("key is empty".to_string());
    }
    let path = sim_key_path(&session_id);
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        // O_CREAT|O_TRUNC|O_WRONLY with mode 0600. create(true) +
        // truncate(true) overwrites a stale file from a prior launch.
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        f.write_all(key.as_bytes()).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // Non-Unix: best-effort plain write (the separate-app handoff
        // is a macOS feature; this branch keeps the command compiling
        // cross-platform). Windows ACLs already restrict the temp dir
        // to the current user.
        std::fs::write(&path, key.as_bytes()).map_err(|e| e.to_string())
    }
}

/// Read AND delete (unlink) the per-session gui_control_key handoff
/// file the main app wrote. Single-use: the simulator calls this once
/// on launch; the unlink ensures the plaintext doesn't linger on disk.
/// Returns `Ok(None)` when no file exists (in-process window case, or
/// the handoff wasn't used) so the caller falls back to the API key.
#[tauri::command]
fn sim_key_take(session_id: String) -> Result<Option<String>, String> {
    if session_id.is_empty() {
        return Ok(None);
    }
    let path = sim_key_path(&session_id);
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            // Unlink immediately (best-effort — a failed unlink must
            // not lose the key we already read).
            let _ = std::fs::remove_file(&path);
            let trimmed = contents.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Set the running app's macOS Dock ICON to reflect the live session (founder
/// 2026-06-18: "the Dock should be the proxy country's FLAG, with the profile
/// name on it — not a 'US' text badge"). Used by the SEPARATE "Driftstack
/// Simulator" app, whose own Dock icon is the whole point of the standalone
/// build.
///
/// Implementation = a freshly-drawn `NSImage` set via
/// `NSApplication.setApplicationIconImage`. The image is the COUNTRY FLAG —
/// derived by mapping the 2-letter ISO code to its regional-indicator emoji
/// pair (e.g. "US" → 🇺🇸), which macOS renders as the flag artwork — with the
/// PROFILE NAME composited as a caption strip across the bottom. Both founder
/// asks (flag = the icon image; name = readable on the Dock) are satisfied in
/// the one icon, so the Dock-tile text badge is cleared (`badgeLabel = None`).
///
/// `country_code` is normalised to an uppercase 2-letter ASCII code; anything
/// else (Tor 'T1', 'XX', empty/None) means "no flag" → the icon resets to the
/// bundle default. `profile_name` is trimmed; empty/None draws the flag with no
/// caption.
///
/// AppKit is main-thread-only, so the work is hopped onto the main thread via
/// `AppHandle::run_on_main_thread`; `MainThreadMarker::new()` then succeeds
/// (it returns `Some` only on the main thread). Best-effort + macOS-only: a
/// failure is returned as `Err` and the caller (JS) ignores it.
#[tauri::command]
fn set_dock_tile(
    app: tauri::AppHandle,
    country_code: Option<String>,
    profile_name: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Normalise to an uppercase 2-letter ISO code; anything else (Tor 'T1',
        // 'XX', empty) yields no flag rather than painting garbage on the Dock.
        let flag: Option<String> = country_code.and_then(|c| flag_emoji_for_code(&c));
        let name: Option<String> = profile_name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty());
        apply_dock_icon(&app, flag, name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, country_code, profile_name);
        Ok(())
    }
}

/// Clear the Dock icon back to the plain bundle app icon (no session). Called
/// from the simulator window's close path + when it has no session. macOS-only
/// + best-effort, mirroring `set_dock_tile`.
#[tauri::command]
fn reset_dock_tile(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // No flag → apply_dock_icon resets the icon to the bundle default and
        // clears the badge.
        apply_dock_icon(&app, None, None)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Map a 2-letter ISO-3166 alpha-2 country code to its flag EMOJI — the pair of
/// Unicode regional-indicator symbols (U+1F1E6..U+1F1FF) macOS renders as the
/// flag glyph (e.g. "us" → "🇺🇸"). Returns `None` for anything that isn't exactly
/// two ASCII letters, so a non-country exit ('T1' for Tor, 'XX', empty) draws no
/// flag. Each letter maps A..Z → its regional-indicator code point by adding the
/// offset from ASCII 'A' to U+1F1E6.
#[cfg(target_os = "macos")]
fn flag_emoji_for_code(code: &str) -> Option<String> {
    let up = code.trim().to_uppercase();
    let bytes = up.as_bytes();
    if bytes.len() != 2 || !bytes.iter().all(|b| b.is_ascii_uppercase()) {
        return None;
    }
    const REGIONAL_INDICATOR_A: u32 = 0x1F1E6;
    let to_indicator =
        |b: u8| -> Option<char> { char::from_u32(REGIONAL_INDICATOR_A + u32::from(b - b'A')) };
    let first = to_indicator(bytes[0])?;
    let second = to_indicator(bytes[1])?;
    Some(format!("{first}{second}"))
}

/// Set (or reset, when `flag` is `None`) the macOS Dock ICON on the main thread,
/// drawing the country-flag emoji + (optional) profile-name caption into a fresh
/// `NSImage`. Factored out so `set_dock_tile` + `reset_dock_tile` share the one
/// bit of AppKit interop. macOS-only.
#[cfg(target_os = "macos")]
fn apply_dock_icon(
    app: &tauri::AppHandle,
    flag: Option<String>,
    name: Option<String>,
) -> Result<(), String> {
    // Hop to the main thread — AppKit's NSApplication is main-thread-only.
    app.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;
        // We're now guaranteed on the main thread, so this returns Some.
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let ns_app = NSApplication::sharedApplication(mtm);
        // SAFETY: setApplicationIconImage just swaps the app's icon image; the
        // image (when present) is a fresh, fully-built NSImage and we're on the
        // main thread. Passing None reverts to the bundle icon (documented).
        unsafe {
            match &flag {
                // A flag → draw the icon image and clear the (now-redundant) text
                // badge; the profile name rides the icon itself.
                Some(flag_emoji) => {
                    let image = render_flag_icon(flag_emoji, name.as_deref());
                    ns_app.setApplicationIconImage(Some(&image));
                    ns_app.dockTile().setBadgeLabel(None);
                }
                // No flag → revert to the bundle icon (nil) + clear the badge.
                None => {
                    ns_app.setApplicationIconImage(None);
                    ns_app.dockTile().setBadgeLabel(None);
                }
            }
        }
    })
    .map_err(|e| e.to_string())
}

/// Draw the country-flag emoji (+ optional profile-name caption) into a square
/// `NSImage` sized for the Dock. The flag emoji is drawn large and centred in
/// the upper area; when a name is given it's drawn as a single white line on a
/// translucent dark strip across the bottom (truncated to keep one tidy line).
/// macOS-only; MUST run on the main thread (the caller guarantees this).
///
/// Drawing goes through the modern, resolution-independent block API
/// `+[NSImage imageWithSize:flipped:drawingHandler:]` (the documented
/// replacement for the deprecated lockFocus/unlockFocus). AppKit calls the
/// handler block with the active off-screen graphics context already set up, so
/// the `NSString`/`NSColor` draw calls inside it land on the image.
#[cfg(target_os = "macos")]
fn render_flag_icon(
    flag_emoji: &str,
    name: Option<&str>,
) -> objc2::rc::Retained<objc2_app_kit::NSImage> {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2_app_kit::{
        NSColor, NSCompositingOperation, NSFont, NSFontAttributeName,
        NSForegroundColorAttributeName, NSImage, NSRectFillUsingOperation, NSStringDrawing,
    };
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    // 256pt square — macOS scales the Dock icon down; this is crisp at tile size.
    const SIDE: f64 = 256.0;

    // Truncate the caption to a sane single-line length BEFORE drawing so a long
    // profile name can't smear across / overflow the strip. Char-based (not
    // bytes) so multi-byte names truncate cleanly.
    let caption: Option<String> = name.map(|n| {
        const MAX_CHARS: usize = 18;
        if n.chars().count() > MAX_CHARS {
            let head: String = n.chars().take(MAX_CHARS - 1).collect();
            format!("{head}…")
        } else {
            n.to_string()
        }
    });
    // Build the two NSStrings outside the block (the block is `Fn`, called by
    // AppKit; it borrows these by move). The flag emoji + (optional) caption.
    let flag = NSString::from_str(flag_emoji);
    let label: Option<Retained<NSString>> = caption.as_deref().map(NSString::from_str);

    let handler = RcBlock::new(move |_rect: NSRect| -> Bool {
        // SAFETY: the AppKit draw calls (`NSString` draw-with-attributes,
        // `NSDictionary::from_slices` of attribute keys → freshly-built
        // font/colour objects, NSRectFillUsingOperation) are `unsafe` extern
        // methods. They're sound here: every argument is a correctly-typed,
        // freshly-built Foundation/AppKit object, and AppKit invokes this block
        // on the main thread with the image's graphics context already current.
        unsafe {
            // Flag emoji — a large system font renders the regional-indicator
            // pair as the flag artwork. Sized to most of the tile; nudged up when
            // a caption claims the bottom strip so the flag stays visually centred.
            let flag_font = NSFont::systemFontOfSize(if label.is_some() { 150.0 } else { 172.0 });
            // The attribute-value slice is typed as `&AnyObject` (the dictionary
            // is heterogeneous: a font here, a font + colour below); each AppKit
            // object up-casts to AnyObject through its deref chain (NSFont →
            // NSObject → AnyObject).
            let flag_font_obj: &AnyObject = &flag_font;
            let flag_attrs = NSDictionary::<NSString, AnyObject>::from_slices(
                &[NSFontAttributeName],
                &[flag_font_obj],
            );
            let flag_size = flag.sizeWithAttributes(Some(&flag_attrs));
            let flag_y = if label.is_some() {
                (SIDE - flag_size.height) / 2.0 + 28.0
            } else {
                (SIDE - flag_size.height) / 2.0
            };
            let flag_origin = NSPoint::new((SIDE - flag_size.width) / 2.0, flag_y);
            flag.drawAtPoint_withAttributes(flag_origin, Some(&flag_attrs));

            // Profile-name caption — one centred white line on a translucent dark
            // strip across the bottom, so the name is legible over any flag colour.
            if let Some(text) = &label {
                const STRIP_H: f64 = 62.0;
                let strip = NSColor::colorWithWhite_alpha(0.0, 0.55);
                strip.setFill();
                NSRectFillUsingOperation(
                    NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(SIDE, STRIP_H)),
                    NSCompositingOperation::SourceOver,
                );
                let name_font = NSFont::boldSystemFontOfSize(34.0);
                let name_color = NSColor::whiteColor();
                let name_font_obj: &AnyObject = &name_font;
                let name_color_obj: &AnyObject = &name_color;
                let name_attrs = NSDictionary::<NSString, AnyObject>::from_slices(
                    &[NSFontAttributeName, NSForegroundColorAttributeName],
                    &[name_font_obj, name_color_obj],
                );
                let label_size = text.sizeWithAttributes(Some(&name_attrs));
                let label_origin = NSPoint::new(
                    ((SIDE - label_size.width) / 2.0).max(4.0),
                    (STRIP_H - label_size.height) / 2.0,
                );
                text.drawAtPoint_withAttributes(label_origin, Some(&name_attrs));
            }
        }
        Bool::YES
    });

    NSImage::imageWithSize_flipped_drawingHandler(NSSize::new(SIDE, SIDE), false, &handler)
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

/// Structured result of a SOCKS5 proxy probe. Serialized straight to
/// the React side, so field names are the camel/snake the GUI reads.
#[derive(serde::Serialize)]
struct ProxyTestResult {
    /// TCP connect + SOCKS5 greeting handshake succeeded.
    reachable: bool,
    /// Username/password auth (RFC 1929) was accepted, or no auth was
    /// required. `false` only when credentials were offered + rejected.
    auth_ok: bool,
    /// Server answered a `UDP ASSOCIATE` request with success — i.e. it
    /// can relay UDP, so QUIC / WebRTC / HTTP-3 route through it instead
    /// of leaking over the host's direct connection.
    udp_associate: bool,
    /// Round-trip wall-clock to complete the handshake, in milliseconds.
    latency_ms: u64,
    /// Human-readable summary the GUI shows verbatim under the button.
    message: String,
}

/// Build the SOCKS5 greeting (RFC 1928 §3): version 5, the method
/// count, then the offered methods. We always offer `0x00` (no auth)
/// and additionally `0x02` (username/password) when credentials are
/// present, letting the server pick.
fn socks5_greeting(use_auth: bool) -> Vec<u8> {
    let methods: &[u8] = if use_auth { &[0x00, 0x02] } else { &[0x00] };
    let mut greeting = vec![0x05u8, methods.len() as u8];
    greeting.extend_from_slice(methods);
    greeting
}

/// Build the RFC 1929 username/password sub-negotiation packet:
/// version `0x01`, ULEN, username, PLEN, password.
fn socks5_userpass(user: &str, pass: &str) -> Vec<u8> {
    let mut auth = vec![0x01u8, user.len() as u8];
    auth.extend_from_slice(user.as_bytes());
    auth.push(pass.len() as u8);
    auth.extend_from_slice(pass.as_bytes());
    auth
}

/// Probe a SOCKS5 proxy: TCP connect → greeting → optional RFC 1929
/// auth → `UDP ASSOCIATE` capability check. Native (not WebView) so we
/// can open the raw socket the browser sandbox forbids.
fn run_socks5_probe(
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<ProxyTestResult, String> {
    let start = Instant::now();
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("DNS resolution failed: {e}"))?
        .next()
        .ok_or_else(|| "Host resolved to no addresses.".to_string())?;
    let mut stream = TcpStream::connect_timeout(&addr, PROXY_PROBE_TIMEOUT)
        .map_err(|e| format!("TCP connect failed: {e}"))?;
    stream.set_read_timeout(Some(PROXY_PROBE_TIMEOUT)).ok();
    stream.set_write_timeout(Some(PROXY_PROBE_TIMEOUT)).ok();

    let use_auth = username.is_some();
    stream
        .write_all(&socks5_greeting(use_auth))
        .map_err(|e| format!("write greeting: {e}"))?;

    let mut sel = [0u8; 2];
    stream
        .read_exact(&mut sel)
        .map_err(|e| format!("read method selection: {e}"))?;
    if sel[0] != 0x05 {
        return Err(format!("Not a SOCKS5 server (version byte {:#x}).", sel[0]));
    }

    let mut auth_ok = true;
    match sel[1] {
        0x00 => {} // no auth required
        0x02 => {
            let user = username.unwrap_or("");
            let pass = password.unwrap_or("");
            if user.len() > 255 || pass.len() > 255 {
                return Err("Username/password exceed the 255-byte SOCKS5 limit.".into());
            }
            stream
                .write_all(&socks5_userpass(user, pass))
                .map_err(|e| format!("write auth: {e}"))?;
            let mut auth_reply = [0u8; 2];
            stream
                .read_exact(&mut auth_reply)
                .map_err(|e| format!("read auth reply: {e}"))?;
            auth_ok = auth_reply[1] == 0x00;
            if !auth_ok {
                return Ok(ProxyTestResult {
                    reachable: true,
                    auth_ok: false,
                    udp_associate: false,
                    latency_ms: start.elapsed().as_millis() as u64,
                    message: "Connected, but the proxy rejected the username/password.".into(),
                });
            }
        }
        0xFF => {
            return Ok(ProxyTestResult {
                reachable: true,
                auth_ok: false,
                udp_associate: false,
                latency_ms: start.elapsed().as_millis() as u64,
                message: if use_auth {
                    "Server rejected all offered authentication methods.".into()
                } else {
                    "Server requires authentication — add a username + password.".into()
                },
            });
        }
        other => {
            return Err(format!(
                "Server selected unsupported auth method {other:#x}."
            ))
        }
    }

    // UDP ASSOCIATE (RFC 1928 §4, CMD 0x03) with DST 0.0.0.0:0 — the
    // standard "do you support UDP relay?" probe. ATYP 0x01 (IPv4).
    let udp_req = [0x05u8, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
    stream
        .write_all(&udp_req)
        .map_err(|e| format!("write UDP associate: {e}"))?;
    let mut reply_head = [0u8; 4]; // VER REP RSV ATYP
    let udp_associate = match stream.read_exact(&mut reply_head) {
        Ok(()) => reply_head[1] == 0x00,
        Err(_) => false,
    };
    // Drain the bound-address + port that follows a success reply so we
    // leave the stream tidy before drop. Best-effort; ignore errors.
    if udp_associate {
        let addr_bytes = match reply_head[3] {
            0x01 => 4 + 2,  // IPv4 + port
            0x04 => 16 + 2, // IPv6 + port
            0x03 => {
                let mut len = [0u8; 1];
                if stream.read_exact(&mut len).is_ok() {
                    len[0] as usize + 2
                } else {
                    0
                }
            }
            _ => 0,
        };
        if addr_bytes > 0 {
            let mut sink = vec![0u8; addr_bytes];
            let _ = stream.read_exact(&mut sink);
        }
    }

    let latency_ms = start.elapsed().as_millis() as u64;
    let message = if udp_associate {
        "SOCKS5 reachable. UDP ASSOCIATE supported — QUIC / WebRTC / HTTP-3 route through the proxy.".to_string()
    } else {
        "SOCKS5 reachable, but UDP ASSOCIATE is not supported — UDP traffic (QUIC / WebRTC) can't be tunnelled.".to_string()
    };
    Ok(ProxyTestResult {
        reachable: true,
        auth_ok,
        udp_associate,
        latency_ms,
        message,
    })
}

/// Test a saved SOCKS5 proxy from the desktop host (raw sockets are
/// unavailable inside the WebView, so the GUI invokes this). Never
/// throws to the JS side — a failed probe is returned as a
/// `reachable: false` result carrying the diagnostic in `message`.
#[tauri::command]
async fn proxy_test(
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
) -> ProxyTestResult {
    // Run the blocking SOCKS5 probe on a dedicated blocking thread. A sync
    // command runs on the main thread, so a slow/dead proxy (multi-second
    // connect timeout inside run_socks5_probe) froze the ENTIRE WebView —
    // rendering + input + the "Testing…" spinner all stalled until it returned.
    // spawn_blocking keeps the UI (and the spinner) live while the probe runs.
    tauri::async_runtime::spawn_blocking(move || {
        match run_socks5_probe(&host, port, username.as_deref(), password.as_deref()) {
            Ok(result) => result,
            Err(message) => ProxyTestResult {
                reachable: false,
                auth_ok: false,
                udp_associate: false,
                latency_ms: 0,
                message,
            },
        }
    })
    .await
    .unwrap_or_else(|_| ProxyTestResult {
        reachable: false,
        auth_ok: false,
        udp_associate: false,
        latency_ms: 0,
        message: "Proxy test could not be scheduled — please retry.".to_string(),
    })
}

/// Result of a VPN-endpoint reachability pre-flight. A VPN endpoint is usually
/// UDP (WireGuard always; OpenVPN often), so a TCP connect would falsely report
/// "down" — instead we do a protocol-agnostic DNS RESOLUTION of the host. This
/// catches the common error (typo'd / dead endpoint hostname) without claiming
/// the tunnel/auth works; full tunnel verification happens when a session
/// launches through the proxy (the harness fail-closes with the real reason).
#[derive(serde::Serialize)]
struct EndpointResolveResult {
    resolved: bool,
    /// First resolved IP (for display), or empty when resolution failed.
    ip: String,
    message: String,
}

/// Resolve a VPN endpoint host to confirm it's a valid, reachable hostname.
/// Native so we can resolve arbitrary hosts the WebView sandbox can't.
#[tauri::command]
async fn endpoint_resolve(host: String, port: u16) -> EndpointResolveResult {
    // to_socket_addrs() is a blocking DNS lookup; keep it off the main thread so
    // a slow resolver can't freeze the WebView (same class as proxy_test).
    tauri::async_runtime::spawn_blocking(move || {
        match (host.as_str(), port).to_socket_addrs() {
            Ok(mut addrs) => match addrs.next() {
                Some(addr) => EndpointResolveResult {
                    resolved: true,
                    ip: addr.ip().to_string(),
                    message: format!(
                        "Endpoint resolves to {} — tunnel verified at launch.",
                        addr.ip()
                    ),
                },
                None => EndpointResolveResult {
                    resolved: false,
                    ip: String::new(),
                    message: "Host resolved to no addresses — check the endpoint.".into(),
                },
            },
            Err(e) => EndpointResolveResult {
                resolved: false,
                ip: String::new(),
                message: format!("Couldn't resolve the endpoint host: {e}"),
            },
        }
    })
    .await
    .unwrap_or_else(|_| EndpointResolveResult {
        resolved: false,
        ip: String::new(),
        message: "Endpoint resolution could not be scheduled — please retry.".into(),
    })
}

/// E-2 exit-geo probe (probe-backend design, build-order 2): fetch the
/// platform's exit-IP echo THROUGH the customer's SOCKS5 proxy — the
/// response is the IP/country the world sees for sessions on this exit.
/// Never throws to JS: any failure (proxy down, echo 404 pre-deploy,
/// timeout) surfaces as an Err string the wrapper maps to null.
#[derive(serde::Serialize)]
struct ProxyExitProbeResult {
    ip: String,
    country: Option<String>,
    // Geo enrichment (2026-06-15): the platform echo only carries the
    // country (cf-ipcountry). For city/region we make a best-effort second
    // hop THROUGH THE SAME PROXY to lumtest.com/myip.json — it reports geo
    // for the CALLER's IP, so through the proxy that's the EXIT's location
    // (exactly what a site would infer). Any failure leaves these None; the
    // ip/country from the echo stay the reliable baseline so the probe never
    // regresses when lumtest is slow/blocked.
    city: Option<String>,
    region: Option<String>,
    timezone: Option<String>,
    asn_org: Option<String>,
}

/// Best-effort exit-geo enrichment via lumtest.com/myip.json over the same
/// SOCKS5 agent. Returns (city, region, timezone, asn_org); all None on any
/// failure so the caller degrades to the echo's country only.
fn lumtest_geo(
    agent: &ureq::Agent,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let none = (None, None, None, None);
    let resp = match agent.get("https://lumtest.com/myip.json").call() {
        Ok(r) => r,
        Err(_) => return none,
    };
    let body: serde_json::Value = match resp.into_json() {
        Ok(b) => b,
        Err(_) => return none,
    };
    let str_at = |v: &serde_json::Value, k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };
    let geo = body.get("geo").cloned().unwrap_or(serde_json::Value::Null);
    let city = str_at(&geo, "city");
    // Prefer the human-readable region name ("South Holland"), fall back to
    // the short code ("ZH") when the name is absent.
    let region = str_at(&geo, "region_name").or_else(|| str_at(&geo, "region"));
    let timezone = str_at(&geo, "tz");
    let asn_org = body
        .get("asn")
        .and_then(|a| a.get("org_name"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    (city, region, timezone, asn_org)
}

#[tauri::command]
async fn proxy_exit_probe(
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
) -> Result<ProxyExitProbeResult, String> {
    // Two blocking HTTP round-trips THROUGH the proxy (echo + lumtest geo) with
    // an 8s timeout each — the worst offender for freezing the WebView when run
    // on the main thread. Push the whole thing to a blocking thread so the UI
    // (and the "Testing…" state) stays live while the exit is probed.
    tauri::async_runtime::spawn_blocking(move || -> Result<ProxyExitProbeResult, String> {
        let auth = match (username.as_deref(), password.as_deref()) {
            (Some(u), Some(p)) if !u.is_empty() => format!("{u}:{p}@"),
            (Some(u), None) if !u.is_empty() => format!("{u}@"),
            _ => String::new(),
        };
        let proxy_url = format!("socks5://{auth}{host}:{port}");
        let proxy = ureq::Proxy::new(&proxy_url).map_err(|e| e.to_string())?;
        let agent = ureq::AgentBuilder::new()
            .proxy(proxy)
            .timeout(std::time::Duration::from_secs(8))
            .build();
        let resp = agent
            .get("https://api.driftstack.dev/v1/egress/echo")
            .call()
            .map_err(|e| e.to_string())?;
        let body: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        let ip = body
            .get("ip")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "echo response missing ip".to_string())?
            .to_string();
        let country = body
            .get("country")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let (city, region, timezone, asn_org) = lumtest_geo(&agent);
        Ok(ProxyExitProbeResult {
            ip,
            country,
            city,
            region,
            timezone,
            asn_org,
        })
    })
    .await
    .map_err(|_| "Exit probe could not be scheduled — please retry.".to_string())?
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

    #[test]
    fn greeting_offers_no_auth_only_when_credentials_absent() {
        // VER 5, NMETHODS 1, METHOD 0x00 (no auth).
        assert_eq!(socks5_greeting(false), vec![0x05, 0x01, 0x00]);
    }

    #[test]
    fn greeting_offers_both_methods_when_credentials_present() {
        // VER 5, NMETHODS 2, then 0x00 (no auth) + 0x02 (user/pass).
        assert_eq!(socks5_greeting(true), vec![0x05, 0x02, 0x00, 0x02]);
    }

    #[test]
    fn userpass_packet_matches_rfc1929_layout() {
        // VER 0x01, ULEN, username bytes, PLEN, password bytes.
        let packet = socks5_userpass("ab", "xyz");
        assert_eq!(packet, vec![0x01, 0x02, b'a', b'b', 0x03, b'x', b'y', b'z']);
    }

    #[test]
    fn userpass_length_prefixes_track_byte_length() {
        let packet = socks5_userpass("user", "");
        // ULEN 4 then the 4 username bytes, then PLEN 0 with no password.
        assert_eq!(packet[1], 4);
        assert_eq!(packet[2 + 4], 0);
        assert_eq!(packet.len(), 2 + 4 + 1);
    }

    #[test]
    fn b64_payload_accepts_well_formed_base64() {
        // `btoa("window=simulator&ws=wss://lk&token=t")`-style output.
        assert!(is_valid_b64_payload("d2luZG93PXNpbXVsYXRvcg=="));
        assert!(is_valid_b64_payload("YWJjMTIz"));
    }

    #[test]
    fn b64_payload_rejects_empty_or_garbled() {
        // An empty payload (the relaunch must never navigate to a blank page).
        assert!(!is_valid_b64_payload(""));
        // Spaces / control chars / quotes are not in the base64 alphabet.
        assert!(!is_valid_b64_payload("not valid"));
        assert!(!is_valid_b64_payload("'); alert(1) //"));
    }

    #[test]
    fn sim_key_path_stays_in_temp_dir_for_normal_ids() {
        // The canonical agent-session id (`agt_<uuid>`) maps to a clean
        // file name directly under the temp dir.
        let p = sim_key_path("agt_00000000-0000-4000-8000-000000000001");
        assert_eq!(p.parent(), Some(std::env::temp_dir().as_path()));
        assert_eq!(
            p.file_name().and_then(|n| n.to_str()),
            Some("driftstack-sim-agt_00000000-0000-4000-8000-000000000001.key"),
        );
    }

    #[test]
    fn sim_key_path_sanitises_traversal_and_separators() {
        // A hostile id can never escape the temp dir: `/`, `\`, and the
        // `.` in `..` survive only as the literal allowed `.` (no path
        // SEPARATOR), so the result is still a single file in temp_dir.
        let p = sim_key_path("../../etc/passwd");
        assert_eq!(p.parent(), Some(std::env::temp_dir().as_path()));
        // The slashes became underscores; no traversal component remains.
        let name = p.file_name().and_then(|n| n.to_str()).unwrap();
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
        assert_eq!(name, "driftstack-sim-.._.._etc_passwd.key");
    }

    #[test]
    fn sim_key_write_then_take_round_trips_and_unlinks() {
        // Use a unique id so parallel test runs don't collide.
        let id = format!("test-roundtrip-{}", std::process::id());
        let key = "gck_testkeytestkeytestkeytestkey";
        sim_key_write(id.clone(), key.to_string()).expect("write");
        // First take returns the key and unlinks.
        let got = sim_key_take(id.clone()).expect("take");
        assert_eq!(got.as_deref(), Some(key));
        // Second take finds no file → None (single-use).
        let again = sim_key_take(id).expect("take again");
        assert_eq!(again, None);
    }

    #[cfg(unix)]
    #[test]
    fn sim_key_write_uses_owner_only_0600_mode() {
        use std::os::unix::fs::PermissionsExt as _;
        let id = format!("test-perms-{}", std::process::id());
        sim_key_write(id.clone(), "gck_perm".to_string()).expect("write");
        let path = sim_key_path(&id);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        // Low 9 bits = rwx for owner/group/other; expect 0600.
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sim_key_take_missing_is_none_not_error() {
        let id = format!("test-missing-{}", std::process::id());
        // No file written → Ok(None), never Err.
        assert_eq!(sim_key_take(id).expect("take"), None);
    }
}
