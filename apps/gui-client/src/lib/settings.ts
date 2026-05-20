// Settings persistence — split storage per V-241 / D-2026-05-06-01:
//
//   * **API key** lives in the OS keychain via Tauri commands
//     (`secret_save` / `secret_load` / `secret_delete`) which wrap
//     `keyring-rs` in `src-tauri/src/lib.rs`. macOS Keychain on Mac,
//     Windows Credential Manager on Windows, Secret Service / KWallet
//     on Linux — handled transparently per-platform.
//
//   * **Other settings** (baseUrl) live in `settings.json` via
//     `@tauri-apps/plugin-store` at the OS-appropriate config dir
//     (`~/Library/Application Support/dev.driftstack.gui/` on macOS,
//     `%APPDATA%\Driftstack\` on Windows, `~/.config/driftstack/`
//     on Linux). Non-sensitive config; plain JSON is fine.
//
// Migration: a pre-V-241 customer might have an apiKey field in
// settings.json. `loadSettings` detects this on first call and
// transparently migrates to the keychain (calls `secret_save` then
// rewrites settings.json without the apiKey field). One-shot on
// upgrade; no customer action needed.

import { LazyStore } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';

export interface DriftstackSettings {
  apiKey: string | null;
  baseUrl: string;
  /**
   * V-242 / D-2026-05-06-02 — explicit telemetry opt-in/out. When
   * `null`, the platform default is used: ON for cloud, OFF for
   * self-hosted. A non-null value is the customer's explicit choice
   * and overrides the default.
   */
  telemetryOptIn: boolean | null;
}

export const DEFAULT_SETTINGS: DriftstackSettings = {
  apiKey: null,
  baseUrl: 'http://localhost:3000',
  telemetryOptIn: null,
};

const STORE_FILE = 'settings.json';
const SETTINGS_KEY = 'driftstack';
const KEYCHAIN_API_KEY_NAME = 'api_key';

interface PersistedSettings {
  apiKey?: unknown;
  baseUrl?: unknown;
  telemetryOptIn?: unknown;
}

let store: LazyStore | null = null;

function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

async function keychainLoad(name: string): Promise<string | null> {
  try {
    const value = await invoke<string | null>('secret_load', { key: name });
    return value;
  } catch {
    // Keychain access failed (user dismissed, locked, etc.) — fall
    // back to null. Higher layers treat null as "not set" + prompt
    // the customer in settings.
    return null;
  }
}

async function keychainSave(name: string, value: string): Promise<void> {
  await invoke('secret_save', { key: name, value });
}

async function keychainDelete(name: string): Promise<void> {
  try {
    await invoke('secret_delete', { key: name });
  } catch {
    /* idempotent — delete-when-absent is acceptable */
  }
}

export async function loadSettings(): Promise<DriftstackSettings> {
  const persisted = await getStore().get<PersistedSettings>(SETTINGS_KEY);

  // Pre-V-241 customers may have apiKey in settings.json. Migrate
  // transparently on read: if found there AND not present in keychain,
  // copy to keychain + rewrite settings.json without the apiKey field.
  let migratedApiKey: string | null = null;
  if (persisted && typeof persisted.apiKey === 'string' && persisted.apiKey.length > 0) {
    const inKeychain = await keychainLoad(KEYCHAIN_API_KEY_NAME);
    if (inKeychain === null) {
      try {
        await keychainSave(KEYCHAIN_API_KEY_NAME, persisted.apiKey);
        migratedApiKey = persisted.apiKey;
      } catch {
        // Keychain write failed — leave the apiKey in settings.json
        // for now so the customer isn't suddenly logged out. The next
        // attempt on the next launch will retry.
        migratedApiKey = persisted.apiKey;
      }
    } else {
      // Keychain already has the canonical value; the settings.json
      // copy is stale — drop it on the next save() below.
      migratedApiKey = inKeychain;
    }
  }

  const apiKey = migratedApiKey ?? (await keychainLoad(KEYCHAIN_API_KEY_NAME));
  const baseUrl =
    persisted && typeof persisted.baseUrl === 'string' && persisted.baseUrl.length > 0
      ? persisted.baseUrl
      : DEFAULT_SETTINGS.baseUrl;
  const telemetryOptIn =
    persisted && typeof persisted.telemetryOptIn === 'boolean' ? persisted.telemetryOptIn : null;

  // If migration ran (or settings.json had a stale apiKey that we just
  // dropped), persist the cleaned-up shape.
  if (persisted && 'apiKey' in persisted) {
    await getStore().set(SETTINGS_KEY, { baseUrl, telemetryOptIn });
    await getStore().save();
  }

  return { apiKey, baseUrl, telemetryOptIn };
}

export async function saveSettings(s: DriftstackSettings): Promise<void> {
  // baseUrl + telemetryOptIn → JSON store; apiKey → keychain (or delete on null).
  await getStore().set(SETTINGS_KEY, {
    baseUrl: s.baseUrl,
    telemetryOptIn: s.telemetryOptIn,
  });
  await getStore().save();

  if (s.apiKey === null || s.apiKey.length === 0) {
    await keychainDelete(KEYCHAIN_API_KEY_NAME);
  } else {
    await keychainSave(KEYCHAIN_API_KEY_NAME, s.apiKey);
  }
}
