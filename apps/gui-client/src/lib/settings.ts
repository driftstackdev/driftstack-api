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

export type ThemeMode = 'light' | 'dark';
export type ThemeAccent = 'violet' | 'oxblood' | 'teal';

export interface DriftstackSettings {
  apiKey: string | null;
  baseUrl: string;
  /** Fleet two-axis theme (2026-06-12 rework): mode + accent, persisted. */
  themeMode: ThemeMode;
  themeAccent: ThemeAccent;
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
  themeMode: 'light',
  themeAccent: 'violet',
  telemetryOptIn: null,
};

const STORE_FILE = 'settings.json';
const SETTINGS_KEY = 'driftstack';
// 2026-05-20 — keychain entry name is now scoped by baseUrl origin so
// switching cloud↔self-hosted (or between two self-hosted servers)
// doesn't reuse the wrong key. Older single-entry name kept for
// migration on first load.
const LEGACY_KEYCHAIN_NAME = 'api_key';
/** W584 — stable per-deployment identifier (host portion of the baseUrl). */
export function hostIdFor(baseUrl: string): string {
  // Normalise: trim, strip protocol, strip trailing slashes, replace
  // non-safe chars. We don't need cryptographic uniqueness here — just
  // a stable+readable per-env identifier.
  const normalised = baseUrl
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .toLowerCase();
  return normalised.length > 0 ? normalised : 'unknown';
}
export function keychainNameFor(baseUrl: string): string {
  return 'api_key:' + hostIdFor(baseUrl);
}

// GUI W232 (c) — keychain ONLY for the official cloud (`*.driftstack.dev`,
// where the key is a sensitive `ds_live_…` value worth OS-encrypting). For
// self-hosted / localhost the key is a local dev value, and the macOS Keychain
// ACL prompt re-fires on every ad-hoc rebuild (fresh code signature) — so we
// store it in `settings.json` instead (plaintext in the per-app config dir;
// acceptable for a local key, and it ENDS the per-build re-prompt). Switching
// baseUrl re-evaluates this, and loadSettings one-time-migrates a self-hosted
// key out of the keychain into settings.json on the first load after upgrade.
export function useKeychainForBaseUrl(baseUrl: string): boolean {
  const host = baseUrl
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
  return host === 'driftstack.dev' || host.endsWith('.driftstack.dev');
}

interface PersistedSettings {
  apiKey?: unknown;
  baseUrl?: unknown;
  themeMode?: unknown;
  themeAccent?: unknown;
  telemetryOptIn?: unknown;
  /** W584 — per-deployment self-hosted keys, keyed by hostIdFor(baseUrl). */
  apiKeys?: unknown;
}

/** W584 — coerce the persisted apiKeys field into a clean string→string map. */
function keyMapFrom(persisted: PersistedSettings | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = persisted?.apiKeys;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
  }
  return out;
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
  // Fleet theme axes — validated against the known sets; anything else
  // (older settings.json, hand edits) falls back to the defaults.
  const themeMode: ThemeMode =
    persisted?.themeMode === 'dark' || persisted?.themeMode === 'light'
      ? persisted.themeMode
      : DEFAULT_SETTINGS.themeMode;
  const themeAccent: ThemeAccent =
    persisted?.themeAccent === 'violet' ||
    persisted?.themeAccent === 'oxblood' ||
    persisted?.themeAccent === 'teal'
      ? persisted.themeAccent
      : DEFAULT_SETTINGS.themeAccent;

  // GUI W232 (c) — self-hosted / localhost: the API key lives in settings.json
  // (no keychain → no per-rebuild ACL prompt). Read it straight from the store.
  // W584 — the per-host map is authoritative; the flat apiKey field is the
  // pre-map back-compat shape (migrated into the map on first load).
  if (!useKeychainForBaseUrl(baseUrl)) {
    const keyMap = keyMapFrom(persisted);
    const hostId = hostIdFor(baseUrl);
    let apiKey =
      keyMap[hostId] ??
      (persisted && typeof persisted.apiKey === 'string' && persisted.apiKey.length > 0
        ? persisted.apiKey
        : null);
    // One-time migration: a pre-W232 self-hosted install kept the key in the
    // keychain. Pull it into settings.json + clear the keychain (one last
    // prompt, then never again).
    if (apiKey === null) {
      const scoped = keychainNameFor(baseUrl);
      const fromKeychain =
        (await keychainLoad(scoped)) ?? (await keychainLoad(LEGACY_KEYCHAIN_NAME));
      if (fromKeychain !== null) {
        apiKey = fromKeychain;
        await keychainDelete(scoped);
        await keychainDelete(LEGACY_KEYCHAIN_NAME);
      }
    }
    // W584 — persist the map shape whenever the resolved key isn't in it yet
    // (flat-field or keychain migration), preserving other hosts' keys.
    if (apiKey !== null && keyMap[hostId] !== apiKey) {
      keyMap[hostId] = apiKey;
      await getStore().set(SETTINGS_KEY, {
        apiKey,
        baseUrl,
        telemetryOptIn,
        apiKeys: keyMap,
      });
      await getStore().save();
    }
    return { apiKey, baseUrl, themeMode, themeAccent, telemetryOptIn };
  }

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
    await getStore().set(SETTINGS_KEY, { baseUrl, themeMode, themeAccent, telemetryOptIn });
    await getStore().save();
  }

  return { apiKey, baseUrl, themeMode, themeAccent, telemetryOptIn };
}

export async function saveSettings(s: DriftstackSettings): Promise<void> {
  const useKeychain = useKeychainForBaseUrl(s.baseUrl);
  const hasKey = s.apiKey !== null && s.apiKey.length > 0;
  // W584 — preserve OTHER deployments' remembered keys on every save. The
  // pre-map shape rewrote settings.json without the apiKey field whenever a
  // cloud save ran, silently destroying the self-hosted key — the founder's
  // "switch modes → signed out again" loop. The per-host map survives saves
  // in any mode; only an explicit sign-out (empty key) removes ITS host.
  const persisted = await getStore().get<PersistedSettings>(SETTINGS_KEY);
  const keyMap = keyMapFrom(persisted);
  const hostId = hostIdFor(s.baseUrl);
  if (!useKeychain) {
    if (hasKey) keyMap[hostId] = s.apiKey as string;
    else delete keyMap[hostId]; // self-hosted sign-out forgets only this host
  }
  // GUI W232 (c) — self-hosted keys are persisted IN settings.json; cloud keys
  // NEVER are (they stay in the OS keychain). On self-hosted sign-out the
  // apiKey is simply omitted from the store shape.
  await getStore().set(SETTINGS_KEY, {
    baseUrl: s.baseUrl,
    themeMode: s.themeMode,
    themeAccent: s.themeAccent,
    telemetryOptIn: s.telemetryOptIn,
    ...(!useKeychain && hasKey ? { apiKey: s.apiKey } : {}),
    ...(Object.keys(keyMap).length > 0 ? { apiKeys: keyMap } : {}),
  });
  await getStore().save();

  const scopedName = keychainNameFor(s.baseUrl);
  if (useKeychain && s.apiKey !== null && s.apiKey.length > 0) {
    await keychainSave(scopedName, s.apiKey);
    return;
  }
  // Cloud sign-out OR any self-hosted save: ensure no keychain copy lingers —
  // so a self-hosted key never re-prompts, and a cloud sign-out wipes the
  // secret + the legacy single-entry name (2026-05-20: "logout keeps pulling
  // from self-hosted"). Idempotent; delete-when-absent is fine.
  await keychainDelete(scopedName);
  await keychainDelete(LEGACY_KEYCHAIN_NAME);
}

/**
 * W584 — read the remembered key for a deployment WITHOUT mutating any store.
 * Cloud → the baseUrl-scoped keychain entry. Self-hosted → the per-host map
 * (falling back to the flat apiKey field when it belongs to the same host —
 * the pre-map shape). Used by the mode switch to auto-restore the right key
 * so switching cloud↔self-hosted never asks the customer to re-paste.
 */
export async function rememberedKeyFor(baseUrl: string): Promise<string | null> {
  if (useKeychainForBaseUrl(baseUrl)) {
    return keychainLoad(keychainNameFor(baseUrl));
  }
  const persisted = await getStore().get<PersistedSettings>(SETTINGS_KEY);
  const keyMap = keyMapFrom(persisted);
  const hostId = hostIdFor(baseUrl);
  if (keyMap[hostId] !== undefined) return keyMap[hostId];
  const persistedBaseUrl =
    persisted && typeof persisted.baseUrl === 'string' ? persisted.baseUrl : '';
  if (
    hostIdFor(persistedBaseUrl) === hostId &&
    persisted &&
    typeof persisted.apiKey === 'string' &&
    persisted.apiKey.length > 0
  ) {
    return persisted.apiKey;
  }
  return null;
}
