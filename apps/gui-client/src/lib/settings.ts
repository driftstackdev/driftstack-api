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
// 2026-05-20 — keychain entry name is now scoped by baseUrl origin so
// switching cloud↔self-hosted (or between two self-hosted servers)
// doesn't reuse the wrong key. Older single-entry name kept for
// migration on first load.
const LEGACY_KEYCHAIN_NAME = 'api_key';
export function keychainNameFor(baseUrl: string): string {
  // Normalise: trim, strip protocol, strip trailing slashes, replace
  // non-safe chars. We don't need cryptographic uniqueness here — just
  // a stable+readable per-env identifier.
  const normalised = baseUrl
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .toLowerCase();
  return 'api_key:' + (normalised.length > 0 ? normalised : 'unknown');
}

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
  const baseUrl =
    persisted && typeof persisted.baseUrl === 'string' && persisted.baseUrl.length > 0
      ? persisted.baseUrl
      : DEFAULT_SETTINGS.baseUrl;
  const telemetryOptIn =
    persisted && typeof persisted.telemetryOptIn === 'boolean' ? persisted.telemetryOptIn : null;
  const scopedName = keychainNameFor(baseUrl);

  // Pre-V-241 customers may have apiKey in settings.json. Migrate
  // transparently on read: if found there AND not present in the
  // baseUrl-scoped keychain entry, copy.
  let migratedApiKey: string | null = null;
  if (persisted && typeof persisted.apiKey === 'string' && persisted.apiKey.length > 0) {
    const inKeychain = await keychainLoad(scopedName);
    if (inKeychain === null) {
      try {
        await keychainSave(scopedName, persisted.apiKey);
        migratedApiKey = persisted.apiKey;
      } catch {
        migratedApiKey = persisted.apiKey;
      }
    } else {
      migratedApiKey = inKeychain;
    }
  }

  let apiKey = migratedApiKey ?? (await keychainLoad(scopedName));

  // 2026-05-20 — migrate the legacy single-entry name on first read
  // ONLY when the scoped entry doesn't already exist, so customers
  // with a pre-scoping install don't get bounced back to the wizard
  // unnecessarily. After migration we delete the legacy entry so the
  // next-launch doesn't replay this branch.
  if (apiKey === null) {
    const legacy = await keychainLoad(LEGACY_KEYCHAIN_NAME);
    if (legacy !== null) {
      try {
        await keychainSave(scopedName, legacy);
        await keychainDelete(LEGACY_KEYCHAIN_NAME);
        apiKey = legacy;
      } catch {
        apiKey = legacy;
      }
    }
  }

  // If migration ran (or settings.json had a stale apiKey that we just
  // dropped), persist the cleaned-up shape.
  if (persisted && 'apiKey' in persisted) {
    await getStore().set(SETTINGS_KEY, { baseUrl, telemetryOptIn });
    await getStore().save();
  }

  return { apiKey, baseUrl, telemetryOptIn };
}

export async function saveSettings(s: DriftstackSettings): Promise<void> {
  await getStore().set(SETTINGS_KEY, {
    baseUrl: s.baseUrl,
    telemetryOptIn: s.telemetryOptIn,
  });
  await getStore().save();
  const scopedName = keychainNameFor(s.baseUrl);
  if (s.apiKey === null || s.apiKey.length === 0) {
    // 2026-05-20 — also wipe the legacy single-entry name on sign-out
    // so customers don't get re-pulled into a stale key on next launch
    // (customer reported "logout doesn't work, keychain keeps pulling
    // from self-hosted"). Idempotent — delete-when-absent is fine.
    await keychainDelete(scopedName);
    await keychainDelete(LEGACY_KEYCHAIN_NAME);
  } else {
    await keychainSave(scopedName, s.apiKey);
  }
}
