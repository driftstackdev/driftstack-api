// T-14 — the owner's Mac never received 0.1.16 through 0.1.19.
//
// Measured 2026-09-07: installed 0.1.15, the endpoint serving 0.1.19 for the
// same platform and key, the updater capability granted. One of the two causes
// was `autoUpdate: false` by default (since 2026-08-23), which made the default
// experience a banner whose "Later" persists per version. The default is ON
// again — and that alone did not reach the owner: their settings.json carried
// an explicit `autoUpdate: false` that no one chose. `saveSettingsUnlocked`
// rewrites the whole object, so any save under the OFF default (a theme change)
// echoed `false` to disk, and a loader that keeps every stored `false` keeps
// that one too. So a stored value is a choice ONLY under the layout marker
// `SETTINGS_VERSION` that this build's saves stamp; older files take the default.
//
// The cases, each its own arm, because each is a different fact:
//   • absent                          → ON   (the migration)
//   • stored `false`, no marker       → ON   (the owner's measured file: an echo)
//   • stored `false` under the marker → OFF  (the switch was used; kept)
//   • stored `true`                   → ON   (either way)
//   • marker older / not a number     → ON   (the marker decides, not the boolean)
//   • a save stamps the marker, so the migration happens once: save OFF, reload,
//     still OFF
//
// Mutation record: `autoUpdate: true` → `false` in DEFAULT_SETTINGS reds the
// absent arm and the non-boolean control; in the loader,
// `persistedSettingsVersion >= SETTINGS_VERSION` → `>= 0` (ignore the marker)
// reds the unmarked-false arm and the marker-decides control while every
// marked arm stays green; deleting `settingsVersion: SETTINGS_VERSION` from
// `saveSettingsUnlocked` reds the round-trip arm alone.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = new Map<string, unknown>();
const keychain = new Map<string, string>();
const invoke = vi.fn((command: string, args: { key: string; value?: string }): Promise<unknown> => {
  if (command === 'secret_load') return Promise.resolve(keychain.get(args.key) ?? null);
  if (command === 'secret_save') {
    keychain.set(args.key, args.value ?? '');
    return Promise.resolve(null);
  }
  if (command === 'secret_delete') {
    keychain.delete(args.key);
    return Promise.resolve(null);
  }
  return Promise.reject(new Error(`unexpected command ${command}`));
});

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(disk.get(key) as T | undefined);
    }
    set(key: string, value: unknown): Promise<void> {
      disk.set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const { DEFAULT_SETTINGS, SETTINGS_VERSION, loadSettings, resetKeychainCache, saveSettings } =
  await import('../../src/lib/settings');

/** A settings.json as an existing install would have it — everything but the field under test. */
const EXISTING_INSTALL = {
  baseUrl: 'https://api.example.test',
  themeMode: 'light',
  themeAccent: 'oxblood',
  telemetryOptIn: false,
  startUrl: 'https://example.test/start',
};

beforeEach(() => {
  disk.clear();
  keychain.clear();
  invoke.mockClear();
  resetKeychainCache();
});

describe('auto-update is on unless the customer turned it off (T-14)', () => {
  it("CRITICAL a settings.json with NO autoUpdate key loads as ON — the migration for every install written before this default, and the one the owner's Mac needed", async () => {
    disk.set('driftstack', { ...EXISTING_INSTALL });
    const loaded = await loadSettings();
    expect(loaded.autoUpdate).toBe(true);
    // Vacuity control: the loader read THIS file, not a default object — the
    // other fields round-trip from the same seeded record.
    expect(loaded.baseUrl).toBe(EXISTING_INSTALL.baseUrl);
    expect(loaded.themeMode).toBe('light');
    expect(loaded.startUrl).toBe(EXISTING_INSTALL.startUrl);
  });

  it("CRITICAL a stored `false` with NO layout marker loads as ON — the owner's measured file, where the OFF default was echoed by a save the customer made for something else", async () => {
    // Measured 2026-09-07: `autoUpdate: false` in a settings.json the running
    // 0.1.15 had rewritten that morning, switch never touched. The file has
    // every other key an install of that era has and no `settingsVersion`.
    disk.set('driftstack', { ...EXISTING_INSTALL, autoUpdate: false });
    const loaded = await loadSettings();
    expect(loaded.autoUpdate).toBe(true);
    // Vacuity control: the loader read THIS file — the other fields round-trip.
    expect(loaded.baseUrl).toBe(EXISTING_INSTALL.baseUrl);
    expect(loaded.startUrl).toBe(EXISTING_INSTALL.startUrl);
  });

  it('CRITICAL a stored `false` UNDER the marker stays false — only a build whose default is ON writes the marker, so that `false` came from the switch', async () => {
    disk.set('driftstack', {
      ...EXISTING_INSTALL,
      autoUpdate: false,
      settingsVersion: SETTINGS_VERSION,
    });
    expect((await loadSettings()).autoUpdate).toBe(false);
  });

  it('a stored `true` stays true, marker or not', async () => {
    disk.set('driftstack', { ...EXISTING_INSTALL, autoUpdate: true });
    expect((await loadSettings()).autoUpdate).toBe(true);
    disk.set('driftstack', {
      ...EXISTING_INSTALL,
      autoUpdate: true,
      settingsVersion: SETTINGS_VERSION,
    });
    expect((await loadSettings()).autoUpdate).toBe(true);
  });

  it('the marker decides, not the boolean: an older marker or a non-number one migrates the same `false`, a newer one keeps it', async () => {
    // Control for the two arms above — the same `false` in every record, and
    // only the marker changes. A loader keyed on the boolean cannot pass this.
    disk.set('driftstack', { ...EXISTING_INSTALL, autoUpdate: false, settingsVersion: 1 });
    expect((await loadSettings()).autoUpdate, 'older layout').toBe(true);
    disk.set('driftstack', { ...EXISTING_INSTALL, autoUpdate: false, settingsVersion: '2' });
    expect((await loadSettings()).autoUpdate, 'a marker that is not a number').toBe(true);
    disk.set('driftstack', {
      ...EXISTING_INSTALL,
      autoUpdate: false,
      settingsVersion: SETTINGS_VERSION + 1,
    });
    expect((await loadSettings()).autoUpdate, 'a newer layout still means chosen').toBe(false);
  });

  it('a non-boolean value (a hand edit, a truncated write) takes the default rather than being read as a choice — the control that proves the boolean check decides, not the raw value', async () => {
    // Under the marker, so the type check is the only thing that can reject it.
    disk.set('driftstack', {
      ...EXISTING_INSTALL,
      autoUpdate: 'false',
      settingsVersion: SETTINGS_VERSION,
    });
    expect((await loadSettings()).autoUpdate).toBe(true);
    disk.set('driftstack', {
      ...EXISTING_INSTALL,
      autoUpdate: 0,
      settingsVersion: SETTINGS_VERSION,
    });
    expect((await loadSettings()).autoUpdate).toBe(true);
  });

  it('CRITICAL the migration happens ONCE: a save stamps the marker, so a `false` chosen on this build survives the next load', async () => {
    // Start from the owner's file, which the load above migrates to ON…
    disk.set('driftstack', { ...EXISTING_INSTALL, autoUpdate: false });
    const migrated = await loadSettings();
    expect(migrated.autoUpdate).toBe(true);
    // …then the customer flips the switch OFF, which saves the whole object.
    await saveSettings({ ...migrated, autoUpdate: false }, { credentialUnchanged: true });
    expect(disk.get('driftstack')).toMatchObject({
      autoUpdate: false,
      settingsVersion: SETTINGS_VERSION,
    });
    // The next launch reads a marked `false`: the choice, not an echo.
    expect((await loadSettings()).autoUpdate).toBe(false);
  });

  it('the absent case is filled from DEFAULT_SETTINGS, and that default is ON', async () => {
    // Pins the two halves together: the loader defers to DEFAULT_SETTINGS, and
    // DEFAULT_SETTINGS says ON. Either half alone would let the other drift.
    expect(DEFAULT_SETTINGS.autoUpdate).toBe(true);
    disk.set('driftstack', undefined);
    expect((await loadSettings()).autoUpdate).toBe(DEFAULT_SETTINGS.autoUpdate);
  });

  it('the read itself writes nothing back — neither the value nor the marker', async () => {
    // Loading must not turn "never said" into "said yes" on disk, and must not
    // stamp the marker over an unmarked `false`: only a save that carries the
    // customer's own value may claim it as a choice. (The one-time plaintext
    // purge is the only writer in loadSettings and it is not triggered here.)
    disk.set('driftstack', { ...EXISTING_INSTALL });
    await loadSettings();
    expect(disk.get('driftstack')).toEqual(EXISTING_INSTALL);
    const unmarkedFalse = { ...EXISTING_INSTALL, autoUpdate: false };
    disk.set('driftstack', { ...unmarkedFalse });
    await loadSettings();
    expect(disk.get('driftstack')).toEqual(unmarkedFalse);
  });
});
