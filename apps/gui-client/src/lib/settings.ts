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
import type { SimulatorWindowSize } from './simulator-window-fit';

export type { SimulatorWindowSize } from './simulator-window-fit';

export type ThemeMode = 'light' | 'dark';
/** The one accent. Was 'violet' | 'oxblood' | 'teal'; the owner asked for the
 *  original red only (2026-09-02), keeping the light/dark axis. A persisted
 *  'violet' or 'teal' MIGRATES to this rather than being rejected — a customer
 *  who picked one before must not land on a validation failure. */
export type ThemeAccent = 'oxblood';

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
   * Passed per-launch as agentSessions.create({ initial_url }).
   *
   * ⭐ Default is the START PAGE (`/newtab/`), not the marketing homepage.
   * P-27 — a session used to open on `https://driftstack.io`, so the branded
   * start page with the "this device, as sites see it" panel was reachable only
   * by pressing "+". The first thing a customer saw was the product's own
   * marketing site, which tells them nothing about the device they just
   * launched. The start page is the useful landing surface, so it is the
   * default one.
   *
   * ⚠️ Only the DEFAULT moves. A customer who has set their own start URL keeps
   * it — the persisted value wins in `loadSettings`, so this cannot overwrite a
   * choice somebody made.
   */
  startUrl: string;
  /**
   * Install signed updates without asking each time.
   *
   * Default OFF, so the DEFAULT experience is being asked: the update banner
   * names the new version and the current one and offers Install & restart or
   * Later. Installing ends in a relaunch, and this is a browser-automation
   * tool — deciding for the customer that now is a good moment to restart is
   * the one thing an updater should not do on its own.
   *
   * Turning it ON means "stop asking", and even then the install is vetoed
   * while a session is running, because that is the case where a relaunch
   * destroys state the customer cannot get back.
   */
  autoUpdate: boolean;
  /**
   * The simulator window size the customer last left it at, per screen
   * (keyed by `simulatorScreenKey`, the work area's logical `WxH`), in logical
   * px of the phone alone — the docked rail/pane width is not included.
   *
   * Optional, and absent rather than `{}` when nothing has been remembered: an
   * older settings.json has no such key, and a customer who never resized the
   * phone has nothing to remember. Written by the simulator window's resize
   * handler (merge-only, like `persistBaseUrl`) and read back on the next open,
   * so a manual resize sticks. Non-sensitive → settings store, never keychain.
   */
  simulatorWindowSize?: Record<string, SimulatorWindowSize>;
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
  startUrl: 'https://driftstack.io/newtab/',
  autoUpdate: false,
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
  autoUpdate?: unknown;
  simulatorWindowSize?: unknown;
  /** Legacy plaintext map; read only for one-shot keychain migration + purge. */
  apiKeys?: unknown;
}

/**
 * Coerce the persisted per-screen window sizes into a clean map. Every entry
 * must be a `{ width, height }` of finite positive numbers; anything else (a
 * hand edit, a truncated write) is dropped entry by entry, never the whole map.
 * Returns `{}` when the field is absent or not an object.
 */
function windowSizesFrom(raw: unknown): Record<string, SimulatorWindowSize> {
  const out: Record<string, SimulatorWindowSize> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0 || typeof value !== 'object' || value === null) continue;
    const { width, height } = value as { width?: unknown; height?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number') continue;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
    out[key] = { width: Math.round(width), height: Math.round(height) };
  }
  return out;
}

/** The optional field is carried only when it has something to say. */
function windowSizesField(sizes: Record<string, SimulatorWindowSize>): {
  simulatorWindowSize?: Record<string, SimulatorWindowSize>;
} {
  return Object.keys(sizes).length > 0 ? { simulatorWindowSize: sizes } : {};
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

/**
 * Read only the non-secret deployment origin. Simulator control requests that
 * already carry a per-session control key must never open the account API-key
 * credential entry merely to discover where to send the request.
 *
 * This deliberately does not run plaintext-key migration: that work belongs
 * to loadSettings(), whose callers actually need the account credential.
 */
export async function loadBaseUrl(): Promise<string> {
  const persisted = await getStore().get<PersistedSettings>(SETTINGS_KEY);
  return persisted && typeof persisted.baseUrl === 'string' && persisted.baseUrl.length > 0
    ? persisted.baseUrl
    : DEFAULT_SETTINGS.baseUrl;
}

/**
 * In-process cache of resolved keychain reads, keyed by entry name.
 *
 * Every `secret_load` is a real `SecItem` read, and on macOS each read the OS
 * has not already authorized raises its own "allow access" prompt. Nothing
 * memoized these, and `loadSettings()` runs on every bearer-path control call
 * (`agent-session-control.ts`), so a single session could ask the customer for
 * their login password over and over — reported from the running GUI.
 *
 * The cache holds the in-flight PROMISE so concurrent callers coalesce into one
 * read rather than racing into two prompts. Scope is the process: nothing is
 * written to disk, no OS credential is stored anywhere new, and the entry's ACL
 * is untouched — the fix is strictly "stop asking the same question repeatedly".
 * A relaunch re-reads, which is what makes revocation still take effect.
 */
const keychainReads = new Map<string, Promise<string | null>>();

/** Drop a cached read so the next access goes back to the OS. */
function invalidateKeychainCache(name: string): void {
  keychainReads.delete(name);
}

/**
 * Forget every cached read, so the next access goes back to the OS for all
 * entries. The cache is process-lifetime state; this is what "a fresh launch"
 * means, and it is what tests use to simulate one between cases.
 */
export function resetKeychainCache(): void {
  keychainReads.clear();
}

async function keychainLoad(name: string): Promise<string | null> {
  const inFlight = keychainReads.get(name);
  if (inFlight !== undefined) return inFlight;

  const read = (async () => {
    try {
      return await invoke<string | null>('secret_load', { key: name });
    } catch {
      // Keychain access failed (user dismissed, locked, etc.) — fall
      // back to null. Higher layers treat null as "not set" + prompt
      // the customer in settings.
      //
      // Deliberately NOT cached: a dismissed prompt or a locked keychain is a
      // transient condition the customer can resolve mid-session, so the next
      // caller must reach the OS again. Only a resolved read is remembered —
      // including a genuine "no such entry", which is a real answer.
      invalidateKeychainCache(name);
      return null;
    }
  })();

  keychainReads.set(name, read);
  return read;
}

async function keychainSave(name: string, value: string): Promise<boolean> {
  try {
    await invoke('secret_save', { key: name, value });
    // The entry now holds `value`; serve that instead of re-prompting for it.
    keychainReads.set(name, Promise.resolve(value));
    return true;
  } catch (err) {
    invalidateKeychainCache(name);
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
    // Deletion is idempotent and authoritative: the entry is gone either way,
    // so cache the absence rather than re-prompting to rediscover it.
    keychainReads.set(name, Promise.resolve(null));
  } catch {
    /* idempotent — delete-when-absent is acceptable */
    invalidateKeychainCache(name);
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
  // Accent is single-valued now, so every persisted value — including the
  // retired 'violet'/'teal' — resolves here. Kept as a field rather than
  // deleted so an old settings file round-trips without losing its other keys.
  const themeAccent: ThemeAccent = DEFAULT_SETTINGS.themeAccent;
  // Start URL the remote browser opens on launch (GUI-local; passed per-launch as
  // agentSessions.create({ initial_url })). Non-empty string or the default.
  // 2026-09-04 — the website moved to driftstack.io. Changing DEFAULT_SETTINGS
  // alone would move only FRESH installs: every existing customer has the old
  // value written into settings.json, so they would keep opening the .dev start
  // page indefinitely — and the gap is invisible in testing, because a clean
  // install looks correct. Only the value this app itself shipped as a default is
  // migrated; a start URL the customer typed is theirs and is left alone.
  const LEGACY_DEFAULT_START_URLS = new Set([
    'https://driftstack.io/newtab/',
    'https://driftstack.io/newtab',
    'https://driftstack.io/',
    'https://driftstack.io',
  ]);
  const persistedStartUrl =
    persisted && typeof persisted.startUrl === 'string' && persisted.startUrl.length > 0
      ? persisted.startUrl
      : undefined;
  const startUrl =
    persistedStartUrl === undefined || LEGACY_DEFAULT_START_URLS.has(persistedStartUrl)
      ? DEFAULT_SETTINGS.startUrl
      : persistedStartUrl;

  // Only an explicit stored boolean overrides the default, so a settings.json
  // written before this field existed keeps auto-update ON rather than being
  // read as "the customer switched it off".
  const autoUpdate =
    persisted && typeof persisted.autoUpdate === 'boolean'
      ? persisted.autoUpdate
      : DEFAULT_SETTINGS.autoUpdate;

  // Remembered simulator window sizes, per screen. Validated entry by entry;
  // absent (not `{}`) when nothing has been remembered.
  const simulatorWindowSize = windowSizesFrom(persisted?.simulatorWindowSize);

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
      // V-1611 — `autoUpdate` was omitted here, so a customer who had turned it
      // on and then happened to hit the one-time plaintext migration silently
      // reverted to the default. The purge rewrites the WHOLE settings object,
      // so every persisted field has to be listed or it is dropped. The return
      // below carries it, which is why the loss was invisible until relaunch.
      autoUpdate,
      // Same lesson: the remembered window sizes are persisted state too.
      ...windowSizesField(simulatorWindowSize),
    });
    await getStore().save();
  }

  return {
    apiKey,
    baseUrl,
    themeMode,
    themeAccent,
    telemetryOptIn,
    startUrl,
    autoUpdate,
    ...windowSizesField(simulatorWindowSize),
  };
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

/**
 * T-12 — remember the simulator window size the customer left it at on one
 * screen, so the next open on that screen starts there. Merge-only: the other
 * screens' sizes and every other non-secret setting are preserved, the keychain
 * is never touched, and an unchanged size is not rewritten (the resize handler
 * calls this after every settled resize, including the ones this app makes).
 */
export async function persistSimulatorWindowSize(
  screenKey: string,
  size: SimulatorWindowSize,
): Promise<void> {
  const [clean] = Object.values(windowSizesFrom({ [screenKey]: size }));
  if (screenKey.length === 0 || clean === undefined) return;
  return settingsWriteLock(async () => {
    const persisted = (await getStore().get<PersistedSettings>(SETTINGS_KEY)) ?? {};
    const sizes = windowSizesFrom(persisted.simulatorWindowSize);
    const current = sizes[screenKey];
    if (current !== undefined && current.width === clean.width && current.height === clean.height)
      return; // already remembered — skip the write
    sizes[screenKey] = clean;
    await getStore().set(SETTINGS_KEY, { ...persisted, simulatorWindowSize: sizes });
    await getStore().save();
  });
}

/**
 * The remembered simulator window size for one screen, or `null` when none was
 * remembered there. Reads only the non-secret store — like `loadBaseUrl`, it
 * never opens the keychain, so opening a window cannot raise a credential prompt.
 */
export async function loadSimulatorWindowSize(
  screenKey: string,
): Promise<SimulatorWindowSize | null> {
  const persisted = await getStore().get<PersistedSettings>(SETTINGS_KEY);
  return windowSizesFrom(persisted?.simulatorWindowSize)[screenKey] ?? null;
}

async function saveSettingsUnlocked(
  s: DriftstackSettings,
  options: { credentialUnchanged?: boolean },
): Promise<void> {
  // settings.json is strictly non-secret for EVERY deployment. Per-host
  // switching remains supported by the scoped keychain entry name.
  //
  // The whole object is rewritten, so every persisted field has to be listed
  // (V-1611). The remembered window sizes are owned by the simulator window,
  // not by whoever holds this `s`: a Settings-view save made after the phone
  // was resized would otherwise write the in-memory copy from launch time
  // over the size just remembered. When `s` carries none, keep what is on disk.
  const persisted = (await getStore().get<PersistedSettings>(SETTINGS_KEY)) ?? {};
  const simulatorWindowSize =
    s.simulatorWindowSize ?? windowSizesFrom(persisted.simulatorWindowSize);
  await getStore().set(SETTINGS_KEY, {
    baseUrl: s.baseUrl,
    themeMode: s.themeMode,
    themeAccent: s.themeAccent,
    telemetryOptIn: s.telemetryOptIn,
    startUrl: s.startUrl,
    autoUpdate: s.autoUpdate,
    ...windowSizesField(simulatorWindowSize),
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
