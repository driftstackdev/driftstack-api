//! Driftstack GUI — Tauri backend library.
//!
//! Cross-platform (Windows / macOS / Linux). Currently exposes:
//!   * `ping` — health probe.
//!   * `secret_save` / `secret_load` / `secret_delete` (V-241 T3 #1) —
//!     cross-platform OS-keychain access for the API key. Transparently
//!     uses macOS Keychain, Windows Credential Manager, or
//!     Linux Secret Service / KWallet via the `keyring` crate.
//!   * `simulator_control_key_*` — bounded, zeroizing, process-memory-only
//!     storage for short-lived per-session Simulator control credentials.
//!
//! Future phases will add:
//!   * Local SQLite for session history + proxy presets,
//!   * SOCKS5 proxy testing + per-session config,
//!   * Driver-bridge to the modified WebKit fork process,
//!   * Live viewport (polling screenshots → WebRTC if scope allows).

use keyring::Entry;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};
use zeroize::{Zeroize, Zeroizing};

/// Wall-clock ceiling on each blocking socket op in the SOCKS5 probe.
/// Eight seconds is generous for a reachable proxy yet short enough
/// that the GUI's "Test proxy" spinner doesn't feel hung when a host
/// is dead.
const PROXY_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Service identifier surfaced in OS-native keychain UI. Matches the
/// Tauri bundle identifier so the stored secrets show under the app's
/// identity (e.g. macOS Keychain shows "dev.driftstack.gui").
const KEYRING_SERVICE: &str = "dev.driftstack.gui";

/// Locally registered Tauri commands do not inherit plugin ACL entries. Keep
/// the two bundle identities and their WebView roles explicit here so the
/// separately bundled Simulator cannot reach main-app native capabilities.
const MAIN_GUI_IDENTIFIER: &str = "dev.driftstack.gui";
const SIMULATOR_IDENTIFIER: &str = "dev.driftstack.simulator";
const COMMAND_ACCESS_DENIED: &str = "native command access denied";
const MAX_SECRET_VALUE_BYTES: usize = 128 * 1024;
const MAX_SIMULATOR_CONTROL_KEYS: usize = 32;
const SIMULATOR_CONTROL_KEY_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_WEBVIEW_SAFE_GENERATION: u64 = 9_007_199_254_740_991;

/// Stable username used for the per-user-account secret. The current
/// design is single-account (one keyring entry per device); when
/// multi-account support lands, this becomes a per-account-id key.
const KEYRING_USER: &str = "default";

fn is_main_gui_command_caller(app_identifier: &str, window_label: &str) -> bool {
    app_identifier == MAIN_GUI_IDENTIFIER && window_label == "main"
}

fn is_simulator_command_caller(app_identifier: &str, window_label: &str) -> bool {
    app_identifier == SIMULATOR_IDENTIFIER
        && (window_label == "main"
            || window_label
                .strip_prefix("sim-")
                .is_some_and(is_safe_session_label))
}

fn safe_secret_suffix(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_valid_main_gui_secret_key(key: &str) -> bool {
    key == "api_key"
        || key == "proxy_vault_key"
        || key
            .strip_prefix("api_key:")
            .is_some_and(|suffix| safe_secret_suffix(suffix, 320))
        || key
            .strip_prefix("proxy_secret:")
            .is_some_and(|suffix| safe_secret_suffix(suffix, 128))
}

/// Pure authorization matrix for durable OS-keychain access. Only the main GUI
/// may reach the account/proxy namespaces. Short-lived `gui_control` values are
/// deliberately absent: Simulator WebViews use the bounded process store below,
/// so rebuilt bundles never multiply Keychain authorization prompts for them.
fn secret_command_caller_allowed(app_identifier: &str, window_label: &str, key: &str) -> bool {
    is_main_gui_command_caller(app_identifier, window_label) && is_valid_main_gui_secret_key(key)
}

/// A Simulator process-memory credential is bound to the exact WebView/session
/// pair. The config-created `main` window uses the native MainSession owner;
/// dynamically-created windows carry the session in their `sim-<id>` label.
fn simulator_control_key_caller_allowed(
    app_identifier: &str,
    window_label: &str,
    main_session: Option<&str>,
    requested_session: &str,
) -> bool {
    if !is_safe_session_label(requested_session)
        || !is_simulator_command_caller(app_identifier, window_label)
    {
        return false;
    }
    let caller_session = if window_label == "main" {
        main_session
    } else {
        window_label.strip_prefix("sim-")
    };
    caller_session == Some(requested_session)
}

fn ensure_main_gui_command(window: &tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Manager as _;
    if is_main_gui_command_caller(&window.app_handle().config().identifier, window.label()) {
        Ok(())
    } else {
        Err(COMMAND_ACCESS_DENIED.to_string())
    }
}

fn ensure_simulator_command(window: &tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Manager as _;
    if is_simulator_command_caller(&window.app_handle().config().identifier, window.label()) {
        Ok(())
    } else {
        Err(COMMAND_ACCESS_DENIED.to_string())
    }
}

fn ensure_secret_command(window: &tauri::WebviewWindow, key: &str) -> Result<(), String> {
    use tauri::Manager as _;
    let app_identifier = &window.app_handle().config().identifier;
    if secret_command_caller_allowed(app_identifier, window.label(), key) {
        Ok(())
    } else {
        Err(COMMAND_ACCESS_DENIED.to_string())
    }
}

fn ensure_simulator_control_key_command(
    window: &tauri::WebviewWindow,
    main_session: &tauri::State<'_, MainSession>,
    session_id: &str,
) -> Result<(), String> {
    use tauri::Manager as _;
    let active_main_session = if window.label() == "main" {
        main_session
            .0
            .lock()
            .map_err(|_| COMMAND_ACCESS_DENIED.to_string())?
            .clone()
    } else {
        None
    };
    if simulator_control_key_caller_allowed(
        &window.app_handle().config().identifier,
        window.label(),
        active_main_session.as_deref(),
        session_id,
    ) {
        Ok(())
    } else {
        Err(COMMAND_ACCESS_DENIED.to_string())
    }
}

/// Bound and validate custom-scheme argv before forwarding it from a collapsed
/// second instance to the existing main WebView. Deep links may carry one-shot
/// auth state, so they are never logged; only the intended scheme crosses the
/// native event boundary.
const MAX_MAIN_GUI_DEEP_LINK_BYTES: usize = 8_192;
const MAX_MAIN_GUI_DEEP_LINKS: usize = 8;

fn main_gui_deep_links(argv: &[String]) -> Vec<String> {
    argv.iter()
        .filter(|arg| {
            arg.starts_with("driftstack://")
                && arg.len() <= MAX_MAIN_GUI_DEEP_LINK_BYTES
                && !arg.chars().any(char::is_control)
        })
        .take(MAX_MAIN_GUI_DEEP_LINKS)
        .cloned()
        .collect()
}

/// #137 — native crash breadcrumb. The founder reported the GUI window "just
/// closing on its own even if the browser remains open." main.tsx already
/// fails-visible on every JS `error` + `unhandledrejection` (with a RootErrorBoundary
/// and a fatal overlay), so a SILENT window vanish is a NATIVE tear-down — a Rust panic
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
            // MULTI-WINDOW simulator (founder 2026-06-23: "can't open multiple iPhones at
            // once, only 1 window opens"). A 2nd launch opens a NEW iPhone window for the
            // new session instead of re-pointing the single window; re-opening a session
            // focuses its existing window. The main GUI (different identifier, never
            // launched with --ds-label) keeps the focus-the-existing-window behaviour.
            if app.config().identifier == "dev.driftstack.simulator" {
                // Simulator argv carries ONLY the plain, non-secret session
                // label and unique handoff id. Parse/take only under this
                // bundle identity: main-GUI argv must never consume its file.
                let launch = simulator_launch_handoff(&argv);
                let b64 = launch
                    .as_ref()
                    .and_then(|(label, handoff_id)| {
                        take_sim_payload(label, handoff_id).ok().flatten()
                    })
                    .filter(|payload| is_valid_b64_payload(payload));
                match (b64.as_deref(), launch.as_ref()) {
                    (Some(payload), Some((label, _))) => {
                        open_or_focus_sim_window(app, label, payload)
                    }
                    _ => {
                        if let Some(win) = app.webview_windows().values().next() {
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                }
                return;
            }

            // Main GUI: focus the existing window and forward only validated
            // custom-scheme argv. The deep-link plugin's macOS event and this
            // single-instance fallback may both fire; the frontend briefly
            // deduplicates identical URLs before minting a Simulator token.
            let deep_links = main_gui_deep_links(&argv);
            if let Some(win) = app.get_webview_window("main") {
                use tauri::Emitter;
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
                if !deep_links.is_empty() {
                    let _ = win.emit("ds-deep-link", deep_links);
                }
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
        // Short-lived gui_control credentials intentionally stay inside the
        // Simulator process. This bounded zeroizing store survives a WebView
        // reload, but never an app restart or retained OS Keychain/disk storage.
        .manage(SimulatorControlKeyStore::default())
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
            // Stage 2 (separate Simulator app): on FIRST launch argv carries only
            // `--ds-label=<non-secret id>` plus a unique non-secret handoff id.
            // Consume the complete payload from that owner-only file before
            // applying it to the internal WebView.
            // Validation still precedes eval interpolation; malformed/oversized
            // payloads fail closed and the file has already been unlinked.
            let initial_launch = (app.config().identifier == SIMULATOR_IDENTIFIER)
                .then(|| simulator_launch_handoff(&std::env::args().collect::<Vec<_>>()))
                .flatten();
            let initial_label = initial_launch.as_ref().map(|(label, _)| label.clone());
            // Establish native command authority before the payload can start
            // the React tree. The config-created `main` Simulator window may
            // load only this exact session's native process-memory credential.
            if let Some(label) = &initial_label {
                if let Ok(mut current) = app.state::<MainSession>().0.lock() {
                    *current = Some(label.clone());
                }
            }
            if let Some((label, handoff_id)) = initial_launch.as_ref() {
                if let Some(b64) = take_sim_payload(label, handoff_id)
                    .ok()
                    .flatten()
                    .filter(|payload| is_valid_b64_payload(payload))
                {
                    match prepare_simulator_payload(
                        &app.state::<SimulatorControlKeyStore>(),
                        "main",
                        label,
                        &b64,
                    ) {
                        Ok(prepared) => {
                            if let Some(win) = app.get_webview_window("main") {
                                // Register destruction cleanup before the
                                // credential-bearing generation can reach the
                                // WebView; an immediate close cannot strand it.
                                attach_control_key_cleanup(
                                    app.handle().clone(),
                                    &win,
                                    label,
                                    prepared.control_generation,
                                );
                                match win.eval(format!(
                                    "window.location.search = atob('{}')",
                                    prepared.sanitized_b64
                                )) {
                                    Ok(()) => {}
                                    Err(error) => {
                                        let _ = app.state::<SimulatorControlKeyStore>().delete(
                                            "main",
                                            label,
                                            prepared.control_generation,
                                        );
                                        eprintln!(
                                            "[simulator] failed to apply initial handoff: {error}"
                                        );
                                    }
                                }
                            } else {
                                let _ = app.state::<SimulatorControlKeyStore>().delete(
                                    "main",
                                    label,
                                    prepared.control_generation,
                                );
                            }
                        }
                        Err(error) => eprintln!("[simulator] rejected initial handoff: {error}"),
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
            simulator_control_key_load,
            simulator_control_key_delete,
            proxy_test,
            proxy_exit_probe,
            endpoint_resolve,
            simulator_app_supported,
            launch_simulator,
            set_dock_tile,
            reset_dock_tile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

const MAX_SIM_PAYLOAD_B64_BYTES: usize = 128 * 1024;

/// Validate the protected handoff value before writing or interpolating it:
/// non-empty, bounded, and limited to the standard base64 alphabet (the JS side
/// decodes it with `atob`). The bound prevents an IPC caller or corrupt handoff
/// file from turning the privileged WebView eval into an unbounded allocation.
fn is_valid_b64_payload(payload: &str) -> bool {
    !payload.is_empty()
        && payload.len() <= MAX_SIM_PAYLOAD_B64_BYTES
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

fn is_safe_handoff_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

/// Require exactly one validated session label and one unique handoff id. The
/// pair is non-secret and safe in argv; the credential-bearing payload is not.
fn simulator_launch_handoff(args: &[String]) -> Option<(String, String)> {
    fn exact_arg(args: &[String], prefix: &str, validate: impl Fn(&str) -> bool) -> Option<String> {
        let mut values = args.iter().filter_map(|arg| arg.strip_prefix(prefix));
        let value = values.next()?;
        if values.next().is_some() || !validate(value) {
            return None;
        }
        Some(value.to_string())
    }

    Some((
        exact_arg(args, "--ds-label=", is_safe_session_label)?,
        exact_arg(args, "--ds-handoff=", is_safe_handoff_id)?,
    ))
}

/// The session label held by the simulator app's config-created `main` window (the FIRST
/// session). Lets the single-instance handler FOCUS `main` rather than open a duplicate
/// window when that same session is re-opened (multi-window, founder 2026-06-23).
struct MainSession(std::sync::Mutex<Option<String>>);

fn is_valid_simulator_control_key(value: &str) -> bool {
    value.strip_prefix("gck_").is_some_and(|body| {
        body.len() == 32
            && body
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || matches!(byte, b'2'..=b'7'))
    })
}

struct SimulatorControlKeyEntry {
    window_label: String,
    session_id: String,
    generation: u64,
    value: Zeroizing<String>,
    expires_at: Instant,
}

#[derive(Default)]
struct SimulatorControlKeyState {
    entries: VecDeque<SimulatorControlKeyEntry>,
    next_generation: u64,
    shutting_down: bool,
}

impl Drop for SimulatorControlKeyState {
    fn drop(&mut self) {
        // `Zeroizing<String>` already clears on drop; explicitly drain and
        // clear here as a load-bearing process-teardown invariant rather than
        // depending on a future container refactor to preserve drop order.
        while let Some(mut entry) = self.entries.pop_front() {
            entry.value.zeroize();
        }
    }
}

#[derive(Default)]
struct SimulatorControlKeyShared {
    state: std::sync::Mutex<SimulatorControlKeyState>,
    changed: std::sync::Condvar,
}

struct SimulatorControlKeyStore {
    shared: std::sync::Arc<SimulatorControlKeyShared>,
    expiry_reaper: Option<std::thread::JoinHandle<()>>,
}

impl Default for SimulatorControlKeyStore {
    fn default() -> Self {
        let shared = std::sync::Arc::new(SimulatorControlKeyShared::default());
        let reaper_shared = std::sync::Arc::clone(&shared);
        let expiry_reaper = std::thread::Builder::new()
            .name("simulator-control-key-expiry".to_string())
            .spawn(move || Self::run_expiry_reaper(reaper_shared))
            .expect("failed to start simulator control credential expiry owner");
        Self {
            shared,
            expiry_reaper: Some(expiry_reaper),
        }
    }
}

impl Drop for SimulatorControlKeyStore {
    fn drop(&mut self) {
        // One process-scoped owner is bounded independently of the number of
        // credentials. Wake it so process teardown never waits for a 24h TTL.
        let mut state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.shutting_down = true;
        drop(state);
        self.shared.changed.notify_all();
        if let Some(reaper) = self.expiry_reaper.take() {
            let _ = reaper.join();
        }
    }
}

impl SimulatorControlKeyStore {
    fn wipe_entry(mut entry: SimulatorControlKeyEntry) {
        entry.value.zeroize();
    }

    fn purge_expired(entries: &mut VecDeque<SimulatorControlKeyEntry>, now: Instant) -> bool {
        let original_len = entries.len();
        let mut index = 0;
        while index < entries.len() {
            if entries[index].expires_at <= now {
                if let Some(entry) = entries.remove(index) {
                    Self::wipe_entry(entry);
                }
            } else {
                index += 1;
            }
        }
        entries.len() != original_len
    }

    fn run_expiry_reaper(shared: std::sync::Arc<SimulatorControlKeyShared>) {
        let mut state = match shared.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        loop {
            if state.shutting_down {
                return;
            }
            if Self::purge_expired(&mut state.entries, Instant::now()) {
                // Wake deterministic test/native observers after the secret
                // allocation has been cleared, without involving a WebView.
                shared.changed.notify_all();
            }
            let next_expiry = state.entries.iter().map(|entry| entry.expires_at).min();
            state = match next_expiry {
                Some(expires_at) => {
                    let wait = expires_at.saturating_duration_since(Instant::now());
                    match shared.changed.wait_timeout(state, wait) {
                        Ok((state, _)) => state,
                        Err(_) => return,
                    }
                }
                None => match shared.changed.wait(state) {
                    Ok(state) => state,
                    Err(_) => return,
                },
            };
        }
    }

    fn store_at(
        &self,
        window_label: &str,
        session_id: &str,
        value: String,
        now: Instant,
        ttl: Duration,
    ) -> Result<u64, String> {
        // Wrap immediately so every early return (validation, lock failure, or
        // generation exhaustion) clears the provided credential allocation.
        let value = Zeroizing::new(value);
        if (window_label != "main" && window_label != format!("sim-{session_id}"))
            || !is_safe_session_label(session_id)
            || !is_valid_simulator_control_key(&value)
        {
            return Err("invalid simulator control credential".to_string());
        }
        if ttl.is_zero() {
            return Err("expired simulator control credential".to_string());
        }
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "simulator control credential store unavailable".to_string())?;
        Self::purge_expired(&mut state.entries, now);
        if let Some(index) = state
            .entries
            .iter()
            .position(|entry| entry.window_label == window_label)
        {
            if let Some(entry) = state.entries.remove(index) {
                Self::wipe_entry(entry);
            }
        }
        state.next_generation = state
            .next_generation
            .checked_add(1)
            .filter(|generation| *generation <= MAX_WEBVIEW_SAFE_GENERATION)
            .ok_or_else(|| "simulator control credential generation exhausted".to_string())?;
        let generation = state.next_generation;
        state.entries.push_back(SimulatorControlKeyEntry {
            window_label: window_label.to_string(),
            session_id: session_id.to_string(),
            generation,
            value,
            expires_at: now + ttl.min(SIMULATOR_CONTROL_KEY_TTL),
        });
        while state.entries.len() > MAX_SIMULATOR_CONTROL_KEYS {
            if let Some(entry) = state.entries.pop_front() {
                Self::wipe_entry(entry);
            }
        }
        drop(state);
        self.shared.changed.notify_all();
        Ok(generation)
    }

    fn load_at(
        &self,
        window_label: &str,
        session_id: &str,
        generation: u64,
        now: Instant,
    ) -> Result<Option<String>, String> {
        if !is_safe_session_label(session_id) || generation == 0 {
            return Ok(None);
        }
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "simulator control credential store unavailable".to_string())?;
        let expired = Self::purge_expired(&mut state.entries, now);
        let Some(index) = state.entries.iter().position(|entry| {
            entry.window_label == window_label
                && entry.session_id == session_id
                && entry.generation == generation
        }) else {
            drop(state);
            if expired {
                self.shared.changed.notify_all();
            }
            return Ok(None);
        };
        let entry = state
            .entries
            .remove(index)
            .ok_or_else(|| "simulator control credential store unavailable".to_string())?;
        let value = entry.value.as_str().to_string();
        // Successful reads refresh only LRU order, never the original expiry.
        state.entries.push_back(entry);
        drop(state);
        if expired {
            self.shared.changed.notify_all();
        }
        Ok(Some(value))
    }

    fn delete(&self, window_label: &str, session_id: &str, generation: u64) -> Result<(), String> {
        if !is_safe_session_label(session_id) || generation == 0 {
            return Ok(());
        }
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "simulator control credential store unavailable".to_string())?;
        let mut removed = false;
        if let Some(index) = state.entries.iter().position(|entry| {
            entry.window_label == window_label
                && entry.session_id == session_id
                && entry.generation == generation
        }) {
            if let Some(entry) = state.entries.remove(index) {
                Self::wipe_entry(entry);
                removed = true;
            }
        }
        drop(state);
        if removed {
            self.shared.changed.notify_all();
        }
        Ok(())
    }

    /// A handoff without a control credential is an explicit replacement, not
    /// permission to retain an earlier generation invisibly. This internal
    /// native-only reset is intentionally not exposed as a WebView command.
    fn clear_window(&self, window_label: &str) -> Result<(), String> {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "simulator control credential store unavailable".to_string())?;
        let mut index = 0;
        let mut removed = false;
        while index < state.entries.len() {
            if state.entries[index].window_label == window_label {
                if let Some(entry) = state.entries.remove(index) {
                    Self::wipe_entry(entry);
                    removed = true;
                }
            } else {
                index += 1;
            }
        }
        drop(state);
        if removed {
            self.shared.changed.notify_all();
        }
        Ok(())
    }

    fn load(
        &self,
        window_label: &str,
        session_id: &str,
        generation: u64,
    ) -> Result<Option<String>, String> {
        self.load_at(window_label, session_id, generation, Instant::now())
    }
}

struct PreparedSimulatorPayload {
    sanitized_b64: String,
    control_generation: u64,
}

/// Consume the control credential before any payload reaches a WebView. The
/// owner-only handoff file remains the short cross-process transport, but the
/// internal URL/event carries only a non-secret generation. Duplicate or
/// mismatched owner fields fail closed instead of selecting one arbitrarily.
fn prepare_simulator_payload_at(
    control_keys: &SimulatorControlKeyStore,
    window_label: &str,
    session_label: &str,
    b64: &str,
    wall_now_ms: u128,
    monotonic_now: Instant,
) -> Result<PreparedSimulatorPayload, String> {
    use base64::Engine as _;
    if !is_valid_b64_payload(b64) || !is_safe_session_label(session_label) {
        return Err("invalid simulator handoff".to_string());
    }
    let query = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(Zeroizing::new)
        .ok_or_else(|| "invalid simulator handoff".to_string())?;
    if query.is_empty() || query.chars().any(char::is_control) {
        return Err("invalid simulator handoff".to_string());
    }

    let mut sanitized: Vec<String> = Vec::new();
    let mut handoff_session: Option<&str> = None;
    let mut control_key: Option<&str> = None;
    let mut control_expires_ms: Option<u128> = None;
    let mut control_expiry_seen = false;
    for component in query.split('&') {
        let (name, value) = component.split_once('=').unwrap_or((component, ""));
        // URLSearchParams decodes percent escapes in names. Reject encoded or
        // otherwise irregular names here so `%63k` cannot smuggle a credential
        // field past the native scrub and make it visible to the WebView.
        if name.is_empty()
            || name.len() > 32
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err("invalid simulator handoff field".to_string());
        }
        match name {
            "session" => {
                if handoff_session.replace(value).is_some() {
                    return Err("duplicate simulator session handoff".to_string());
                }
                sanitized.push(component.to_string());
            }
            "ck" => {
                if control_key.replace(value).is_some() {
                    return Err("duplicate simulator control credential".to_string());
                }
            }
            "cke" => {
                if control_expiry_seen {
                    return Err("duplicate simulator control expiry".to_string());
                }
                control_expiry_seen = true;
                control_expires_ms = value.parse::<u128>().ok();
                if control_expires_ms.is_none() {
                    return Err("invalid simulator control expiry".to_string());
                }
            }
            // A caller cannot choose its own native generation.
            "cg" => return Err("invalid simulator control generation".to_string()),
            _ => sanitized.push(component.to_string()),
        }
    }
    if handoff_session != Some(session_label) {
        return Err("simulator handoff session mismatch".to_string());
    }

    let generation = match (control_key, control_expires_ms) {
        (None, None) => {
            control_keys.clear_window(window_label)?;
            0
        }
        (Some(value), Some(expires_ms)) => {
            if value.is_empty() {
                return Err("invalid simulator control credential".to_string());
            }
            if expires_ms <= wall_now_ms {
                return Err("expired simulator control credential".to_string());
            }
            let remaining_ms = (expires_ms - wall_now_ms).min(u128::from(u64::MAX)) as u64;
            control_keys.store_at(
                window_label,
                session_label,
                value.to_string(),
                monotonic_now,
                Duration::from_millis(remaining_ms),
            )?
        }
        _ => return Err("incomplete simulator control credential".to_string()),
    };
    sanitized.push(format!("cg={generation}"));
    let sanitized_query = sanitized.join("&");
    if sanitized.iter().any(|component| {
        matches!(
            component.split_once('=').map(|(name, _)| name),
            Some("ck") | Some("cke")
        )
    }) {
        return Err("simulator credential sanitization failed".to_string());
    }
    Ok(PreparedSimulatorPayload {
        sanitized_b64: base64::engine::general_purpose::STANDARD.encode(sanitized_query),
        control_generation: generation,
    })
}

fn prepare_simulator_payload(
    control_keys: &SimulatorControlKeyStore,
    window_label: &str,
    session_label: &str,
    b64: &str,
) -> Result<PreparedSimulatorPayload, String> {
    let wall_now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    prepare_simulator_payload_at(
        control_keys,
        window_label,
        session_label,
        b64,
        wall_now_ms,
        Instant::now(),
    )
}

/// Multi-window simulator: open a NEW per-session iPhone window for `label`, or focus the
/// existing one (`main` for the first session, else `sim-<label>`). The b64 query was consumed
/// from the single-use handoff file and is decoded HERE into the new window's internal URL —
/// it is never present in argv — so the window loads directly with no eval-timing race.
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
            let prepared = match prepare_simulator_payload(
                &app.state::<SimulatorControlKeyStore>(),
                "main",
                label,
                b64,
            ) {
                Ok(prepared) => prepared,
                Err(error) => {
                    eprintln!("[simulator] rejected session handoff: {error}");
                    return;
                }
            };
            use tauri::Emitter;
            attach_control_key_cleanup(app.clone(), &win, label, prepared.control_generation);
            if let Err(error) = win.emit("ds-session", &prepared.sanitized_b64) {
                let _ = app.state::<SimulatorControlKeyStore>().delete(
                    "main",
                    label,
                    prepared.control_generation,
                );
                eprintln!("[simulator] failed to apply session handoff: {error}");
                return;
            }
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
        let prepared = match prepare_simulator_payload(
            &app.state::<SimulatorControlKeyStore>(),
            &win_label,
            label,
            b64,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                eprintln!("[simulator] rejected session handoff: {error}");
                return;
            }
        };
        use tauri::Emitter;
        attach_control_key_cleanup(app.clone(), &win, label, prepared.control_generation);
        if let Err(error) = win.emit("ds-session", &prepared.sanitized_b64) {
            let _ = app.state::<SimulatorControlKeyStore>().delete(
                &win_label,
                label,
                prepared.control_generation,
            );
            eprintln!("[simulator] failed to apply session handoff: {error}");
            return;
        }
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    let prepared = match prepare_simulator_payload(
        &app.state::<SimulatorControlKeyStore>(),
        &win_label,
        label,
        b64,
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            eprintln!("[simulator] rejected session handoff: {error}");
            return;
        }
    };
    let query = base64::engine::general_purpose::STANDARD
        .decode(&prepared.sanitized_b64)
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
        Ok(win) => {
            attach_control_key_cleanup(app.clone(), &win, label, prepared.control_generation);
            attach_quit_when_last_window_closes(app.clone(), &win);
        }
        Err(e) => {
            let _ = app.state::<SimulatorControlKeyStore>().delete(
                &win_label,
                label,
                prepared.control_generation,
            );
            eprintln!("[simulator] failed to open session window {win_label}: {e}");
        }
    }
}

/// Register one exact-generation destroy hook per handoff. Old hooks become
/// inert after replacement because deletion matches window+session+generation;
/// the newest hook zeroizes the live entry when that WebView is destroyed.
fn attach_control_key_cleanup(
    app: tauri::AppHandle,
    win: &tauri::WebviewWindow,
    session_id: &str,
    generation: u64,
) {
    if generation == 0 {
        return;
    }
    use tauri::Manager as _;
    let window_label = win.label().to_string();
    let session_id = session_id.to_string();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = app.state::<SimulatorControlKeyStore>().delete(
                &window_label,
                &session_id,
                generation,
            );
        }
    });
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

/// Launch the separate "Driftstack Simulator" app. The complete base64 session
/// query (LiveKit JWT + session control key) is atomically written to a 0600
/// single-use handoff file. argv carries only the validated non-secret session
/// label and a unique non-secret handoff id; the Simulator reads and unlinks
/// that exact file before creating/updating its WebView. Base64 must never be
/// treated as process-list protection.
/// Whether THIS BUILD's platform ships the separate "Driftstack Simulator" app.
///
/// macOS installs it as its own .app bundle with its own Dock icon, and
/// `launch_simulator` below spawns it via `open`. No other platform has that
/// bundle — the non-macOS branch of `launch_simulator` returns an error — so on
/// Windows and Linux the GUI has to open the simulator as an in-process window
/// instead. Without this the front end cannot tell "the app is missing" (worth
/// an error) from "this platform has no such app" (worth a different window),
/// and a Windows user simply cannot launch a profile at all.
///
/// A compile-time constant rather than a runtime probe: the question is "was
/// this binary built for the platform that has the separate app", which is
/// exactly what `launch_simulator`'s own `cfg` gate answers.
#[tauri::command]
fn simulator_app_supported() -> bool {
    cfg!(target_os = "macos")
}

#[tauri::command]
fn launch_simulator(
    window: tauri::WebviewWindow,
    payload: String,
    session_label: String,
) -> Result<(), String> {
    ensure_main_gui_command(&window)?;
    #[cfg(target_os = "macos")]
    {
        if !is_safe_session_label(&session_label) {
            return Err("invalid simulator session label".to_string());
        }
        if !is_valid_b64_payload(&payload) {
            return Err("invalid or oversized simulator session payload".to_string());
        }
        let app_path = "/Applications/Driftstack Simulator.app";
        if !std::path::Path::new(app_path).exists() {
            return Err("Driftstack Simulator.app is not installed".to_string());
        }
        let handoff = write_sim_payload(&session_label, &payload)?;
        // Both arguments are non-secret. The unique handoff id prevents two
        // rapid launches for the same session from replacing each other's file.
        let spawn = std::process::Command::new("open")
            .args(simulator_open_args(app_path, &session_label, &handoff.id))
            .spawn()
            .map_err(|e| e.to_string());
        if let Err(error) = spawn {
            remove_sim_payload_if_identity(&handoff.path, handoff.identity);
            return Err(error);
        }
        // If `open` spawned but the target never consumed the handoff, bound the
        // plaintext lifetime. A successful take unlinks earlier; this is a no-op.
        let cleanup_path = handoff.path;
        let cleanup_identity = handoff.identity;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(60));
            remove_sim_payload_if_identity(&cleanup_path, cleanup_identity);
        });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (payload, session_label);
        Err("the separate simulator app is macOS-only".to_string())
    }
}

fn simulator_open_args(app_path: &str, session_label: &str, handoff_id: &str) -> Vec<String> {
    vec![
        "-n".to_string(),
        "-a".to_string(),
        app_path.to_string(),
        "--args".to_string(),
        format!("--ds-label={session_label}"),
        format!("--ds-handoff={handoff_id}"),
    ]
}

/// Every launch gets a distinct path. A same-session successor therefore never
/// replaces the file an older process has opened or is about to clean up.
fn sim_payload_path(session_label: &str, handoff_id: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "driftstack-sim-{session_label}-{handoff_id}.handoff"
    ))
}

static SIM_HANDOFF_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn new_sim_handoff_id() -> Result<String, String> {
    use std::sync::atomic::Ordering;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let counter = SIM_HANDOFF_COUNTER.fetch_add(1, Ordering::Relaxed);
    let id = format!("{:x}-{nanos:x}-{counter:x}", std::process::id());
    if !is_safe_handoff_id(&id) {
        return Err("invalid simulator handoff id".to_string());
    }
    Ok(id)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SimPayloadIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    len: u64,
    #[cfg(not(unix))]
    modified: Option<std::time::SystemTime>,
}

fn sim_payload_identity_from_metadata(metadata: &std::fs::Metadata) -> SimPayloadIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        SimPayloadIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
    #[cfg(not(unix))]
    {
        SimPayloadIdentity {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

fn sim_payload_identity(path: &std::path::Path) -> Result<SimPayloadIdentity, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(sim_payload_identity_from_metadata(&metadata))
}

fn sim_payload_identity_or_cleanup(
    path: &std::path::Path,
    metadata: std::io::Result<std::fs::Metadata>,
) -> Result<SimPayloadIdentity, String> {
    match metadata {
        Ok(metadata) => Ok(sim_payload_identity_from_metadata(&metadata)),
        Err(error) => {
            // This create_new path belongs only to this launch. Without an
            // identity no later cleanup owner can be installed, so remove the
            // credential-bearing file before returning the fstat failure.
            let _ = std::fs::remove_file(path);
            Err(error.to_string())
        }
    }
}

/// Delete only the handoff generation written by this launch. A delayed cleanup
/// thread or failed older spawn must never delete a newer payload for the same
/// session label.
fn remove_sim_payload_if_identity(path: &std::path::Path, expected: SimPayloadIdentity) {
    if sim_payload_identity(path).ok() == Some(expected) {
        let _ = std::fs::remove_file(path);
    }
}

struct SimPayloadHandoff {
    id: String,
    path: std::path::PathBuf,
    identity: SimPayloadIdentity,
}

fn write_sim_payload(session_label: &str, payload: &str) -> Result<SimPayloadHandoff, String> {
    if !is_safe_session_label(session_label) || !is_valid_b64_payload(payload) {
        return Err("invalid simulator handoff".to_string());
    }
    let handoff_id = new_sim_handoff_id()?;
    let path = sim_payload_path(session_label, &handoff_id);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|error| error.to_string())?;
    use std::io::Write as _;
    if let Err(error) = file
        .write_all(payload.as_bytes())
        .and_then(|()| file.sync_all())
    {
        let _ = std::fs::remove_file(&path);
        return Err(error.to_string());
    }
    let identity = sim_payload_identity_or_cleanup(&path, file.metadata())?;
    Ok(SimPayloadHandoff {
        id: handoff_id,
        path,
        identity,
    })
}

/// Open without following symlinks, unlink immediately, then perform a bounded
/// read of the complete session payload. The writer is 0600; reject broader
/// Unix permissions and non-regular files before any content reaches a WebView.
fn take_sim_payload(session_label: &str, handoff_id: &str) -> Result<Option<String>, String> {
    if !is_safe_session_label(session_label) || !is_safe_handoff_id(handoff_id) {
        return Ok(None);
    }
    let path = sim_payload_path(session_label, handoff_id);
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        // The failing open did not establish an identity. Leave the path
        // untouched: a same-session writer may already have replaced the
        // corrupt/symlink generation with a valid successor.
        Err(e) => return Err(e.to_string()),
    };
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let opened_identity = sim_payload_identity_from_metadata(&metadata);
    // The open handle remains valid after unlink and is immune to path swaps.
    // Delete only the exact unique path generation we opened. A rapid same-
    // session successor necessarily has a different handoff id/path.
    remove_sim_payload_if_identity(&path, opened_identity);
    if !metadata.is_file() {
        return Err("simulator handoff is not a regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("simulator handoff permissions are not owner-only".to_string());
        }
    }
    use std::io::Read as _;
    let mut contents = String::new();
    file.take((MAX_SIM_PAYLOAD_B64_BYTES + 1) as u64)
        .read_to_string(&mut contents)
        .map_err(|e| e.to_string())?;
    if !is_valid_b64_payload(&contents) {
        return Err("invalid or oversized simulator handoff payload".to_string());
    }
    Ok(Some(contents))
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
    window: tauri::WebviewWindow,
    country_code: Option<String>,
    profile_name: Option<String>,
) -> Result<(), String> {
    use tauri::Manager as _;
    ensure_simulator_command(&window)?;
    #[cfg(target_os = "macos")]
    {
        // Normalise to an uppercase 2-letter ISO code; anything else (Tor 'T1',
        // 'XX', empty) yields no flag rather than painting garbage on the Dock.
        let flag: Option<String> = country_code.and_then(|c| flag_emoji_for_code(&c));
        let name: Option<String> = profile_name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty());
        apply_dock_icon(window.app_handle(), flag, name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, country_code, profile_name);
        Ok(())
    }
}

/// Clear the Dock icon back to the plain bundle app icon (no session). Called
/// from the simulator window's close path + when it has no session. macOS-only
/// + best-effort, mirroring `set_dock_tile`.
#[tauri::command]
fn reset_dock_tile(window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Manager as _;
    ensure_simulator_command(&window)?;
    #[cfg(target_os = "macos")]
    {
        // No flag → apply_dock_icon resets the icon to the bundle default and
        // clears the badge.
        apply_dock_icon(window.app_handle(), None, None)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
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

/// Load only the calling Simulator WebView's exact-session in-process key.
/// A process restart intentionally returns `None`; the main GUI must provide a
/// fresh protected launch handoff instead of resurrecting a durable credential.
#[tauri::command]
fn simulator_control_key_load(
    window: tauri::WebviewWindow,
    main_session: tauri::State<'_, MainSession>,
    control_keys: tauri::State<'_, SimulatorControlKeyStore>,
    session_id: String,
    generation: u64,
) -> Result<Option<String>, String> {
    ensure_simulator_control_key_command(&window, &main_session, &session_id)?;
    control_keys.load(window.label(), &session_id, generation)
}

/// Explicit session end zeroizes only the matching native generation. A stale
/// WebView cleanup cannot delete a newer reconnect credential.
#[tauri::command]
fn simulator_control_key_delete(
    window: tauri::WebviewWindow,
    main_session: tauri::State<'_, MainSession>,
    control_keys: tauri::State<'_, SimulatorControlKeyStore>,
    session_id: String,
    generation: u64,
) -> Result<(), String> {
    ensure_simulator_control_key_command(&window, &main_session, &session_id)?;
    control_keys.delete(window.label(), &session_id, generation)
}

/// Save an authorized API/proxy secret to the OS keychain under its validated
/// key name. Returns `Ok(())` on success, `Err(message)` on
/// failure. Errors include OS-keychain access denial (user dismissed
/// the prompt on macOS, or LinuxSecret-Service is locked).
///
/// `key` is a logical name like `"api_key"`. Multiple keys can coexist under
/// the same service identifier; each gets a separate keychain entry. The
/// caller's bundle/window role constrains which namespaces are reachable.
#[tauri::command]
fn secret_save(window: tauri::WebviewWindow, key: String, value: String) -> Result<(), String> {
    ensure_secret_command(&window, &key)?;
    if value.is_empty() || value.len() > MAX_SECRET_VALUE_BYTES {
        return Err("invalid secret value".to_string());
    }
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
fn secret_load(window: tauri::WebviewWindow, key: String) -> Result<Option<String>, String> {
    ensure_secret_command(&window, &key)?;
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
fn secret_delete(window: tauri::WebviewWindow, key: String) -> Result<(), String> {
    ensure_secret_command(&window, &key)?;
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
    /// A real SOCKS5 CONNECT (CMD 0x01) to a public destination succeeded.
    ///
    /// This is the verdict that actually answers "can this proxy carry my
    /// traffic". Everything above it is preamble: a proxy can accept TCP,
    /// complete the greeting and accept credentials and STILL refuse every
    /// CONNECT. That is not a corner case — five NodeMaven endpoints did
    /// exactly that on 2026-08-18, answering 0x02 "not allowed by ruleset"
    /// to every request while this probe reported "Connected · auth ok" and
    /// customers launched profiles that could not reach anything.
    can_route: bool,
    /// Raw SOCKS5 reply byte from the CONNECT attempt (RFC 1928 §6), kept so
    /// the UI can say WHY rather than just "failed". 0x00 success, 0x02 not
    /// allowed by ruleset, 0x03 network unreachable, 0x04 host unreachable,
    /// 0x05 connection refused, 0x06 TTL expired. 0xFF = no reply read.
    connect_reply: u8,
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
                    can_route: false,
                    connect_reply: 0xFF,
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
                can_route: false,
                connect_reply: 0xFF,
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

    // CONNECT (RFC 1928 §4, CMD 0x01) to a real public destination.
    //
    // This is the check that was missing, and its absence is why the Test
    // button could not be trusted: auth success was being reported as
    // "Connected", but authenticating and ROUTING are separate permissions on
    // every commercial proxy. A residential endpoint whose plan has lapsed, or
    // whose ruleset forbids a destination, authenticates perfectly and then
    // refuses every CONNECT.
    //
    // Destination is 1.1.1.1:443 as a DOTTED IPv4 (ATYP 0x01), deliberately:
    // a hostname (ATYP 0x03) would make the proxy resolve DNS, so a DNS fault
    // would be indistinguishable from a routing refusal. Port 443 because a
    // proxy that allows only 80 is not usable for this product anyway.
    let connect_req = [0x05u8, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x01, 0xBB];
    stream
        .write_all(&connect_req)
        .map_err(|e| format!("write CONNECT: {e}"))?;
    let mut connect_head = [0u8; 4]; // VER REP RSV ATYP
    let connect_reply = match stream.read_exact(&mut connect_head) {
        Ok(()) => connect_head[1],
        Err(_) => 0xFF,
    };
    let can_route = connect_reply == 0x00;
    // Drain the bound address that follows, so the UDP probe below reads its
    // own reply rather than this one's tail.
    if connect_reply != 0xFF {
        let addr_bytes = match connect_head[3] {
            0x01 => 4 + 2,
            0x04 => 16 + 2,
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
    // A CONNECT that succeeded leaves the stream bound to the destination, so
    // it can no longer carry a UDP ASSOCIATE. Reconnect for that probe rather
    // than reporting a false negative on UDP.
    if can_route {
        stream = TcpStream::connect_timeout(&addr, PROXY_PROBE_TIMEOUT)
            .map_err(|e| format!("TCP reconnect for UDP probe failed: {e}"))?;
        stream.set_read_timeout(Some(PROXY_PROBE_TIMEOUT)).ok();
        stream.set_write_timeout(Some(PROXY_PROBE_TIMEOUT)).ok();
        stream
            .write_all(&socks5_greeting(use_auth))
            .map_err(|e| format!("write greeting (udp): {e}"))?;
        let mut sel2 = [0u8; 2];
        stream
            .read_exact(&mut sel2)
            .map_err(|e| format!("read greeting (udp): {e}"))?;
        if sel2[1] == 0x02 {
            if let (Some(user), Some(pass)) = (username, password) {
                stream
                    .write_all(&socks5_userpass(user, pass))
                    .map_err(|e| format!("write auth (udp): {e}"))?;
                let mut a2 = [0u8; 2];
                let _ = stream.read_exact(&mut a2);
            }
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
    // The headline is whether traffic can actually LEAVE. UDP support is a
    // qualifier on a working proxy, never a substitute for one — reporting it
    // as the verdict is what let an endpoint that refuses every CONNECT read
    // as healthy.
    let udp_note = if udp_associate {
        " UDP ASSOCIATE supported — QUIC / WebRTC / HTTP-3 tunnel through it too."
    } else {
        " UDP ASSOCIATE is not supported, so QUIC / WebRTC can't be tunnelled."
    };
    let message = if can_route {
        format!("Working — CONNECT succeeded.{udp_note}")
    } else {
        // Name the refusal in the proxy's own words. "Failed" sends someone to
        // re-check a password that was already accepted; "your plan does not
        // allow this destination" sends them to their provider.
        let why = match connect_reply {
            0x02 => "the proxy refused it: not allowed by its ruleset (usually an expired plan, or a destination/port your provider blocks)",
            0x03 => "the proxy reported the network as unreachable",
            0x04 => "the proxy reported the host as unreachable",
            0x05 => "the proxy's upstream refused the connection",
            0x06 => "the connection expired (TTL) inside the proxy",
            0x07 => "the proxy does not support CONNECT",
            0x08 => "the proxy rejected the address type",
            0xFF => "the proxy accepted the request and then answered nothing",
            _ => "the proxy returned an unrecognised SOCKS5 error",
        };
        format!(
            "Authenticates, but cannot route: {why}. Credentials are fine — this proxy will not carry traffic, so a profile launched through it cannot reach anything."
        )
    };
    Ok(ProxyTestResult {
        reachable: true,
        auth_ok,
        udp_associate,
        can_route,
        connect_reply,
        latency_ms,
        message,
    })
}

/// Test a saved SOCKS5 proxy from the desktop host (raw sockets are unavailable
/// inside the WebView, so the GUI invokes this). For an authorized main-window
/// caller, operational failures return a `reachable: false` result carrying the
/// diagnostic in `message`; unauthorized windows fail before native I/O.
#[tauri::command]
async fn proxy_test(
    window: tauri::WebviewWindow,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
) -> Result<ProxyTestResult, String> {
    ensure_main_gui_command(&window)?;
    // Run the blocking SOCKS5 probe on a dedicated blocking thread. A sync
    // command runs on the main thread, so a slow/dead proxy (multi-second
    // connect timeout inside run_socks5_probe) froze the ENTIRE WebView —
    // rendering + input + the "Testing…" spinner all stalled until it returned.
    // spawn_blocking keeps the UI (and the spinner) live while the probe runs.
    Ok(tauri::async_runtime::spawn_blocking(move || {
        match run_socks5_probe(&host, port, username.as_deref(), password.as_deref()) {
            Ok(result) => result,
            Err(message) => ProxyTestResult {
                reachable: false,
                auth_ok: false,
                udp_associate: false,
                can_route: false,
                connect_reply: 0xFF,
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
        can_route: false,
        connect_reply: 0xFF,
        latency_ms: 0,
        message: "Proxy test could not be scheduled — please retry.".to_string(),
    }))
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
async fn endpoint_resolve(
    window: tauri::WebviewWindow,
    host: String,
    port: u16,
) -> Result<EndpointResolveResult, String> {
    ensure_main_gui_command(&window)?;
    // to_socket_addrs() is a blocking DNS lookup; keep it off the main thread so
    // a slow resolver can't freeze the WebView (same class as proxy_test).
    Ok(tauri::async_runtime::spawn_blocking(move || {
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
    }))
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
    window: tauri::WebviewWindow,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
) -> Result<ProxyExitProbeResult, String> {
    ensure_main_gui_command(&window)?;
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
    fn native_command_origins_separate_main_gui_and_simulator_windows() {
        assert!(is_main_gui_command_caller(MAIN_GUI_IDENTIFIER, "main"));
        assert!(!is_main_gui_command_caller(
            MAIN_GUI_IDENTIFIER,
            "sim-agt_1"
        ));
        assert!(!is_main_gui_command_caller(SIMULATOR_IDENTIFIER, "main"));

        assert!(is_simulator_command_caller(SIMULATOR_IDENTIFIER, "main"));
        assert!(is_simulator_command_caller(
            SIMULATOR_IDENTIFIER,
            "sim-agt_1"
        ));
        assert!(!is_simulator_command_caller(
            SIMULATOR_IDENTIFIER,
            "sim-../../api_key"
        ));
        assert!(!is_simulator_command_caller(MAIN_GUI_IDENTIFIER, "main"));
        assert!(!is_simulator_command_caller(
            "dev.attacker.app",
            "sim-agt_1"
        ));
    }

    #[test]
    fn main_gui_secret_names_are_bounded_to_known_namespaces() {
        for key in [
            "api_key",
            "proxy_vault_key",
            "api_key:api.driftstack.dev",
            "api_key:localhost_3000",
            "proxy_secret:550e8400-e29b-41d4-a716-446655440000",
        ] {
            assert!(secret_command_caller_allowed(
                MAIN_GUI_IDENTIFIER,
                "main",
                key
            ));
        }
        for key in [
            "",
            "api_key:",
            "proxy_secret:../../api_key",
            "gui_control:agt_550e8400-e29b-41d4-a716-446655440000",
            "gui_control:agt/other",
            "arbitrary",
        ] {
            assert!(!secret_command_caller_allowed(
                MAIN_GUI_IDENTIFIER,
                "main",
                key
            ));
        }
        assert!(!secret_command_caller_allowed(
            MAIN_GUI_IDENTIFIER,
            "main",
            &format!("api_key:{}", "a".repeat(321)),
        ));
    }

    #[test]
    fn simulator_process_store_access_is_exactly_its_active_session() {
        let session = "agt_550e8400-e29b-41d4-a716-446655440000";
        assert!(simulator_control_key_caller_allowed(
            SIMULATOR_IDENTIFIER,
            "main",
            Some(session),
            session,
        ));
        assert!(simulator_control_key_caller_allowed(
            SIMULATOR_IDENTIFIER,
            &format!("sim-{session}"),
            None,
            session,
        ));
        for denied_session in ["agt_another-session", "../../api_key", ""] {
            assert!(!simulator_control_key_caller_allowed(
                SIMULATOR_IDENTIFIER,
                "main",
                Some(session),
                denied_session,
            ));
        }
        assert!(!simulator_control_key_caller_allowed(
            SIMULATOR_IDENTIFIER,
            "main",
            None,
            session,
        ));
        assert!(!simulator_control_key_caller_allowed(
            MAIN_GUI_IDENTIFIER,
            &format!("sim-{session}"),
            Some(session),
            session,
        ));
        // No Simulator window or main-GUI namespace can route a control key
        // back through durable OS Keychain commands.
        assert!(!secret_command_caller_allowed(
            SIMULATOR_IDENTIFIER,
            "main",
            &format!("gui_control:{session}"),
        ));
        assert!(!secret_command_caller_allowed(
            MAIN_GUI_IDENTIFIER,
            "main",
            &format!("gui_control:{session}"),
        ));
    }

    fn test_control_key(fill: char) -> String {
        format!("gck_{}", fill.to_string().repeat(32))
    }

    fn encode_simulator_query(query: &str) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(query)
    }

    fn decode_prepared_query(payload: &PreparedSimulatorPayload) -> String {
        use base64::Engine as _;
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(&payload.sanitized_b64)
                .expect("prepared base64"),
        )
        .expect("prepared UTF-8")
    }

    #[test]
    fn simulator_control_store_is_process_local_bounded_lru() {
        let now = Instant::now();
        let store = SimulatorControlKeyStore::default();
        let mut generations = Vec::new();
        for index in 0..MAX_SIMULATOR_CONTROL_KEYS {
            let session = format!("agt_{index}");
            generations.push(
                store
                    .store_at(
                        &format!("sim-{session}"),
                        &session,
                        test_control_key('a'),
                        now,
                        Duration::from_secs(60),
                    )
                    .expect("store"),
            );
        }
        // Read session zero to make it most-recently used, then force one
        // eviction. Session one is now the LRU and must disappear.
        assert!(store
            .load_at("sim-agt_0", "agt_0", generations[0], now)
            .unwrap()
            .is_some());
        let new_generation = store
            .store_at(
                "sim-agt_new",
                "agt_new",
                test_control_key('b'),
                now,
                Duration::from_secs(60),
            )
            .expect("store new");
        assert_eq!(
            store
                .load_at("sim-agt_1", "agt_1", generations[1], now)
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .load_at("sim-agt_0", "agt_0", generations[0], now)
                .unwrap(),
            Some(test_control_key('a'))
        );
        assert_eq!(
            store
                .load_at("sim-agt_new", "agt_new", new_generation, now)
                .unwrap(),
            Some(test_control_key('b'))
        );

        // A fresh store models a process restart and never resurrects keys.
        assert_eq!(
            SimulatorControlKeyStore::default()
                .load_at("sim-agt_0", "agt_0", generations[0], now)
                .unwrap(),
            None
        );
    }

    #[test]
    fn simulator_control_store_replaces_expires_and_deletes_exact_session() {
        let now = Instant::now();
        let store = SimulatorControlKeyStore::default();
        let first_generation = store
            .store_at(
                "main",
                "agt_exact",
                test_control_key('a'),
                now,
                Duration::from_secs(30),
            )
            .expect("store old");
        let second_generation = store
            .store_at(
                "main",
                "agt_exact",
                test_control_key('b'),
                now,
                Duration::from_secs(30),
            )
            .expect("replace");
        assert_eq!(
            store
                .load_at("main", "agt_exact", second_generation, now)
                .unwrap(),
            Some(test_control_key('b'))
        );
        assert_eq!(
            store
                .load_at("main", "agt_exact", first_generation, now)
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .load_at(
                    "main",
                    "agt_exact",
                    second_generation,
                    now + Duration::from_secs(31),
                )
                .unwrap(),
            None
        );

        let delete_generation = store
            .store_at(
                "main",
                "agt_exact",
                test_control_key('c'),
                now,
                Duration::from_secs(30),
            )
            .expect("store for delete");
        store
            .delete("main", "agt_exact", delete_generation)
            .expect("delete");
        assert_eq!(
            store
                .load_at("main", "agt_exact", delete_generation, now)
                .unwrap(),
            None
        );

        assert!(store
            .store_at(
                "main",
                "agt_bad",
                "not-a-control-key".to_string(),
                now,
                Duration::from_secs(30),
            )
            .is_err());

        let exhausted = SimulatorControlKeyStore::default();
        exhausted.shared.state.lock().unwrap().next_generation = MAX_WEBVIEW_SAFE_GENERATION;
        assert!(exhausted
            .store_at(
                "main",
                "agt_exact",
                test_control_key('a'),
                now,
                Duration::from_secs(30),
            )
            .is_err());
        assert!(exhausted.shared.state.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn simulator_control_store_reaps_idle_expiry_without_a_webview_access() {
        let store = SimulatorControlKeyStore::default();
        store
            .store_at(
                "main",
                "agt_idle",
                test_control_key('a'),
                Instant::now(),
                Duration::from_millis(5),
            )
            .expect("store");

        let deadline = Instant::now() + Duration::from_secs(1);
        let mut state = store.shared.state.lock().unwrap();
        while !state.entries.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "expiry owner did not reap idle key");
            let (next, result) = store.shared.changed.wait_timeout(state, remaining).unwrap();
            state = next;
            assert!(
                !result.timed_out() || state.entries.is_empty(),
                "expiry owner did not reap idle key"
            );
        }
    }

    #[test]
    fn simulator_payload_moves_control_key_into_exact_native_generation() {
        let wall_now_ms = 1_000_000_u128;
        let monotonic_now = Instant::now();
        let session = "agt_exact";
        let key = test_control_key('a');
        let input = encode_simulator_query(&format!(
            "window=simulator&session={session}&ws=wss%3A%2F%2Flive.example&token=secret-token&ck={key}&cke={}&base=https%3A%2F%2Fapi.driftstack.dev",
            wall_now_ms + 30_000
        ));
        let store = SimulatorControlKeyStore::default();

        let prepared = prepare_simulator_payload_at(
            &store,
            "main",
            session,
            &input,
            wall_now_ms,
            monotonic_now,
        )
        .expect("prepare");
        assert!(prepared.control_generation > 0);
        let query = decode_prepared_query(&prepared);
        let fields: Vec<&str> = query.split('&').collect();
        assert!(!fields.iter().any(|field| {
            matches!(
                field.split_once('=').map(|(name, _)| name),
                Some("ck") | Some("cke")
            )
        }));
        assert!(!query.contains(&key));
        assert!(fields
            .iter()
            .any(|field| *field == format!("cg={}", prepared.control_generation)));
        assert!(query.contains("token=secret-token"));
        assert_eq!(
            store
                .load_at("main", session, prepared.control_generation, monotonic_now,)
                .unwrap(),
            Some(key)
        );
        assert_eq!(
            store
                .load_at(
                    "sim-agt_exact",
                    session,
                    prepared.control_generation,
                    monotonic_now,
                )
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .load_at(
                    "main",
                    "agt_other",
                    prepared.control_generation,
                    monotonic_now,
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn simulator_payload_caps_api_expiry_at_twenty_four_hours() {
        let wall_now_ms = 10_000_u128;
        let monotonic_now = Instant::now();
        let session = "agt_expiry";
        let key = test_control_key('b');
        let input = encode_simulator_query(&format!(
            "window=simulator&session={session}&ck={key}&cke={}",
            wall_now_ms + (48 * 60 * 60 * 1_000)
        ));
        let store = SimulatorControlKeyStore::default();
        let prepared = prepare_simulator_payload_at(
            &store,
            &format!("sim-{session}"),
            session,
            &input,
            wall_now_ms,
            monotonic_now,
        )
        .expect("prepare");

        assert_eq!(
            store
                .load_at(
                    &format!("sim-{session}"),
                    session,
                    prepared.control_generation,
                    monotonic_now + SIMULATOR_CONTROL_KEY_TTL - Duration::from_millis(1),
                )
                .unwrap(),
            Some(key)
        );
        assert_eq!(
            store
                .load_at(
                    &format!("sim-{session}"),
                    session,
                    prepared.control_generation,
                    monotonic_now + SIMULATOR_CONTROL_KEY_TTL,
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn simulator_payload_generation_prevents_stale_load_or_delete() {
        let wall_now_ms = 50_000_u128;
        let monotonic_now = Instant::now();
        let session = "agt_reconnect";
        let store = SimulatorControlKeyStore::default();
        let prepare = |key: &str, now_ms: u128, now: Instant| {
            prepare_simulator_payload_at(
                &store,
                "main",
                session,
                &encode_simulator_query(&format!(
                    "window=simulator&session={session}&ck={key}&cke={}",
                    now_ms + 60_000
                )),
                now_ms,
                now,
            )
            .expect("prepare")
        };
        let old = prepare(&test_control_key('a'), wall_now_ms, monotonic_now);
        let current = prepare(
            &test_control_key('b'),
            wall_now_ms + 1,
            monotonic_now + Duration::from_millis(1),
        );
        assert_ne!(old.control_generation, current.control_generation);
        assert_eq!(
            store
                .load_at(
                    "main",
                    session,
                    old.control_generation,
                    monotonic_now + Duration::from_millis(2),
                )
                .unwrap(),
            None
        );
        store
            .delete("main", session, old.control_generation)
            .expect("stale delete");
        assert_eq!(
            store
                .load_at(
                    "main",
                    session,
                    current.control_generation,
                    monotonic_now + Duration::from_millis(2),
                )
                .unwrap(),
            Some(test_control_key('b'))
        );
        store
            .delete("main", session, current.control_generation)
            .expect("current delete");
        assert_eq!(
            store
                .load_at(
                    "main",
                    session,
                    current.control_generation,
                    monotonic_now + Duration::from_millis(2),
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn simulator_payload_rejects_ambiguous_or_invalid_control_fields() {
        let wall_now_ms = 100_000_u128;
        let monotonic_now = Instant::now();
        let session = "agt_exact";
        let key = test_control_key('a');
        let cases = [
            format!(
                "window=simulator&session=agt_other&ck={key}&cke={}",
                wall_now_ms + 1_000
            ),
            format!(
                "window=simulator&session={session}&session={session}&ck={key}&cke={}",
                wall_now_ms + 1_000
            ),
            format!(
                "window=simulator&session={session}&ck={key}&ck={key}&cke={}",
                wall_now_ms + 1_000
            ),
            format!(
                "window=simulator&session={session}&ck={key}&cke={}&cke={}",
                wall_now_ms + 1_000,
                wall_now_ms + 1_000
            ),
            format!("window=simulator&session={session}&ck={key}"),
            format!(
                "window=simulator&session={session}&cke={}",
                wall_now_ms + 1_000
            ),
            format!(
                "window=simulator&session={session}&ck=invalid&cke={}",
                wall_now_ms + 1_000
            ),
            format!("window=simulator&session={session}&ck={key}&cke={wall_now_ms}"),
            format!(
                "window=simulator&session={session}&ck={key}&cke={}&cg=7",
                wall_now_ms + 1_000
            ),
            // URLSearchParams would decode `%63k` to `ck`; native must reject
            // the irregular name instead of forwarding the secret field.
            format!(
                "window=simulator&session={session}&%63k={key}&cke={}",
                wall_now_ms + 1_000
            ),
        ];
        for query in cases {
            let store = SimulatorControlKeyStore::default();
            assert!(
                prepare_simulator_payload_at(
                    &store,
                    "main",
                    session,
                    &encode_simulator_query(&query),
                    wall_now_ms,
                    monotonic_now,
                )
                .is_err(),
                "accepted invalid handoff: {query}"
            );
            assert_eq!(store.shared.state.lock().unwrap().entries.len(), 0);
        }

        let mismatched_window = encode_simulator_query(&format!(
            "window=simulator&session={session}&ck={key}&cke={}",
            wall_now_ms + 1_000
        ));
        assert!(prepare_simulator_payload_at(
            &SimulatorControlKeyStore::default(),
            "sim-agt_other",
            session,
            &mismatched_window,
            wall_now_ms,
            monotonic_now,
        )
        .is_err());
    }

    #[test]
    fn simulator_payload_without_control_key_exposes_only_zero_generation() {
        let store = SimulatorControlKeyStore::default();
        let now = Instant::now();
        let previous_generation = store
            .store_at(
                "main",
                "agt_legacy",
                test_control_key('a'),
                now,
                Duration::from_secs(60),
            )
            .expect("previous credential");
        let prepared = prepare_simulator_payload_at(
            &store,
            "main",
            "agt_legacy",
            &encode_simulator_query("window=simulator&session=agt_legacy&token=t"),
            1_000,
            now,
        )
        .expect("legacy handoff");
        assert_eq!(prepared.control_generation, 0);
        assert_eq!(
            decode_prepared_query(&prepared),
            "window=simulator&session=agt_legacy&token=t&cg=0"
        );
        assert_eq!(
            store
                .load_at("main", "agt_legacy", previous_generation, now)
                .unwrap(),
            None
        );
        assert!(store.shared.state.lock().unwrap().entries.is_empty());
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
        assert!(!is_valid_b64_payload(
            &"A".repeat(MAX_SIM_PAYLOAD_B64_BYTES + 1)
        ));
    }

    #[test]
    fn sim_payload_path_stays_in_temp_dir_for_normal_ids() {
        // The canonical agent-session id (`agt_<uuid>`) maps to a clean
        // file name directly under the temp dir.
        let p = sim_payload_path("agt_00000000-0000-4000-8000-000000000001", "abc123-1");
        assert_eq!(p.parent(), Some(std::env::temp_dir().as_path()));
        assert_eq!(
            p.file_name().and_then(|n| n.to_str()),
            Some("driftstack-sim-agt_00000000-0000-4000-8000-000000000001-abc123-1.handoff"),
        );
    }

    #[test]
    fn sim_payload_label_rejects_traversal_and_separators() {
        assert!(!is_safe_session_label("../../etc/passwd"));
        assert!(!is_safe_session_label("agt_x/y"));
        assert!(!is_safe_session_label("agt_x\\y"));
        assert!(!is_safe_session_label(""));
        assert!(is_safe_handoff_id("abc123-1"));
        assert!(!is_safe_handoff_id("../../handoff"));
        assert!(!is_safe_handoff_id("not_hex"));
    }

    #[test]
    fn sim_payload_write_then_take_round_trips_and_unlinks() {
        let session = format!("test-roundtrip-{}", std::process::id());
        let payload = "d2luZG93PXNpbXVsYXRvcg==";
        let handoff = write_sim_payload(&session, payload).expect("write");
        // First take returns the complete payload and unlinks.
        let got = take_sim_payload(&session, &handoff.id).expect("take");
        assert_eq!(got.as_deref(), Some(payload));
        // Second take finds no file → None (single-use).
        let again = take_sim_payload(&session, &handoff.id).expect("take again");
        assert_eq!(again, None);
    }

    #[test]
    fn rapid_same_session_handoffs_have_independent_paths_and_consumers() {
        let session = format!("test-take-generation-{}", std::process::id());
        let old_payload = "b2xk";
        let new_payload = "bmV3ZXItc3VjY2Vzc29y";
        let old = write_sim_payload(&session, old_payload).expect("old write");
        let new = write_sim_payload(&session, new_payload).expect("successor write");
        assert_ne!(old.id, new.id);
        assert_ne!(old.path, new.path);

        let opened = take_sim_payload(&session, &old.id).expect("take old");
        assert_eq!(opened.as_deref(), Some(old_payload));
        assert!(!old.path.exists());
        assert!(new.path.exists(), "old reader deleted successor handoff");
        assert_eq!(
            take_sim_payload(&session, &new.id)
                .expect("take successor")
                .as_deref(),
            Some(new_payload)
        );
        assert!(!new.path.exists());
    }

    #[test]
    fn stale_cleanup_never_deletes_a_newer_handoff_generation() {
        let session = format!("test-generation-{}", std::process::id());
        let old = write_sim_payload(&session, "b2xk").expect("old write");
        let new = write_sim_payload(&session, "bmV3").expect("new write");

        remove_sim_payload_if_identity(&old.path, old.identity);
        assert!(!old.path.exists());
        assert!(new.path.exists());
        assert_eq!(
            take_sim_payload(&session, &new.id)
                .expect("take")
                .as_deref(),
            Some("bmV3")
        );
    }

    #[test]
    fn sim_payload_metadata_failure_removes_owned_credential_file() {
        let session = format!("test-metadata-failure-{}", std::process::id());
        let path = sim_payload_path(&session, "abc123-5");
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, "d2luZG93PXNpbXVsYXRvcg==").expect("fixture");
        let error = sim_payload_identity_or_cleanup(
            &path,
            Err(std::io::Error::other("deterministic fstat failure")),
        )
        .expect_err("metadata failure");
        assert!(error.contains("deterministic fstat failure"));
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn sim_payload_write_uses_owner_only_0600_mode() {
        use std::os::unix::fs::PermissionsExt as _;
        let session = format!("test-perms-{}", std::process::id());
        let handoff = write_sim_payload(&session, "YWJjMTIz").expect("write");
        let mode = std::fs::metadata(&handoff.path)
            .unwrap()
            .permissions()
            .mode();
        // Low 9 bits = rwx for owner/group/other; expect 0600.
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_file(&handoff.path);
    }

    #[cfg(unix)]
    #[test]
    fn sim_payload_take_rejects_symlink_without_unlinking_unknown_generation() {
        use std::os::unix::fs::symlink;
        let session = format!("test-symlink-{}", std::process::id());
        let handoff_id = "abc123-1";
        let path = sim_payload_path(&session, handoff_id);
        let target =
            std::env::temp_dir().join(format!(".driftstack-sim-target-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&target);
        std::fs::write(&target, "d2luZG93PXNpbXVsYXRvcg==").expect("target");
        symlink(&target, &path).expect("symlink");

        assert!(take_sim_payload(&session, handoff_id).is_err());
        // A failed open has no trusted generation identity, so it must not
        // broadly unlink a path that a same-session writer could replace.
        assert!(path.symlink_metadata().is_ok());
        assert!(target.exists());
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(target);
    }

    #[cfg(unix)]
    #[test]
    fn sim_payload_take_rejects_non_owner_permissions() {
        use std::os::unix::fs::PermissionsExt as _;
        let session = format!("test-open-perms-{}", std::process::id());
        let handoff_id = "abc123-2";
        let path = sim_payload_path(&session, handoff_id);
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, "d2luZG93PXNpbXVsYXRvcg==").expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("permissions");

        assert!(take_sim_payload(&session, handoff_id).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn sim_payload_take_missing_is_none_not_error() {
        let session = format!("test-missing-{}", std::process::id());
        let handoff_id = "abc123-3";
        let _ = std::fs::remove_file(sim_payload_path(&session, handoff_id));
        // No file written → Ok(None), never Err.
        assert_eq!(take_sim_payload(&session, handoff_id).expect("take"), None);
    }

    #[test]
    fn simulator_process_args_contain_only_non_secret_routing_ids() {
        let args = simulator_open_args(
            "/Applications/Driftstack Simulator.app",
            "agt_00000000-0000-4000-8000-000000000001",
            "abc123-4",
        );
        assert_eq!(
            args,
            vec![
                "-n",
                "-a",
                "/Applications/Driftstack Simulator.app",
                "--args",
                "--ds-label=agt_00000000-0000-4000-8000-000000000001",
                "--ds-handoff=abc123-4",
            ],
        );
        assert!(!args.iter().any(|arg| arg.contains("token=")));
        assert!(!args.iter().any(|arg| arg.contains("ck=")));
        assert_eq!(
            simulator_launch_handoff(&args),
            Some((
                "agt_00000000-0000-4000-8000-000000000001".to_string(),
                "abc123-4".to_string(),
            ))
        );

        for malformed in [
            vec!["--ds-label=agt_1".to_string()],
            vec![
                "--ds-label=agt_1".to_string(),
                "--ds-handoff=../../secret".to_string(),
            ],
            vec![
                "--ds-label=agt_1".to_string(),
                "--ds-label=agt_2".to_string(),
                "--ds-handoff=abc123".to_string(),
            ],
            vec![
                "--ds-label=agt_1".to_string(),
                "--ds-handoff=abc123".to_string(),
                "--ds-handoff=def456".to_string(),
            ],
        ] {
            assert_eq!(simulator_launch_handoff(&malformed), None);
        }
    }

    #[test]
    fn main_gui_deep_links_forward_only_bounded_clean_driftstack_urls() {
        let valid = "driftstack://session/open?session_id=agt_123".to_string();
        let argv = vec![
            "/Applications/Driftstack.app/Contents/MacOS/driftstack-gui".to_string(),
            "https://attacker.invalid/".to_string(),
            "--ds-label=agt_123".to_string(),
            "driftstack://session/open\n?session_id=agt_bad".to_string(),
            format!("driftstack://session/open?session_id={}", "a".repeat(8_192)),
            valid.clone(),
        ];

        assert_eq!(main_gui_deep_links(&argv), vec![valid]);
    }

    #[test]
    fn main_gui_deep_links_cap_each_second_instance_batch() {
        let argv = (0..12)
            .map(|index| format!("driftstack://session/open?session_id=agt_{index}"))
            .collect::<Vec<_>>();
        let links = main_gui_deep_links(&argv);

        assert_eq!(links.len(), MAX_MAIN_GUI_DEEP_LINKS);
        assert_eq!(
            links.first().map(String::as_str),
            Some("driftstack://session/open?session_id=agt_0")
        );
        assert_eq!(
            links.last().map(String::as_str),
            Some("driftstack://session/open?session_id=agt_7")
        );
    }
}
