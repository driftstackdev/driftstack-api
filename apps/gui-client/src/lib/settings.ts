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
// Migration: older builds could persist a flat `apiKey` and a per-host
// `apiKeys` map in settings.json, especially for self-hosted deployments.
// `loadSettings` copies every remembered entry into its host-scoped keychain
// name and then rewrites settings.json without either plaintext field. A failed
// keychain write remains usable in memory for this launch but is NEVER retained
// on disk; the customer can re-enter it after unlocking the credential store.

import { LazyStore } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';
import { makeWriteLock } from './store-write-lock';

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
  /**
   * Start URL the remote iPhone browser opens when a session launches. GUI-local
   * config (like baseUrl/theme; non-sensitive → settings store, never keychain).
   * Passed per-launch as agentSessions.create({ initial_url }). Default
   * https://driftstack.dev.
   */
  startUrl: string;
}

export const DEFAULT_SETTINGS: DriftstackSettings = {
  apiKey: null,
  baseUrl: 'http://localhost:3000',
  // 2026-06-15 — founder: the GUI's standard look is Dark + Red (oxblood),
  // matching the marketing "Fleet Mission Control" brand. New installs land on
  // it; existing users keep their saved theme. Switch via the title-bar
  // ThemeSwitcher / ⌘⇧D.
  themeMode: 'dark',
  themeAccent: 'oxblood',
  telemetryOptIn: null,
  startUrl: 'https://driftstack.dev',
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

// Every deployment key is a bearer credential. A self-hosted/on-prem key can
// control production profiles, proxies, sessions, and billing just as a cloud
// key can; its host is not a security classification. Keep this exported seam
// for compatibility with callers/tests, but it is intentionally unconditional.
export function useKeychainForBaseUrl(_baseUrl: string): boolean {
  return true;
}

interface PersistedSettings {
  apiKey?: unknown;
  baseUrl?: unknown;
  themeMode?: unknown;
  themeAccent?: unknown;
  telemetryOptIn?: unknown;
  startUrl?: unknown;
  /** Legacy plaintext map; read only for one-shot keychain migration + purge. */
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

async function keychainSave(name: string, value: string): Promise<boolean> {
  try {
    await invoke('secret_save', { key: name, value });
    return true;
  } catch (err) {
    // Soft-fail like keychainLoad/keychainDelete: a save failure (locked
    // keychain, user dismissed the prompt) must NOT throw — it propagates
    // through saveSettings → SettingsContext.update → a `void update(...)`
    // caller → the global unhandledrejection handler → the fatal overlay. The
    // in-memory key still works for the session; only persistence is lost.
    console.warn('[settings] keychain save failed (key kept in-memory only):', err);
    return false;
  }
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
  // Start URL the remote browser opens on launch (GUI-local; passed per-launch as
  // agentSessions.create({ initial_url })). Non-empty string or the default.
  const startUrl =
    persisted && typeof persisted.startUrl === 'string' && persisted.startUrl.length > 0
      ? persisted.startUrl
      : DEFAULT_SETTINGS.startUrl;

  const scopedName = keychainNameFor(baseUrl);
  const legacyKeyMap = keyMapFrom(persisted);
  const activeHostId = hostIdFor(baseUrl);
  const flatLegacyKey =
    persisted && typeof persisted.apiKey === 'string' && persisted.apiKey.length > 0
      ? persisted.apiKey
      : null;
  let apiKey = await keychainLoad(scopedName);

  // One-shot plaintext migration. The scoped keychain entry wins when it
  // already exists; otherwise migrate the active host's map/flat value and keep
  // it in memory even if the OS store is temporarily locked. Migrate every
  // other remembered host too so mode-switching remains seamless without a
  // plaintext multi-host credential inventory on disk.
  const activeLegacyKey = legacyKeyMap[activeHostId] ?? flatLegacyKey;
  if (apiKey === null && activeLegacyKey !== null) {
    await keychainSave(scopedName, activeLegacyKey);
    apiKey = activeLegacyKey;
  }
  for (const [hostId, legacyKey] of Object.entries(legacyKeyMap)) {
    if (hostId === activeHostId) continue;
    const name = `api_key:${hostId}`;
    if ((await keychainLoad(name)) === null) await keychainSave(name, legacyKey);
  }

  // 2026-05-20 — migrate the legacy single-entry name on first read
  // ONLY when the scoped entry doesn't already exist, so customers
  // with a pre-scoping install don't get bounced back to the wizard
  // unnecessarily. After migration we delete the legacy entry so the
  // next-launch doesn't replay this branch.
  if (apiKey === null) {
    const legacy = await keychainLoad(LEGACY_KEYCHAIN_NAME);
    if (legacy !== null) {
      if (await keychainSave(scopedName, legacy)) {
        await keychainDelete(LEGACY_KEYCHAIN_NAME);
      }
      apiKey = legacy;
    }
  }

  // Purge BOTH historical plaintext shapes after the migration attempt. Never
  // fall back to settings.json on a locked/dismissed keychain: the current
  // value remains in memory, and a future launch safely asks for it again.
  if (persisted && ('apiKey' in persisted || 'apiKeys' in persisted)) {
    await getStore().set(SETTINGS_KEY, {
      baseUrl,
      themeMode,
      themeAccent,
      telemetryOptIn,
      startUrl,
    });
    await getStore().save();
  }

  return { apiKey, baseUrl, themeMode, themeAccent, telemetryOptIn, startUrl };
}

// Serialize settings writes so rapid theme/accent/base updates cannot overwrite
// one another. The lock mirrors the folders/tags sibling stores. (#7)
const settingsWriteLock = makeWriteLock();

export async function saveSettings(
  s: DriftstackSettings,
  options: { credentialUnchanged?: boolean } = {},
): Promise<void> {
  return settingsWriteLock(() => saveSettingsUnlocked(s, options));
}

/**
 * Founder 2026-06-23 — seed JUST the API base URL into the store, preserving every
 * other non-secret setting (theme / startUrl). The SEPARATE Simulator app starts
 * with an EMPTY store → loadSettings() falls back to DEFAULT_SETTINGS.baseUrl
 * (`http://localhost:3000`), so its control HTTP calls (mode / End-session /
 * cookies) all hit localhost and fail — even though the per-session control key
 * arrives via `ck=`. The launch now hands off the real `base=` (the PUBLIC API
 * host, non-secret); SimulatorWindow persists it here on mount so authedFetch
 * targets the right server. Merge-only (no keychain touch); no-op when unchanged.
 */
export async function persistBaseUrl(baseUrl: string): Promise<void> {
  if (baseUrl === '') return;
  return settingsWriteLock(async () => {
    const persisted = (await getStore().get<PersistedSettings>(SETTINGS_KEY)) ?? {};
    if (persisted.baseUrl === baseUrl) return; // already correct — skip the write
    await getStore().set(SETTINGS_KEY, { ...persisted, baseUrl });
    await getStore().save();
  });
}

async function saveSettingsUnlocked(
  s: DriftstackSettings,
  options: { credentialUnchanged?: boolean },
): Promise<void> {
  // settings.json is strictly non-secret for EVERY deployment. Per-host
  // switching remains supported by the scoped keychain entry name.
  await getStore().set(SETTINGS_KEY, {
    baseUrl: s.baseUrl,
    themeMode: s.themeMode,
    themeAccent: s.themeAccent,
    telemetryOptIn: s.telemetryOptIn,
    startUrl: s.startUrl,
  });
  await getStore().save();

  // Theme, telemetry and Start URL changes do not need to touch the OS
  // credential store when the key/deployment tuple is unchanged. Besides being
  // redundant, that write can open another platform authorization prompt.
  if (options.credentialUnchanged === true) return;

  const scopedName = keychainNameFor(s.baseUrl);
  if (s.apiKey !== null && s.apiKey.length > 0) {
    if (!(await keychainSave(scopedName, s.apiKey))) {
      // The non-secret settings write above may still have succeeded and the
      // caller keeps the key in memory, but an explicit Save must not claim
      // durable success when the credential store rejected the secret.
      throw new Error('credential store write failed');
    }
    return;
  }
  // Sign-out wipes the current scoped secret + legacy single-entry name.
  await keychainDelete(scopedName);
  await keychainDelete(LEGACY_KEYCHAIN_NAME);
}

/**
 * W584 — read the remembered key for a deployment WITHOUT mutating any store.
 * Every deployment uses its baseUrl-scoped keychain entry. Used by the mode
 * switch to auto-restore the right key without a plaintext settings map.
 */
export async function rememberedKeyFor(baseUrl: string): Promise<string | null> {
  return keychainLoad(keychainNameFor(baseUrl));
}
