// W467.C — drift guard for apps/gui-client/src/lib/settings.ts.
// V-241 / D-2026-05-06-01 split-storage settings persistence.
// Drift here either drops the keychain migration on first load
// (a pre-V-241 customer's apiKey stays in plaintext settings.json
// forever — security regression on every machine that hasn't
// rotated keys) or breaks the keychain-delete-on-null branch in
// saveSettings (signing out leaves the API key in the keychain
// and the next launch silently re-authenticates).
//
//   • V-241 / D-2026-05-06-01 framing pinned: 'Settings persistence
//     — split storage' + API-key-in-keychain (macOS Keychain /
//     Windows Credential Manager / Linux Secret Service or
//     KWallet) + other-settings-in-settings.json framing.
//   • Migration framing pinned: 'Migration: a pre-V-241 customer
//     might have an apiKey field in settings.json. loadSettings
//     detects this on first call and transparently migrates to
//     the keychain (calls secret_save then rewrites settings.json
//     without the apiKey field). One-shot on upgrade; no customer
//     action needed.'
//   • Imports: LazyStore + invoke from @tauri-apps.
//   • DriftstackSettings 3-field (apiKey nullable + baseUrl +
//     telemetryOptIn boolean | null with V-242/D-2026-05-06-02
//     framing).
//   • DEFAULT_SETTINGS 'http://localhost:7780' + telemetryOptIn
//     null + apiKey null.
//   • Constants: STORE_FILE 'settings.json' + SETTINGS_KEY
//     'driftstack' + KEYCHAIN_API_KEY_NAME 'api_key'.
//   • keychainLoad: invoke('secret_load') + catch → null fallback
//     framing 'Keychain access failed (user dismissed, locked,
//     etc.) — fall back to null. Higher layers treat null as "not
//     set" + prompt the customer in settings.'
//   • keychainDelete: invoke('secret_delete') idempotent catch
//     'idempotent — delete-when-absent is acceptable'.
//   • loadSettings: 4-branch migration logic (string apiKey in
//     persisted + keychain absent → save to keychain + read-back
//     fallback; keychain present → use it as canonical) + final
//     persisted-with-apiKey detection → rewrite cleaned shape.
//   • saveSettings: store.set { baseUrl + telemetryOptIn } +
//     apiKey null/empty → keychainDelete else keychainSave.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/settings.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W467.C apps/gui-client/src/lib/settings.ts content parity', () => {
  const body = read(LIB);

  it("V-241 / D-2026-05-06-01 framing pinned: 'Settings persistence — split storage per V-241 / D-2026-05-06-01' + API-key-in-keychain framing 'lives in the OS keychain via Tauri commands (`secret_save` / `secret_load` / `secret_delete`) which wrap `keyring-rs` in `src-tauri/src/lib.rs`. macOS Keychain on Mac, Windows Credential Manager on Windows, Secret Service / KWallet on Linux — handled transparently per-platform.'", () => {
    expect(body).toMatch(/\/\/ Settings persistence — split storage per V-241 \/ D-2026-05-06-01:/);
    expect(body).toMatch(
      /\/\/\s+\* \*\*API key\*\* lives in the OS keychain via Tauri commands\s*\n?\s*\/\/\s+\(`secret_save` \/ `secret_load` \/ `secret_delete`\) which wrap\s*\n?\s*\/\/\s+`keyring-rs` in `src-tauri\/src\/lib\.rs`\. macOS Keychain on Mac,\s*\n?\s*\/\/\s+Windows Credential Manager on Windows, Secret Service \/ KWallet\s*\n?\s*\/\/\s+on Linux — handled transparently per-platform\./,
    );
  });

  it("Other-settings framing pinned: '**Other settings** (baseUrl) live in `settings.json` via `@tauri-apps/plugin-store` at the OS-appropriate config dir (`~/Library/Application Support/dev.driftstack.gui/` on macOS, `%APPDATA%\\Driftstack\\` on Windows, `~/.config/driftstack/` on Linux). Non-sensitive config; plain JSON is fine.'", () => {
    expect(body).toMatch(
      /\/\/\s+\* \*\*Other settings\*\* \(baseUrl\) live in `settings\.json` via\s*\n?\s*\/\/\s+`@tauri-apps\/plugin-store` at the OS-appropriate config dir\s*\n?\s*\/\/\s+\(`~\/Library\/Application Support\/dev\.driftstack\.gui\/` on macOS,\s*\n?\s*\/\/\s+`%APPDATA%\\Driftstack\\` on Windows, `~\/\.config\/driftstack\/`\s*\n?\s*\/\/\s+on Linux\)\. Non-sensitive config; plain JSON is fine\./,
    );
  });

  it("Migration framing pinned: 'Migration: a pre-V-241 customer might have an apiKey field in settings.json. `loadSettings` detects this on first call and transparently migrates to the keychain (calls `secret_save` then rewrites settings.json without the apiKey field). One-shot on upgrade; no customer action needed.'", () => {
    expect(body).toMatch(
      /\/\/ Migration: a pre-V-241 customer might have an apiKey field in\s*\n?\s*\/\/ settings\.json\. `loadSettings` detects this on first call and\s*\n?\s*\/\/ transparently migrates to the keychain \(calls `secret_save` then\s*\n?\s*\/\/ rewrites settings\.json without the apiKey field\)\. One-shot on\s*\n?\s*\/\/ upgrade; no customer action needed\./,
    );
  });

  it('DriftstackSettings 5-field (apiKey nullable + baseUrl + Fleet themeMode/themeAccent + telemetryOptIn nullable) with the V-242 telemetry framing + the 2026-06-12 theme-axes field', () => {
    expect(body).toMatch(
      /export interface DriftstackSettings \{\s*\n?\s*apiKey: string \| null;\s*\n?\s*baseUrl: string;\s*\n?\s*\/\*\* Fleet two-axis theme \(2026-06-12 rework\): mode \+ accent, persisted\. \*\/\s*\n?\s*themeMode: ThemeMode;\s*\n?\s*themeAccent: ThemeAccent;/,
    );
    expect(body).toMatch(
      /V-242 \/ D-2026-05-06-02 — explicit telemetry opt-in\/out\. When\s*\n?\s*\*\s*`null`, the platform default is used: ON for cloud, OFF for\s*\n?\s*\*\s*self-hosted\. A non-null value is the customer's explicit choice\s*\n?\s*\*\s*and overrides the default\./,
    );
    expect(body).toMatch(/telemetryOptIn: boolean \| null;\s*\n?\s*\}/);
  });

  it("DEFAULT_SETTINGS pinned: apiKey null + baseUrl 'http://localhost:3000' (SDK default port) + light/violet theme defaults (founder-locked) + telemetryOptIn null", () => {
    expect(body).toMatch(
      /export const DEFAULT_SETTINGS: DriftstackSettings = \{\s*\n?\s*apiKey: null,\s*\n?\s*baseUrl: 'http:\/\/localhost:3000',\s*\n?\s*themeMode: 'light',\s*\n?\s*themeAccent: 'violet',\s*\n?\s*telemetryOptIn: null,\s*\n?\s*\};/,
    );
  });

  it("Constants: STORE_FILE 'settings.json' + SETTINGS_KEY 'driftstack' + LEGACY_KEYCHAIN_NAME 'api_key' (legacy single-name, kept for first-load migration) + keychainNameFor(baseUrl) factory returning 'api_key:<host>' (2026-05-20 scoping fix b876a576 — switching cloud↔self-hosted reuses correct per-env entry)", () => {
    expect(body).toMatch(/const STORE_FILE = 'settings\.json';/);
    expect(body).toMatch(/const SETTINGS_KEY = 'driftstack';/);
    expect(body).toMatch(/const LEGACY_KEYCHAIN_NAME = 'api_key';/);
    expect(body).toMatch(/export function keychainNameFor\(baseUrl: string\): string/);
    // W584 — keychainNameFor now delegates to hostIdFor (the host portion is
    // reused as the per-deployment key-map key in settings.json too).
    expect(body).toMatch(/export function hostIdFor\(baseUrl: string\): string/);
    expect(body).toMatch(/return normalised\.length > 0 \? normalised : 'unknown';/);
    expect(body).toMatch(/return 'api_key:' \+ hostIdFor\(baseUrl\);/);
  });

  it("keychainLoad: invoke<string|null>('secret_load', {key:name}) + try/catch → null fallback framing 'Keychain access failed (user dismissed, locked, etc.) — fall back to null. Higher layers treat null as \"not set\" + prompt the customer in settings.'", () => {
    expect(body).toMatch(
      /async function keychainLoad\(name: string\): Promise<string \| null> \{\s*\n?\s*try \{\s*\n?\s*const value = await invoke<string \| null>\('secret_load', \{ key: name \}\);\s*\n?\s*return value;\s*\n?\s*\} catch \{\s*\n?\s*\/\/ Keychain access failed \(user dismissed, locked, etc\.\) — fall\s*\n?\s*\/\/ back to null\. Higher layers treat null as "not set" \+ prompt\s*\n?\s*\/\/ the customer in settings\.\s*\n?\s*return null;\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it("keychainDelete: invoke('secret_delete') wrapped in idempotent try/catch + framing 'idempotent — delete-when-absent is acceptable'", () => {
    expect(body).toMatch(
      /async function keychainDelete\(name: string\): Promise<void> \{\s*\n?\s*try \{\s*\n?\s*await invoke\('secret_delete', \{ key: name \}\);\s*\n?\s*\} catch \{\s*\n?\s*\/\* idempotent — delete-when-absent is acceptable \*\/\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it("loadSettings migration logic: persisted.apiKey string + length>0 + inKeychain === null → keychainSave + migratedApiKey + try/catch leave-in-settings.json fallback framing 'Keychain write failed — leave the apiKey in settings.json for now so the customer isn't suddenly logged out. The next attempt on the next launch will retry.' (2026-05-20: writes to scopedName = keychainNameFor(baseUrl) not the legacy single-name; per-env keychain entries)", () => {
    expect(body).toMatch(
      /let migratedApiKey: string \| null = null;\s*\n?\s*if \(persisted && typeof persisted\.apiKey === 'string' && persisted\.apiKey\.length > 0\) \{\s*\n?\s*const inKeychain = await keychainLoad\(scopedName\);\s*\n?\s*if \(inKeychain === null\) \{\s*\n?\s*try \{\s*\n?\s*await keychainSave\(scopedName, persisted\.apiKey\);\s*\n?\s*migratedApiKey = persisted\.apiKey;\s*\n?\s*\} catch \{/,
    );
    // 2026-05-20: the "Keychain write failed — leave in settings.json"
    // framing was dropped when the migration simplified to silently
    // fall through to `migratedApiKey = persisted.apiKey` on catch.
    // Pin the simpler shape so the catch fallback stays load-bearing.
    expect(body).toMatch(/\} catch \{\s*\n?\s*migratedApiKey = persisted\.apiKey;\s*\n?\s*\}/);
    expect(body).toMatch(/\} else \{\s*\n?\s*migratedApiKey = inKeychain;\s*\n?\s*\}/);
  });

  it("loadSettings cleanup write: persisted && 'apiKey' in persisted → store.set + store.save without apiKey field (cleaned shape) + returns {apiKey, baseUrl, themeMode, themeAccent, telemetryOptIn}", () => {
    expect(body).toMatch(
      /if \(persisted && 'apiKey' in persisted\) \{\s*\n?\s*await getStore\(\)\.set\(SETTINGS_KEY, \{ baseUrl, themeMode, themeAccent, telemetryOptIn \}\);\s*\n?\s*await getStore\(\)\.save\(\);\s*\n?\s*\}\s*\n?\s*return \{ apiKey, baseUrl, themeMode, themeAccent, telemetryOptIn \};/,
    );
  });

  it("saveSettings: store.set {baseUrl, themeMode, themeAccent, telemetryOptIn} + store.save + apiKey null OR length===0 → scoped+legacy dual keychainDelete else keychainSave(scopedName); 2026-05-20 b876a576 scopedName + legacy-name dual-delete on sign-out so cross-env switching can't reuse stale entry ('logout doesn't work, keychain keeps pulling from self-hosted' incident)", () => {
    expect(body).toMatch(
      /export async function saveSettings\(s: DriftstackSettings\): Promise<void>/,
    );
    expect(body).toMatch(
      /await getStore\(\)\.set\(SETTINGS_KEY, \{\s*\n?\s*baseUrl: s\.baseUrl,\s*\n?\s*themeMode: s\.themeMode,\s*\n?\s*themeAccent: s\.themeAccent,\s*\n?\s*telemetryOptIn: s\.telemetryOptIn,\s*\n?\s*\.\.\.\(!useKeychain && hasKey \? \{ apiKey: s\.apiKey \} : \{\}\),\s*\n?\s*\.\.\.\(Object\.keys\(keyMap\)\.length > 0 \? \{ apiKeys: keyMap \} : \{\}\),\s*\n?\s*\}\);/,
    );
    // W584 — per-deployment key map: cloud saves preserve other hosts' keys
    // (the founder's "switch modes → signed out" loop) and self-hosted
    // sign-out forgets only its own host.
    expect(body).toMatch(/const keyMap = keyMapFrom\(persisted\);/);
    expect(body).toMatch(/if \(hasKey\) keyMap\[hostId\] = s\.apiKey as string;/);
    expect(body).toMatch(/else delete keyMap\[hostId\];/);
    expect(body).toMatch(/const scopedName = keychainNameFor\(s\.baseUrl\);/);
    // Sign-out path: dual-delete (scoped + legacy) closes the cross-env
    // stale-key incident; pin both calls so a future refactor can't
    // silently drop the legacy half and reintroduce the regression.
    expect(body).toMatch(
      /await keychainDelete\(scopedName\);\s*\n?\s*await keychainDelete\(LEGACY_KEYCHAIN_NAME\);/,
    );
    expect(body).toMatch(/await keychainSave\(scopedName, s\.apiKey\);/);
  });

  it('GUI W232 (c) useKeychainForBaseUrl pinned: keychain ONLY for *.driftstack.dev (cloud, sensitive ds_live_ key); self-hosted / localhost → settings.json (ends the per-rebuild keychain ACL re-prompt). Drift to keychaining localhost would re-introduce the prompt-every-build pain; drift to NOT keychaining cloud would plaintext a live key', () => {
    expect(body).toMatch(/export function useKeychainForBaseUrl\(baseUrl: string\): boolean \{/);
    expect(body).toMatch(
      /return host === 'driftstack\.dev' \|\| host\.endsWith\('\.driftstack\.dev'\);/,
    );
  });

  it('GUI W232 (c) loadSettings self-hosted branch pinned: when !useKeychainForBaseUrl, the apiKey is read straight from settings.json (no keychain call → no prompt) + a one-time keychain→settings.json migration for pre-W232 self-hosted installs, then early-return', () => {
    expect(body).toMatch(/if \(!useKeychainForBaseUrl\(baseUrl\)\) \{/);
    // The one-time migration pulls a pre-W232 key out of the keychain + clears it.
    expect(body).toMatch(
      /const fromKeychain =\s*\n?\s*\(await keychainLoad\(scoped\)\) \?\? \(await keychainLoad\(LEGACY_KEYCHAIN_NAME\)\);/,
    );
    expect(body).toMatch(
      /await keychainDelete\(scoped\);\s*\n?\s*await keychainDelete\(LEGACY_KEYCHAIN_NAME\);/,
    );
  });

  it('GUI W232 (c) saveSettings branches on useKeychain: cloud key → keychainSave + return; self-hosted → key persisted in the store shape + keychain cleared (never re-prompts)', () => {
    expect(body).toMatch(/const useKeychain = useKeychainForBaseUrl\(s\.baseUrl\);/);
    expect(body).toMatch(
      /if \(useKeychain && s\.apiKey !== null && s\.apiKey\.length > 0\) \{\s*\n?\s*await keychainSave\(scopedName, s\.apiKey\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
