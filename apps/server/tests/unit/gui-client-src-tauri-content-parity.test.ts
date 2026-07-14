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

  it('Cargo.toml: driftstack-gui crate 0.0.1 MIT non-publish + lib triplet (staticlib/cdylib/rlib) + Tauri 2.0 + 4 plugins (shell + store + fs + V-243 updater + V-328 deep-link) + V-241 T3 #1 keyring-rs v3 (apple-native + windows-native + sync-secret-service) + custom-protocol default feature pinned', () => {
    const body = read(T('Cargo.toml'));
    expect(body).toMatch(/^\[package\]$/m);
    expect(body).toMatch(/^name = "driftstack-gui"$/m);
    expect(body).toMatch(/^version = "0\.0\.1"$/m);
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

  it('src/lib.rs: V-241 T3 #1 keyring crate-doc framing + KEYRING_SERVICE=dev.driftstack.gui + KEYRING_USER=default + V-243 updater plugin + V-328 deep-link plugin + 4 commands (ping + secret_save + secret_load + secret_delete) + tests (keyring_user_prefix_is_stable + keyring_service_matches_tauri_bundle_id) pinned', () => {
    const body = read(T('src/lib.rs'));
    expect(body).toMatch(/^\/\/! Driftstack GUI — Tauri backend library\.$/m);
    expect(body).toMatch(/^\/\/! {3}\* `ping` — health probe\.$/m);
    expect(body).toMatch(
      /^\/\/! {3}\* `secret_save` \/ `secret_load` \/ `secret_delete` \(V-241 T3 #1\) —$/m,
    );
    expect(body).toMatch(/^\/\/! {5}cross-platform OS-keychain access for the API key\./m);
    expect(body).toMatch(/^\/\/! {5}uses macOS Keychain, Windows Credential Manager, or$/m);
    expect(body).toMatch(/^\/\/! {5}Linux Secret Service \/ KWallet via the `keyring` crate\.$/m);
    expect(body).toMatch(/^use keyring::Entry;$/m);
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
    expect(body).toMatch(/\.expect\("error while running tauri application"\);/);
    expect(body).toMatch(/^#\[tauri::command\]$/m);
    expect(body).toMatch(/^fn ping\(\) -> &'static str \{$/m);
    expect(body).toMatch(/^\s+"pong"$/m);
    expect(body).toMatch(
      /^fn secret_save\(key: String, value: String\) -> Result<\(\), String> \{$/m,
    );
    expect(body).toMatch(/let user = format!\("\{KEYRING_USER\}:\{key\}"\);/);
    expect(body).toMatch(
      /let entry = Entry::new\(KEYRING_SERVICE, &user\)\.map_err\(\|e\| e\.to_string\(\)\)\?;/,
    );
    expect(body).toMatch(/entry\.set_password\(&value\)\.map_err\(\|e\| e\.to_string\(\)\)\?;/);
    expect(body).toMatch(/^fn secret_load\(key: String\) -> Result<Option<String>, String> \{$/m);
    expect(body).toMatch(/Err\(keyring::Error::NoEntry\) => Ok\(None\),/);
    expect(body).toMatch(/^fn secret_delete\(key: String\) -> Result<\(\), String> \{$/m);
    expect(body).toMatch(/Err\(keyring::Error::NoEntry\) => Ok\(\(\)\),/);
    expect(body).toMatch(/^#\[cfg\(test\)\]$/m);
    expect(body).toMatch(/^mod tests \{$/m);
    expect(body).toMatch(/fn keyring_user_prefix_is_stable\(\) \{/);
    expect(body).toMatch(/assert_eq!\(user, "default:api_key"\);/);
    expect(body).toMatch(/fn keyring_service_matches_tauri_bundle_id\(\) \{/);
    expect(body).toMatch(/assert_eq!\(KEYRING_SERVICE, "dev\.driftstack\.gui"\);/);
    expect(existsSync(T('src/lib.rs'))).toBe(true);
  });

  it('capabilities/default.json: identifier=default + windows=[main] + 9 core/store permissions (incl. core:window:allow-start-dragging for the custom title-bar drag region) + fs:scope $APPDATA/recordings/** + $DOWNLOAD/** + 7 fs allow-* + updater:default + exact shell:allow-open activation URL allow-list pinned', () => {
    const body = read(T('capabilities/default.json'));
    const capability = JSON.parse(body) as {
      permissions: Array<
        | string
        | {
            identifier: string;
            allow?: Array<{ url?: string }>;
          }
      >;
    };
    expect(body).toMatch(/"\$schema": "\.\.\/gen\/schemas\/desktop-schema\.json"/);
    expect(body).toMatch(/"identifier": "default"/);
    expect(body).toMatch(
      /"description": "Default capabilities granted to the main window — only the surfaces the GUI actually needs\."/,
    );
    expect(body).toMatch(/"windows": \["main"\]/);
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
    expect(body).toMatch(/"updater:default"/);
    expect(body).toMatch(/"process:default"/);
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
  });

  it('tauri.conf.json: productName=Driftstack 0.0.1 + identifier dev.driftstack.gui + frontendDist ../dist + devUrl localhost:1420 + 1 main window (1280×800 / min 960×600 / Overlay titleBarStyle / hiddenTitle / #0b0f14) + 5-target bundle (app/dmg/nsis/appimage/deb) DeveloperTool + macOS minimumSystemVersion 12.0 + Entitlements.plist + V-243 updater endpoint github releases latest + $TAURI_UPDATER_PUBKEY placeholder + V-328 deep-link scheme driftstack desktop-only pinned', () => {
    const body = read(T('tauri.conf.json'));
    expect(body).toMatch(/"\$schema": "https:\/\/schema\.tauri\.app\/config\/2"/);
    expect(body).toMatch(/"productName": "Driftstack"/);
    expect(body).toMatch(/"version": "0\.0\.1"/);
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
    expect(body).toMatch(/"updater": \{/);
    expect(body).toMatch(/"active": true/);
    expect(body).toMatch(
      /"https:\/\/github\.com\/driftstackdev\/driftstack-api\/releases\/latest\/download\/latest\.json"/,
    );
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
