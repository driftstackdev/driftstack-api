// W617 — drift guard for apps/gui-client/src-tauri/ (Tauri-side source, 7 files).
// Skips generated gen/schemas/*.json. Pins the Rust crate manifest,
// build script, library entry, main binary, capabilities allow-list,
// rust-toolchain pin + tauri.conf.json bundle config.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const T = (rel: string) => resolve(REPO_ROOT, `apps/gui-client/src-tauri/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const DESKTOP_CSP = {
  'default-src': "'self' customprotocol: asset:",
  'connect-src': 'ipc: http://ipc.localhost http: https: ws: wss:',
  'font-src': "'self' data:",
  'img-src': "'self' asset: http://asset.localhost blob: data: http: https:",
  'media-src': "'self' asset: http://asset.localhost blob: data: http: https:",
  'style-src': "'self' 'unsafe-inline'",
  'script-src': "'self'",
  'worker-src': "'self' blob:",
  'object-src': "'none'",
  'base-uri': "'none'",
  'frame-src': "'none'",
  'frame-ancestors': "'none'",
  'form-action': "'none'",
} as const;

describe('W617 apps/gui-client/src-tauri/ content parity', () => {
  it('build.rs: thin tauri-build invocation pinned', () => {
    const body = read(T('build.rs'));
    expect(body).toMatch(/^fn main\(\) \{$/m);
    expect(body).toMatch(/^\s+tauri_build::build\(\)$/m);
    expect(body).toMatch(/^\}$/m);
    expect(existsSync(T('build.rs'))).toBe(true);
  });

  it('Cargo.toml: driftstack-gui crate 0.1.6 MIT non-publish + lib triplet (staticlib/cdylib/rlib) + Tauri 2.0 + plugins + zeroize process-memory control keys + V-241 keyring + custom-protocol pinned', () => {
    const body = read(T('Cargo.toml'));
    expect(body).toMatch(/^\[package\]$/m);
    expect(body).toMatch(/^name = "driftstack-gui"$/m);
    expect(body).toMatch(/^version = "0\.1\.6"$/m);
    expect(body).toMatch(/^description = "Driftstack self-hosted GUI client"$/m);
    expect(body).toMatch(/^edition = "2021"$/m);
    expect(body).toMatch(/^license = "MIT"$/m);
    expect(body).toMatch(
      /^publish = false\s+# binary, not a library; never published to crates\.io$/m,
    );
    expect(body).toMatch(/^\[lib\]$/m);
    expect(body).toMatch(/^name = "driftstack_gui_lib"$/m);
    expect(body).toMatch(/^crate-type = \["staticlib", "cdylib", "rlib"\]$/m);
    expect(body).toMatch(/^\[build-dependencies\]$/m);
    expect(body).toMatch(/^tauri-build = \{ version = "2\.0", features = \[\] \}$/m);
    expect(body).toMatch(/^\[dependencies\]$/m);
    // The macos-private-api feature is REQUIRED by tauri.conf.json
    // app.macOSPrivateApi=true (the floating-iPhone simulator window's
    // transparency, founder 2026-06-11). Dropping it fails the build's
    // macOSPrivateApi check.
    expect(body).toMatch(/^tauri = \{ version = "2\.0", features = \["macos-private-api"\] \}$/m);
    expect(body).toMatch(/^tauri-plugin-shell = "2\.0"$/m);
    expect(body).toMatch(/^tauri-plugin-store = "2\.0"$/m);
    expect(body).toMatch(/^tauri-plugin-fs = "2\.0"$/m);
    expect(body).toMatch(
      /V-243 \/ D-2026-05-06-03 — Tauri Updater for cross-platform auto-update\./,
    );
    expect(body).toMatch(/^tauri-plugin-updater = "2\.0"$/m);
    expect(body).toMatch(/^tauri-plugin-process = "2\.0"$/m);
    expect(body).toMatch(/V-328 — custom URL scheme deep-link plugin\./);
    expect(body).toMatch(/`driftstack:\/\/`/);
    expect(body).toMatch(/^tauri-plugin-deep-link = "2\.0"$/m);
    expect(body).toMatch(/^serde = \{ version = "1\.0", features = \["derive"\] \}$/m);
    expect(body).toMatch(/^serde_json = "1\.0"$/m);
    expect(body).toMatch(
      /Short-lived per-session simulator control credentials never need durable OS/,
    );
    expect(body).toMatch(/bounded process-memory copies zeroized on/);
    expect(body).toMatch(/^zeroize = "1"$/m);
    expect(body).toMatch(/V-241 T3 #1 \(D-2026-05-06-01\): keyring-rs for cross-platform OS/);
    expect(body).toMatch(
      /^keyring = \{ version = "3", features = \["apple-native", "windows-native", "sync-secret-service"\] \}$/m,
    );
    expect(body).toMatch(/^\[features\]$/m);
    expect(body).toMatch(/^default = \["custom-protocol"\]$/m);
    expect(body).toMatch(/^custom-protocol = \["tauri\/custom-protocol"\]$/m);
    expect(existsSync(T('Cargo.toml'))).toBe(true);
  });

  it('rust-toolchain.toml: V-240 channel=1.95.0 + profile=minimal + components=[clippy, rustfmt] pinned', () => {
    const body = read(T('rust-toolchain.toml'));
    expect(body).toMatch(/^# V-240 — pin Rust toolchain for reproducible contributor builds\.$/m);
    expect(body).toMatch(/README \("Prerequisites: Node 22\+, Rust 1\.95\+"\) was the soft floor;/);
    expect(body).toMatch(/^\[toolchain\]$/m);
    expect(body).toMatch(/^channel = "1\.95\.0"$/m);
    expect(body).toMatch(/^profile = "minimal"$/m);
    expect(body).toMatch(/^components = \["clippy", "rustfmt"\]$/m);
    expect(existsSync(T('rust-toolchain.toml'))).toBe(true);
  });

  it('src/main.rs: thin entry + windows_subsystem cfg_attr non-debug + driftstack_gui_lib::run() invocation pinned', () => {
    const body = read(T('src/main.rs'));
    expect(body).toMatch(/^\/\/ Tauri main entry\. Keep this file thin — the bulk of the Rust$/m);
    expect(body).toMatch(
      /^\/\/ backend lives in lib\.rs so it can be built as a library for tests$/m,
    );
    expect(body).toMatch(
      /^#!\[cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)\]$/m,
    );
    expect(body).toMatch(/^fn main\(\) \{$/m);
    expect(body).toMatch(/^\s+driftstack_gui_lib::run\(\)$/m);
    expect(existsSync(T('src/main.rs'))).toBe(true);
  });

  it('src/lib.rs: durable API/proxy Keychain and bounded Simulator process-memory credentials remain separate', () => {
    const body = read(T('src/lib.rs'));
    expect(body).toMatch(/^\/\/! Driftstack GUI — Tauri backend library\.$/m);
    expect(body).toMatch(/^\/\/! {3}\* `ping` — health probe\.$/m);
    expect(body).toMatch(
      /^\/\/! {3}\* `secret_save` \/ `secret_load` \/ `secret_delete` \(V-241 T3 #1\) —$/m,
    );
    expect(body).toMatch(/^\/\/! {5}cross-platform OS-keychain access for the API key\./m);
    expect(body).toMatch(/^\/\/! {5}uses macOS Keychain, Windows Credential Manager, or$/m);
    expect(body).toMatch(/^\/\/! {5}Linux Secret Service \/ KWallet via the `keyring` crate\.$/m);
    expect(body).toMatch(
      /^\/\/! {3}\* `simulator_control_key_\*` — bounded, zeroizing, process-memory-only$/m,
    );
    expect(body).toMatch(
      /^\/\/! {5}storage for short-lived per-session Simulator control credentials\.$/m,
    );
    expect(body).toMatch(/^use keyring::Entry;$/m);
    expect(body).toMatch(/^use zeroize::\{Zeroize, Zeroizing\};$/m);
    expect(body).toMatch(/^const KEYRING_SERVICE: &str = "dev\.driftstack\.gui";$/m);
    expect(body).toMatch(/^const KEYRING_USER: &str = "default";$/m);
    expect(body).toMatch(/^#\[cfg_attr\(mobile, tauri::mobile_entry_point\)\]$/m);
    expect(body).toMatch(/^pub fn run\(\) \{$/m);
    expect(body).toMatch(/tauri::Builder::default\(\)/);
    expect(body).toMatch(/\.plugin\(tauri_plugin_shell::init\(\)\)/);
    expect(body).toMatch(/\.plugin\(tauri_plugin_store::Builder::new\(\)\.build\(\)\)/);
    expect(body).toMatch(/\.plugin\(tauri_plugin_fs::init\(\)\)/);
    expect(body).toMatch(/V-243 \/ D-2026-05-06-03 — auto-update via Tauri Updater\./);
    expect(body).toMatch(/\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/);
    // V-243 — process plugin (relaunch() after an update install).
    expect(body).toMatch(/\.plugin\(tauri_plugin_process::init\(\)\)/);
    expect(body).toMatch(/V-328 — register the `driftstack:\/\/` URL scheme/);
    expect(body).toMatch(/\.plugin\(tauri_plugin_deep_link::init\(\)\)/);
    expect(body).toMatch(/\.invoke_handler\(tauri::generate_handler!\[/);
    expect(body).toMatch(/^\s+ping,$/m);
    expect(body).toMatch(/^\s+secret_save,$/m);
    expect(body).toMatch(/^\s+secret_load,$/m);
    expect(body).toMatch(/^\s+secret_delete,$/m);
    expect(body).toMatch(/^\s+simulator_control_key_load,$/m);
    expect(body).toMatch(/^\s+simulator_control_key_delete,$/m);
    expect(body).not.toMatch(/^\s+simulator_control_key_store,$/m);
    expect(body).toMatch(/\.expect\("error while running tauri application"\);/);
    expect(body).toMatch(/^#\[tauri::command\]$/m);
    expect(body).toMatch(/^fn ping\(\) -> &'static str \{$/m);
    expect(body).toMatch(/^\s+"pong"$/m);
    expect(body).toMatch(/^fn secret_save\(/m);
    expect(body).toMatch(
      /fn secret_save\([\s\S]*?window: tauri::WebviewWindow,[\s\S]*?ensure_secret_command\(&window, &key\)\?;/,
    );
    expect(body).toMatch(/let user = format!\("\{KEYRING_USER\}:\{key\}"\);/);
    expect(body).toMatch(
      /let entry = Entry::new\(KEYRING_SERVICE, &user\)\.map_err\(\|e\| e\.to_string\(\)\)\?;/,
    );
    expect(body).toMatch(/entry\.set_password\(&value\)\.map_err\(\|e\| e\.to_string\(\)\)\?;/);
    expect(body).toMatch(/^fn secret_load\(/m);
    expect(body).toMatch(
      /fn secret_load\([\s\S]*?window: tauri::WebviewWindow,[\s\S]*?ensure_secret_command\(&window, &key\)\?;/,
    );
    expect(body).toMatch(/Err\(keyring::Error::NoEntry\) => Ok\(None\),/);
    expect(body).toMatch(/^fn secret_delete\(/m);
    expect(body).toMatch(
      /fn secret_delete\([\s\S]*?window: tauri::WebviewWindow,[\s\S]*?ensure_secret_command\(&window, &key\)\?;/,
    );
    expect(body).toMatch(/Err\(keyring::Error::NoEntry\) => Ok\(\(\)\),/);
    expect(body).toMatch(/^#\[cfg\(test\)\]$/m);
    expect(body).toMatch(/^mod tests \{$/m);
    expect(body).toMatch(/fn keyring_user_prefix_is_stable\(\) \{/);
    expect(body).toMatch(/assert_eq!\(user, "default:api_key"\);/);
    expect(body).toMatch(/fn keyring_service_matches_tauri_bundle_id\(\) \{/);
    expect(body).toMatch(/assert_eq!\(KEYRING_SERVICE, "dev\.driftstack\.gui"\);/);
    expect(existsSync(T('src/lib.rs'))).toBe(true);
  });

  it('CRITICAL locally registered commands enforce main-Keychain vs exact Simulator process-memory origins', () => {
    const body = read(T('src/lib.rs'));
    const commandSource = (name: string): string => {
      const start = body.search(new RegExp(`(?:async )?fn ${name}\\(`));
      expect(start).toBeGreaterThanOrEqual(0);
      const next = body.indexOf('\n#[tauri::command]', start + 1);
      return body.slice(start, next < 0 ? body.length : next);
    };

    expect(body).toMatch(/^const MAIN_GUI_IDENTIFIER: &str = "dev\.driftstack\.gui";$/m);
    expect(body).toMatch(/^const SIMULATOR_IDENTIFIER: &str = "dev\.driftstack\.simulator";$/m);
    expect(body).toMatch(
      /fn is_main_gui_command_caller\([\s\S]*?app_identifier == MAIN_GUI_IDENTIFIER && window_label == "main"/,
    );
    expect(body).toMatch(/fn is_valid_main_gui_secret_key\([\s\S]*?key == "api_key"/);
    expect(body).toMatch(/fn is_valid_main_gui_secret_key\([\s\S]*?key == "proxy_vault_key"/);
    expect(body).toMatch(/fn is_valid_main_gui_secret_key\([\s\S]*?strip_prefix\("api_key:"\)/);
    expect(body).toMatch(
      /fn is_valid_main_gui_secret_key\([\s\S]*?strip_prefix\("proxy_secret:"\)/,
    );
    const mainSecretValidator = body.slice(
      body.indexOf('fn is_valid_main_gui_secret_key('),
      body.indexOf('\n}\n', body.indexOf('fn is_valid_main_gui_secret_key(')) + 2,
    );
    expect(mainSecretValidator).not.toContain('gui_control');
    expect(body).toMatch(
      /fn secret_command_caller_allowed\([\s\S]*?is_main_gui_command_caller\(app_identifier, window_label\)[\s\S]*?is_valid_main_gui_secret_key\(key\)/,
    );
    expect(body).toMatch(
      /fn ensure_secret_command\([\s\S]*?secret_command_caller_allowed\(app_identifier, window\.label\(\), key\)[\s\S]*?Err\(COMMAND_ACCESS_DENIED\.to_string\(\)\)/,
    );
    for (const command of ['secret_save', 'secret_load', 'secret_delete']) {
      const source = commandSource(command);
      expect(source).toMatch(/window: tauri::WebviewWindow/);
      expect(source).not.toMatch(/MainSession/);
      expect(source).toMatch(/ensure_secret_command\(&window, &key\)\?;/);
    }
    for (const command of ['simulator_control_key_load', 'simulator_control_key_delete']) {
      const source = commandSource(command);
      expect(source).toMatch(/window: tauri::WebviewWindow/);
      expect(source).toMatch(/main_session: tauri::State<'_, MainSession>/);
      expect(source).toMatch(/control_keys: tauri::State<'_, SimulatorControlKeyStore>/);
      expect(source).toMatch(/session_id: String/);
      expect(source).toMatch(/generation: u64/);
      expect(source).toMatch(
        /ensure_simulator_control_key_command\(&window, &main_session, &session_id\)\?;/,
      );
    }
    for (const command of ['launch_simulator', 'proxy_test', 'endpoint_resolve']) {
      const source = commandSource(command);
      expect(source).toMatch(/window: tauri::WebviewWindow/);
      expect(source).toMatch(/ensure_main_gui_command\(&window\)\?;/);
    }
    const exitProbe = commandSource('proxy_exit_probe');
    expect(exitProbe).toMatch(/window: tauri::WebviewWindow/);
    expect(exitProbe).toMatch(/ensure_main_gui_command\(&window\)\?;/);
    for (const command of ['set_dock_tile', 'reset_dock_tile']) {
      const source = commandSource(command);
      expect(source).toMatch(/window: tauri::WebviewWindow/);
      expect(source).toMatch(/ensure_simulator_command\(&window\)\?;/);
    }
    expect(body).toMatch(/fn simulator_process_store_access_is_exactly_its_active_session\(\)/);
    expect(body).toMatch(/fn native_command_origins_separate_main_gui_and_simulator_windows\(\)/);
  });

  it('CRITICAL Simulator control keys are native-first, generation-bound, bounded, expiring, and zeroizing', () => {
    const body = read(T('src/lib.rs'));
    const production = body.slice(0, body.indexOf('\n#[cfg(test)]'));
    const source = (startNeedle: string, endNeedle: string): string => {
      const start = production.indexOf(startNeedle);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = production.indexOf(endNeedle, start + startNeedle.length);
      expect(end).toBeGreaterThan(start);
      return production.slice(start, end);
    };

    expect(body).toMatch(/^const MAX_SIMULATOR_CONTROL_KEYS: usize = 32;$/m);
    expect(body).toMatch(
      /^const SIMULATOR_CONTROL_KEY_TTL: Duration = Duration::from_secs\(24 \* 60 \* 60\);$/m,
    );
    expect(body).toMatch(/^const MAX_WEBVIEW_SAFE_GENERATION: u64 = 9_007_199_254_740_991;$/m);
    expect(body).toMatch(
      /struct SimulatorControlKeyEntry \{[\s\S]*?window_label: String,[\s\S]*?session_id: String,[\s\S]*?generation: u64,[\s\S]*?value: Zeroizing<String>,[\s\S]*?expires_at: Instant,/,
    );
    expect(body).toMatch(/\.manage\(SimulatorControlKeyStore::default\(\)\)/);
    expect(body).toMatch(
      /struct SimulatorControlKeyShared \{[\s\S]*?state: std::sync::Mutex<SimulatorControlKeyState>,[\s\S]*?changed: std::sync::Condvar,/,
    );
    expect(body).toMatch(
      /struct SimulatorControlKeyStore \{[\s\S]*?shared: std::sync::Arc<SimulatorControlKeyShared>,[\s\S]*?expiry_reaper: Option<std::thread::JoinHandle<\(\)>>,/,
    );
    expect(body).toMatch(
      /impl Default for SimulatorControlKeyStore \{[\s\S]*?spawn\(move \|\| Self::run_expiry_reaper\(reaper_shared\)\)/,
    );
    expect(body).toMatch(
      /impl Drop for SimulatorControlKeyStore \{[\s\S]*?state\.shutting_down = true;[\s\S]*?changed\.notify_all\(\);[\s\S]*?reaper\.join\(\)/,
    );

    const store = source(
      'impl SimulatorControlKeyStore {',
      '\n}\n\nstruct PreparedSimulatorPayload',
    );
    expect(store).toMatch(/fn wipe_entry\([\s\S]*?entry\.value\.zeroize\(\);/);
    expect(store).toMatch(
      /fn run_expiry_reaper\([\s\S]*?purge_expired\(&mut state\.entries, Instant::now\(\)\)[\s\S]*?map\(\|entry\| entry\.expires_at\)\.min\(\)[\s\S]*?wait_timeout\(state, wait\)/,
    );
    expect(store).toMatch(
      /fn purge_expired\([\s\S]*?entries\[index\]\.expires_at <= now[\s\S]*?Self::wipe_entry\(entry\)/,
    );
    expect(store).toMatch(
      /fn store_at\([\s\S]*?entry\.window_label == window_label[\s\S]*?Self::wipe_entry\(entry\)[\s\S]*?state\.next_generation = state[\s\S]*?\.checked_add\(1\)[\s\S]*?generation exhausted/,
    );
    // Wrap the incoming allocation before validation/locking so every early
    // return zeroizes it, then move that Zeroizing value into the entry.
    expect(store).toMatch(
      /let value = Zeroizing::new\(value\);[\s\S]*?SimulatorControlKeyEntry \{[\s\S]*?\n\s*value,/,
    );
    expect(store).toMatch(/expires_at: now \+ ttl\.min\(SIMULATOR_CONTROL_KEY_TTL\)/);
    expect(store).toMatch(
      /while state\.entries\.len\(\) > MAX_SIMULATOR_CONTROL_KEYS \{[\s\S]*?pop_front\(\)[\s\S]*?Self::wipe_entry\(entry\)/,
    );
    expect(store).toMatch(
      /fn load_at\([\s\S]*?entry\.window_label == window_label[\s\S]*?entry\.session_id == session_id[\s\S]*?entry\.generation == generation/,
    );
    expect(store).toMatch(
      /\/\/ Successful reads refresh only LRU order, never the original expiry\.[\s\S]*?state\.entries\.push_back\(entry\)/,
    );
    expect(store).toMatch(
      /fn delete\([\s\S]*?entry\.window_label == window_label[\s\S]*?entry\.session_id == session_id[\s\S]*?entry\.generation == generation[\s\S]*?Self::wipe_entry\(entry\)/,
    );

    const prepare = source(
      'fn prepare_simulator_payload_at(',
      '\n}\n\nfn prepare_simulator_payload(',
    );
    expect(prepare).toMatch(/"ck" =>/);
    expect(prepare).toMatch(/"cke" =>/);
    expect(prepare).toMatch(
      /"cg" => return Err\("invalid simulator control generation"\.to_string\(\)\)/,
    );
    expect(prepare).toMatch(/if handoff_session != Some\(session_label\)/);
    expect(prepare).toMatch(/if expires_ms <= wall_now_ms/);
    expect(prepare).toMatch(/control_keys\.store_at\(/);
    expect(prepare).toMatch(/sanitized\.push\(format!\("cg=\{generation\}"\)\)/);
    expect(prepare.indexOf('control_keys.store_at(')).toBeLessThan(
      prepare.indexOf('sanitized.push(format!("cg={generation}"))'),
    );
    expect(prepare).toMatch(/simulator credential sanitization failed/);
    expect(production).not.toMatch(/fn simulator_control_key_store\(/);

    expect(body).toMatch(/fn simulator_control_store_is_process_local_bounded_lru\(\)/);
    expect(body).toMatch(
      /fn simulator_control_store_replaces_expires_and_deletes_exact_session\(\)/,
    );
    expect(body).toMatch(
      /fn simulator_control_store_reaps_idle_expiry_without_a_webview_access\(\)/,
    );
  });

  it('CRITICAL protected handoff is owner-only transit and never exposes ck/cke to a WebView URL/event', () => {
    const body = read(T('src/lib.rs'));
    expect(body).toMatch(
      /query \(LiveKit JWT \+ session control key\) is atomically written to a 0600[\s\S]*?single-use handoff file/,
    );
    expect(body).toMatch(/OpenOptions::new\(\)[\s\S]*?\.create_new\(true\)[\s\S]*?\.mode\(0o600\)/);
    expect(body).toMatch(/options\.custom_flags\(libc::O_NOFOLLOW\)/);
    expect(body).toMatch(
      /\/\/ The open handle remains valid after unlink[\s\S]*?std::fs::remove_file\(&path\)/,
    );
    expect(body).toMatch(/metadata\.permissions\(\)\.mode\(\) & 0o077 != 0/);
    expect(body).toMatch(/remove_sim_payload_if_identity/);
    expect(body).toMatch(
      /let identity = sim_payload_identity_or_cleanup\(&path, file\.metadata\(\)\)\?;/,
    );
    expect(body).toMatch(/fn sim_payload_metadata_failure_removes_owned_credential_file\(\)/);
    const takeStart = body.indexOf('fn take_sim_payload(');
    const takeEnd = body.indexOf('\n}\n\n/// Set the running app', takeStart);
    expect(takeStart).toBeGreaterThanOrEqual(0);
    expect(takeEnd).toBeGreaterThan(takeStart);
    const takePayload = body.slice(takeStart, takeEnd);
    expect(takePayload).toMatch(
      /let opened_identity = sim_payload_identity_from_metadata\(&metadata\);[\s\S]*?remove_sim_payload_if_identity\(&path, opened_identity\)/,
    );
    expect(body).toMatch(
      /fn simulator_launch_handoff\([\s\S]*?"--ds-label="[\s\S]*?"--ds-handoff="/,
    );
    expect(body).toMatch(
      /fn simulator_open_args\([\s\S]*?--ds-label=\{session_label\}[\s\S]*?--ds-handoff=\{handoff_id\}/,
    );
    expect(body).toMatch(
      /fn sim_payload_path\(session_label: &str, handoff_id: &str\)[\s\S]*?driftstack-sim-\{session_label\}-\{handoff_id\}\.handoff/,
    );
    expect(body).toMatch(
      /fn write_sim_payload\([\s\S]*?new_sim_handoff_id\(\)[\s\S]*?options\.write\(true\)\.create_new\(true\)/,
    );
    expect(body).toMatch(/fn rapid_same_session_handoffs_have_independent_paths_and_consumers\(\)/);
    expect(body).toMatch(/fn simulator_process_args_contain_only_non_secret_routing_ids\(\)/);
    const singleInstance = body.slice(
      body.indexOf('.plugin(tauri_plugin_single_instance::init'),
      body.indexOf('.plugin(tauri_plugin_shell::init'),
    );
    expect(
      singleInstance.indexOf('if app.config().identifier == "dev.driftstack.simulator"'),
    ).toBeLessThan(singleInstance.indexOf('take_sim_payload('));
    expect(body).toMatch(/prepared\.sanitized_b64/);
    expect(body).toMatch(/prepared\.control_generation/);
    expect(body).toMatch(/attach_control_key_cleanup\(/);
    expect(body).toMatch(
      /matches!\(event, tauri::WindowEvent::Destroyed\)[\s\S]*?SimulatorControlKeyStore[\s\S]*?\.delete\(/,
    );
  });

  it('capabilities/default.json + updater-windows-linux.json: main permissions stay least-privilege and updater install/relaunch is Windows/Linux-only', () => {
    const body = read(T('capabilities/default.json'));
    const capability = JSON.parse(body) as {
      $schema: string;
      identifier: string;
      description: string;
      windows: string[];
      permissions: Array<
        | string
        | {
            identifier: string;
            allow?: Array<{ url?: string }>;
          }
      >;
    };
    expect(capability).toMatchObject({
      $schema: '../gen/schemas/desktop-schema.json',
      identifier: 'default',
      description:
        'Default capabilities granted to the main window — only the surfaces the GUI actually needs.',
      windows: ['main'],
    });
    expect(capability.permissions).not.toContain('updater:default');
    expect(capability.permissions).not.toContain('process:default');

    const updaterCapability = JSON.parse(read(T('capabilities/updater-windows-linux.json'))) as {
      $schema: string;
      identifier: string;
      description: string;
      windows: string[];
      permissions: string[];
      platforms: string[];
    };
    expect(updaterCapability).toEqual({
      $schema: '../gen/schemas/desktop-schema.json',
      identifier: 'updater-windows-linux',
      description:
        'Updater install and relaunch permissions for the main Windows and Linux app only. macOS is intentionally excluded so a minisign-only updater artifact cannot replace the stable OS-signed bundle and change its code requirement.',
      windows: ['main'],
      permissions: ['updater:default', 'process:default'],
      platforms: ['windows', 'linux'],
    });
    expect(updaterCapability.platforms).not.toContain('macOS');

    const simulatorCapability = JSON.parse(read(T('capabilities/simulator-app.json'))) as {
      description: string;
      permissions: Array<string | { identifier: string }>;
    };
    expect(simulatorCapability.permissions).not.toContain('updater:default');
    expect(simulatorCapability.permissions).not.toContain('process:default');
    expect(simulatorCapability.description).toContain('owner-only 0600 single-use handoff file');
    expect(simulatorCapability.description).toContain('unique `--ds-handoff` routing arguments');
    expect(simulatorCapability.description).toContain('Each launch uses a distinct file path');
    expect(simulatorCapability.description).toContain('bounded process-memory store first');
    expect(simulatorCapability.description).toContain('only the non-secret `cg` generation');
    expect(simulatorCapability.description).toContain('simulator_control_key_load');
    expect(simulatorCapability.description).toContain('simulator_control_key_delete');
    expect(simulatorCapability.description).toContain(
      'generic `secret_save` / `secret_load` / `secret_delete` OS-Keychain commands deny the Simulator bundle',
    );

    expect(body).toMatch(/"core:default"/);
    expect(body).toMatch(/"core:window:default"/);
    // start-dragging: the TitleBar uses data-tauri-drag-region, which invokes the
    // window|start_dragging command — absent this permission the call is rejected
    // by the ACL (surfaced as a fatal UNHANDLED_REJECTION at runtime).
    expect(body).toMatch(/"core:window:allow-start-dragging"/);
    expect(body).toMatch(/"core:webview:default"/);
    expect(body).toMatch(/"core:event:default"/);
    expect(body).toMatch(/"core:app:default"/);
    expect(body).toMatch(/"core:resources:default"/);
    expect(body).toMatch(/"core:menu:default"/);
    expect(body).toMatch(/"core:tray:default"/);
    expect(body).toMatch(/"store:default"/);
    expect(body).toMatch(/"identifier": "fs:scope"/);
    // $DOWNLOAD/** added so the recordings/profile Export can actually write to
    // Downloads from the main window (the boolean from downloadJson is now truthful).
    expect(body).toMatch(
      /"allow": \[\{ "path": "\$APPDATA\/recordings\/\*\*" \}, \{ "path": "\$DOWNLOAD\/\*\*" \}\]/,
    );
    expect(body).toMatch(/"fs:allow-read-text-file"/);
    expect(body).toMatch(/"fs:allow-write-text-file"/);
    expect(body).toMatch(/"fs:allow-write-file"/);
    expect(body).toMatch(/"fs:allow-remove"/);
    expect(body).toMatch(/"fs:allow-mkdir"/);
    expect(body).toMatch(/"fs:allow-exists"/);
    expect(body).toMatch(/"fs:allow-read-dir"/);
    expect(body).toMatch(/"identifier": "shell:allow-open"/);
    const shellOpen = capability.permissions.find(
      (permission) =>
        typeof permission !== 'string' && permission.identifier === 'shell:allow-open',
    );
    expect(shellOpen).toEqual({
      identifier: 'shell:allow-open',
      allow: [
        { url: 'http://localhost:5173/cli/authorize**' },
        { url: 'https://app.driftstack.dev/cli/authorize**' },
        {
          url: 'https://staging.driftstack-customer-dashboard.pages.dev/cli/authorize**',
        },
      ],
    });
    expect(body).not.toMatch(/app-staging\.driftstack\.dev/);
    expect(existsSync(T('capabilities/default.json'))).toBe(true);
    expect(existsSync(T('capabilities/updater-windows-linux.json'))).toBe(true);
  });

  it('tauri.conf.json: productName=Driftstack 0.1.6 + identifier dev.driftstack.gui + frontendDist ../dist + devUrl localhost:1420 + 1 main window (1280×800 / min 960×600 / Overlay titleBarStyle / hiddenTitle / #0b0f14) + 5-target bundle (app/dmg/nsis/appimage/deb) DeveloperTool + macOS minimumSystemVersion 12.0 + Entitlements.plist + V-243 updater endpoint github releases latest + $TAURI_UPDATER_PUBKEY placeholder + V-328 deep-link scheme driftstack desktop-only pinned', () => {
    const body = read(T('tauri.conf.json'));
    const config = JSON.parse(body) as {
      app: { security: { capabilities: string[] } };
      bundle: { active: boolean };
      plugins: {
        updater: Record<string, unknown>;
      };
    };
    expect(body).toMatch(/"\$schema": "https:\/\/schema\.tauri\.app\/config\/2"/);
    expect(body).toMatch(/"productName": "Driftstack"/);
    expect(body).toMatch(/"version": "0\.1\.6"/);
    expect(body).toMatch(/"identifier": "dev\.driftstack\.gui"/);
    expect(body).toMatch(/"frontendDist": "\.\.\/dist"/);
    expect(body).toMatch(/"devUrl": "http:\/\/localhost:1420"/);
    expect(body).toMatch(/"beforeDevCommand": "npm run dev"/);
    expect(body).toMatch(/"beforeBuildCommand": "npm run build"/);
    expect(body).toMatch(/"label": "main"/);
    expect(body).toMatch(/"title": "Driftstack"/);
    expect(body).toMatch(/"width": 1280/);
    expect(body).toMatch(/"height": 800/);
    expect(body).toMatch(/"minWidth": 960/);
    expect(body).toMatch(/"minHeight": 600/);
    expect(body).toMatch(/"resizable": true/);
    expect(body).toMatch(/"fullscreen": false/);
    expect(body).toMatch(/"decorations": true/);
    expect(body).toMatch(/"transparent": false/);
    expect(body).toMatch(/"titleBarStyle": "Overlay"/);
    expect(body).toMatch(/"hiddenTitle": true/);
    expect(body).toMatch(/"backgroundColor": "#0b0f14"/);
    expect(body).toMatch(/"targets": \["app", "dmg", "nsis", "appimage", "deb"\]/);
    expect(body).toMatch(/"category": "DeveloperTool"/);
    expect(body).toMatch(/"icons\/32x32\.png"/);
    expect(body).toMatch(/"icons\/128x128\.png"/);
    expect(body).toMatch(/"icons\/128x128@2x\.png"/);
    expect(body).toMatch(/"icons\/icon\.icns"/);
    expect(body).toMatch(/"icons\/icon\.ico"/);
    expect(body).toMatch(/"minimumSystemVersion": "12\.0"/);
    expect(body).toMatch(/"entitlements": "Entitlements\.plist"/);
    // ⛔ This list is an ALLOW-LIST, not documentation. A capability file present in
    // capabilities/ but absent here grants NOTHING, silently — which is exactly how
    // 0.1.5 shipped `updater-check-macos` inert. See
    // a-capability-file-that-is-not-listed-is-inert.test.ts, which enforces the
    // file-set/list-set correspondence that this literal cannot.
    expect(config.app.security.capabilities).toEqual([
      'default',
      'simulator',
      'updater-check-macos',
      'updater-windows-linux',
    ]);
    expect(config.bundle.active).toBe(true);
    expect(config.plugins.updater).toEqual({
      endpoints: [
        'https://github.com/driftstackdev/driftstack-api/releases/latest/download/latest.json',
      ],
      pubkey: '$TAURI_UPDATER_PUBKEY',
    });
    expect('active' in config.plugins.updater).toBe(false);
    // 2026-06-01 — `dialog` removed: it was a Tauri-v1 updater key that did
    // nothing in v2 (v2's updater is programmatic; the in-app flow lives in
    // src/lib/updater.ts + UpdateBanner.tsx).
    expect(body).not.toMatch(/"dialog"/);
    expect(body).toMatch(/"pubkey": "\$TAURI_UPDATER_PUBKEY"/);
    expect(body).toMatch(/"deep-link": \{/);
    expect(body).toMatch(/"mobile": \[\]/);
    expect(body).toMatch(/"desktop": \{/);
    expect(body).toMatch(/"schemes": \["driftstack"\]/);
    expect(existsSync(T('tauri.conf.json'))).toBe(true);
  });

  it('tauri.simulator.conf.json: simulator app selects only simulator-app and has no inert updater overlay', () => {
    const config = JSON.parse(read(T('tauri.simulator.conf.json'))) as {
      app: { security: { capabilities: string[] } };
      plugins: Record<string, unknown>;
    };

    expect(config.app.security.capabilities).toEqual(['simulator-app']);
    expect(config.plugins).not.toHaveProperty('updater');
  });

  it('both desktop apps enforce the same Tauri CSP without script/object/frame/form escape hatches', () => {
    const main = JSON.parse(read(T('tauri.conf.json'))) as {
      app: { security: { csp: unknown } };
    };
    const simulator = JSON.parse(read(T('tauri.simulator.conf.json'))) as {
      app: { security: { csp: unknown } };
    };

    expect(main.app.security.csp).toEqual(DESKTOP_CSP);
    expect(simulator.app.security.csp).toEqual(DESKTOP_CSP);
    for (const path of ['tauri.conf.json', 'tauri.simulator.conf.json']) {
      const body = read(T(path));
      expect(body).not.toMatch(/"csp": null/);
      expect(body).not.toMatch(/unsafe-eval|unsafe-hashes/);
      expect(body).not.toMatch(/"script-src"[^\n]*unsafe-inline/);
    }
  });
});
