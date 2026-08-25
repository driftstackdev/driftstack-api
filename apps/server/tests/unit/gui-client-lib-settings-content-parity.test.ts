// Cross-workspace invariant for GUI settings persistence. API keys are bearer
// credentials on every deployment, including localhost/self-hosted, and must
// never be written to plugin-store's plaintext settings.json.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/settings.ts');
const body = readFileSync(LIB, 'utf8');

describe('GUI settings protected API-key storage invariant', () => {
  it('keeps every API key in the OS keychain and non-secret settings in settings.json', () => {
    expect(body).toMatch(/\* \*\*API key\*\* lives in the OS keychain via Tauri commands/);
    expect(body).toMatch(/\* \*\*Other settings\*\* \(baseUrl\) live in `settings\.json`/);
    expect(body).toMatch(/macOS Keychain on Mac/);
    expect(body).toMatch(/Windows Credential Manager on Windows/);
    expect(body).toMatch(/Secret Service \/ KWallet/);
  });

  it('treats host as routing, never as a credential security classification', () => {
    expect(body).toMatch(/A self-hosted\/on-prem key can/);
    expect(body).toMatch(/its host is not a security classification/);
    expect(body).toMatch(
      /export function useKeychainForBaseUrl\(_baseUrl: string\): boolean \{\s*return true;/,
    );
  });

  it('uses a stable per-host scoped keychain name and retains the legacy-name migration seam', () => {
    expect(body).toMatch(/const LEGACY_KEYCHAIN_NAME = 'api_key';/);
    expect(body).toMatch(/export function hostIdFor\(baseUrl: string\): string/);
    expect(body).toMatch(/return 'api_key:' \+ hostIdFor\(baseUrl\);/);
  });

  it('exposes a non-secret-only base URL reader for control-key transports', () => {
    expect(body).toMatch(/export async function loadBaseUrl\(\): Promise<string>/);
    const loader = body.slice(
      body.indexOf('export async function loadBaseUrl'),
      body.indexOf('async function keychainLoad'),
    );
    expect(loader).toContain('getStore().get<PersistedSettings>(SETTINGS_KEY)');
    expect(loader).not.toContain('keychainLoad');
    expect(loader).not.toContain('invoke');
  });

  it('keychain save failures are memory-only and never fall back to disk', () => {
    expect(body).toMatch(
      /async function keychainSave\(name: string, value: string\): Promise<boolean>/,
    );
    expect(body).toMatch(/keychain save failed \(key kept in-memory only\)/);
    expect(body).toMatch(/return false;/);
    expect(body).toMatch(/NEVER retained\s*\/\/ on disk/);
  });

  it('migrates active flat/map values and all other remembered hosts', () => {
    expect(body).toMatch(
      /const activeLegacyKey = legacyKeyMap\[activeHostId\] \?\? flatLegacyKey;/,
    );
    expect(body).toMatch(/await keychainSave\(scopedName, activeLegacyKey\);/);
    expect(body).toMatch(/for \(const \[hostId, legacyKey\] of Object\.entries\(legacyKeyMap\)\)/);
    expect(body).toMatch(/const name = `api_key:\$\{hostId\}`;/);
  });

  it('purges both historical plaintext shapes after the migration attempt', () => {
    expect(body).toMatch(
      /if \(persisted && \('apiKey' in persisted \|\| 'apiKeys' in persisted\)\) \{/,
    );
    expect(body).toMatch(/Purge BOTH historical plaintext shapes/);
    // ⛔ V-1611 — this pin used to REQUIRE the list without `autoUpdate`, which
    // froze a real defect in place. The purge rewrites the WHOLE settings object,
    // so an omitted field is dropped: a customer who enabled auto-update and then
    // hit the one-time plaintext migration silently reverted to the default,
    // invisibly until relaunch.
    //
    // ⚠️ Two pins over this same file disagreed and nothing compared them. The
    // save-path arm below already REQUIRED `autoUpdate: s.autoUpdate`, on the
    // stated reasoning that a new persisted field must be reviewed for secrecy
    // before it lands. Both were locally satisfied, so neither could see that
    // they described different truths about the same object.
    expect(body).toMatch(
      /getStore\(\)\.set\(SETTINGS_KEY, \{\s*baseUrl,\s*themeMode,\s*themeAccent,\s*telemetryOptIn,\s*startUrl,[\s\S]*?autoUpdate,?\s*\}\);/,
    );
  });

  it('saveSettings persists only non-secret settings and keychains any nonempty key', () => {
    // The point of enumerating the payload is that a NEW field has to be looked
    // at before it lands here — the store is plaintext on disk, so the review
    // this pin forces is "is this non-secret?". autoUpdate is a boolean
    // preference, so it belongs; apiKey still must never appear.
    expect(body).toMatch(
      /getStore\(\)\.set\(SETTINGS_KEY, \{\s*baseUrl: s\.baseUrl,\s*themeMode: s\.themeMode,\s*themeAccent: s\.themeAccent,\s*telemetryOptIn: s\.telemetryOptIn,\s*startUrl: s\.startUrl,\s*autoUpdate: s\.autoUpdate,?\s*\}\);/,
    );
    expect(body).not.toMatch(/\.\.\.\(!useKeychain && hasKey/);
    expect(body).toMatch(/if \(!\(await keychainSave\(scopedName, s\.apiKey\)\)\) \{/);
    expect(body).toContain("throw new Error('credential store write failed');");
    expect(body).toContain('if (options.credentialUnchanged === true) return;');
  });

  it('sign-out deletes both the scoped and legacy keychain entries', () => {
    expect(body).toMatch(
      /await keychainDelete\(scopedName\);\s*await keychainDelete\(LEGACY_KEYCHAIN_NAME\);/,
    );
  });

  it('rememberedKeyFor always reads keychain and never the plaintext store', () => {
    expect(body).toMatch(
      /export async function rememberedKeyFor\(baseUrl: string\): Promise<string \| null> \{\s*return keychainLoad\(keychainNameFor\(baseUrl\)\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
