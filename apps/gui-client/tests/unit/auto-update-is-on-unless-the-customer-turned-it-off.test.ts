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
//
// T-14 BUG 1 — the marker must land on the FIRST load, not only on a later save.
// loadSettings now persists the resolved whole object (stamping the marker)
// whenever the file predates it, so a set-and-forget OFF (no marker, no legacy
// key) is migrated ONCE instead of re-migrated on every launch forever. Mutation
// for that arm: narrow the loader's persist guard back to the plaintext-purge
// condition alone (`if (hasLegacyPlaintext)`), i.e. stamp only in the purge
// branch — the "load stamps the marker / a second load does not re-migrate" arm
// reds while the honor arm (an already-marked `false`) stays green because it
// was never rewritten in the first place.

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

// A locked/failing store, toggled per-case, so the best-effort marker write can
// be exercised (the load must survive a store that rejects the stamp).
let storeShouldThrow = false;
function setShouldThrow(v: boolean): void {
  storeShouldThrow = v;
}
// Counts ACTUAL whole-object writes, so an arm can prove loadSettings writes
// NOTHING for an already-marked file — a content compare cannot (a value-identical
// rewrite passes toEqual), so a `set` on every load would slip past. Reset per case.
let storeSetCalls = 0;

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(disk.get(key) as T | undefined);
    }
    set(key: string, value: unknown): Promise<void> {
      if (storeShouldThrow) return Promise.reject(new Error('store locked'));
      storeSetCalls += 1;
      disk.set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      if (storeShouldThrow) return Promise.reject(new Error('store locked'));
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
  storeShouldThrow = false;
  storeSetCalls = 0;
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

  it('CRITICAL BUG 1 the FIRST load stamps the marker for a set-and-forget OFF — so the migration is one-time by construction even with no legacy key', async () => {
    // The owner's file shape reduced to the failure that never terminated: an
    // explicit `autoUpdate: false` with NO marker and NO legacy plaintext key.
    // Before the fix the marker was stamped only by an explicit whole-object
    // save or the plaintext-purge branch — neither of which a set-and-forget
    // customer ever triggers — so every launch re-read version 0, forced the ON
    // default in memory, wrote nothing back, and re-migrated the OFF to ON
    // forever. The load must now write the marker itself.
    const unmarkedFalse = { ...EXISTING_INSTALL, autoUpdate: false };
    disk.set('driftstack', { ...unmarkedFalse });

    const first = await loadSettings();
    expect(first.autoUpdate, 'migrated ON in memory on first load').toBe(true);
    // The migration WROTE the whole object exactly once — the write that was
    // missing, and the whole reason the migration terminates.
    expect(storeSetCalls, 'the first-load migration stamps the marker (one write)').toBe(1);
    // The store now HOLDS the marker AND the resolved (migrated) value.
    expect(disk.get('driftstack')).toMatchObject({
      autoUpdate: true,
      settingsVersion: SETTINGS_VERSION,
    });
    // Vacuity: the write is the RESOLVED object, not a default one — every other
    // field round-trips from the seeded record rather than being reset.
    expect(disk.get('driftstack')).toMatchObject({
      baseUrl: EXISTING_INSTALL.baseUrl,
      themeMode: EXISTING_INSTALL.themeMode,
      startUrl: EXISTING_INSTALL.startUrl,
      telemetryOptIn: EXISTING_INSTALL.telemetryOptIn,
    });

    // A SECOND load reads a marked file: it does not re-migrate, and — the honor
    // property that makes the fix safe — a marked value is left exactly as it is.
    const before = JSON.stringify(disk.get('driftstack'));
    const writesBeforeSecond = storeSetCalls;
    const second = await loadSettings();
    expect(second.autoUpdate, 'second load holds the migrated value, not re-migrated').toBe(true);
    expect(JSON.stringify(disk.get('driftstack')), 'a marked file is not rewritten').toBe(before);
    // The load of a now-marked file writes NOTHING — this is what a content compare
    // alone cannot prove, and what makes stamp-on-load one-time rather than every-launch.
    expect(storeSetCalls, 'second load of a marked file writes nothing').toBe(writesBeforeSecond);
  });

  it('CRITICAL BUG 1 honor arm: an already-marked `false` STAYS false across loads AND the read writes nothing back', async () => {
    // A genuine post-marker choice: `false` under `settingsVersion: 2`. The load
    // must neither migrate it (it is a choice) nor rewrite the file (there is
    // nothing to migrate). This is the arm that proves stamping-on-load did not
    // become "stamp on every load", which would churn the store on every launch
    // and could clobber a concurrent write.
    const markedFalse = {
      ...EXISTING_INSTALL,
      autoUpdate: false,
      settingsVersion: SETTINGS_VERSION,
    };
    disk.set('driftstack', { ...markedFalse });

    expect((await loadSettings()).autoUpdate, 'first load keeps the choice').toBe(false);
    expect(disk.get('driftstack'), 'first load rewrites nothing').toEqual(markedFalse);
    // ⛔ The write-count is the real over-stamp guard: a value-identical rewrite
    // passes the toEqual above, so only a zero write-count proves the load did not
    // stamp-on-every-launch (the `if (true)` over-stamp mutation reds HERE).
    expect(storeSetCalls, 'a marked file triggers NO write on load').toBe(0);
    expect((await loadSettings()).autoUpdate, 'second load keeps the choice').toBe(false);
    expect(disk.get('driftstack'), 'second load rewrites nothing').toEqual(markedFalse);
    expect(storeSetCalls, 'still no write after a second load').toBe(0);
  });

  it('a store write failure while stamping the marker does not break the load — the in-memory resolution still stands', async () => {
    // Best-effort by design (mirrors keychainSave): persistence can be lost
    // without failing the load, and the next launch retries the stamp.
    disk.set('driftstack', { ...EXISTING_INSTALL, autoUpdate: false });
    setShouldThrow(true);
    try {
      const loaded = await loadSettings();
      expect(loaded.autoUpdate, 'still migrated in memory despite the failed write').toBe(true);
    } finally {
      setShouldThrow(false);
    }
  });
});
