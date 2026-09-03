// Owner, T-12: "On small screens, the simulator may take almost all of the
// screen; we may want it smaller." — and once it is smaller, it should stay the
// size the customer left it at.
//
// MEASURED: settings.json held nothing about the simulator window. The window
// opened at 330×718 every time, and the fresh-open fit (`resetToActualSize`)
// then sized it from the archetype, so a manual resize lasted exactly one open.
//
// `simulatorWindowSize` is the new optional field in lib/settings.ts: a map of
// screen key → `{ width, height }`. These arms pin the storage contract the
// simulator window and the opener rely on:
//   • `persistSimulatorWindowSize` merges one screen's size in, keeps every other
//     screen and every other setting, and never opens the keychain;
//   • `loadSimulatorWindowSize` reads it back, also without the keychain;
//   • `loadSettings` validates entry by entry and carries the field only when it
//     has something in it;
//   • the two WHOLE-OBJECT rewrites (`saveSettings`, and the one-time plaintext
//     purge in `loadSettings`) keep the remembered sizes — the V-1611 lesson,
//     where `autoUpdate` was silently dropped by exactly such a rewrite.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = new Map<string, unknown>();
let setCalls = 0;
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
      setCalls += 1;
      disk.set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSimulatorWindowSize,
  persistSimulatorWindowSize,
  resetKeychainCache,
  saveSettings,
} = await import('../../src/lib/settings');

const LAPTOP = '1440x875';
const DESK = '2560x1415';
const persisted = (): Record<string, unknown> => disk.get('driftstack') as Record<string, unknown>;

beforeEach(() => {
  disk.clear();
  keychain.clear();
  setCalls = 0;
  invoke.mockClear();
  resetKeychainCache();
});

describe('persistSimulatorWindowSize — merge-only, per screen', () => {
  it('remembers the size under its screen key and keeps every other setting', async () => {
    disk.set('driftstack', { baseUrl: 'https://api.driftstack.dev', themeMode: 'light' });
    await persistSimulatorWindowSize(LAPTOP, { width: 300, height: 650 });
    expect(persisted()).toEqual({
      baseUrl: 'https://api.driftstack.dev',
      themeMode: 'light',
      simulatorWindowSize: { [LAPTOP]: { width: 300, height: 650 } },
    });
  });

  it('never opens the keychain — a resize must not raise a credential prompt', async () => {
    await persistSimulatorWindowSize(LAPTOP, { width: 300, height: 650 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a second screen is added; the first is kept', async () => {
    await persistSimulatorWindowSize(LAPTOP, { width: 300, height: 650 });
    await persistSimulatorWindowSize(DESK, { width: 422, height: 900 });
    expect(persisted().simulatorWindowSize).toEqual({
      [LAPTOP]: { width: 300, height: 650 },
      [DESK]: { width: 422, height: 900 },
    });
  });

  it('VACUITY CONTROL: an unchanged size is not rewritten (the handler fires after every settled resize)', async () => {
    await persistSimulatorWindowSize(LAPTOP, { width: 300, height: 650 });
    const after = setCalls;
    await persistSimulatorWindowSize(LAPTOP, { width: 300, height: 650 });
    expect(setCalls).toBe(after);
  });

  it('a size that is not a size (NaN, non-positive) is not stored', async () => {
    await persistSimulatorWindowSize(LAPTOP, { width: Number.NaN, height: -5 });
    expect(disk.has('driftstack')).toBe(false);
  });
});

describe('loadSimulatorWindowSize — the read the opener makes', () => {
  it('reads the remembered size for the screen back', async () => {
    await persistSimulatorWindowSize(LAPTOP, { width: 300, height: 650 });
    expect(await loadSimulatorWindowSize(LAPTOP)).toEqual({ width: 300, height: 650 });
  });

  it('VACUITY CONTROL: a screen with nothing remembered reads null', async () => {
    await persistSimulatorWindowSize(LAPTOP, { width: 300, height: 650 });
    expect(await loadSimulatorWindowSize(DESK)).toBeNull();
  });

  it('never opens the keychain — opening a window must not raise a credential prompt', async () => {
    await loadSimulatorWindowSize(LAPTOP);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('loadSettings — validated entry by entry, absent when empty', () => {
  it('keeps the good entry and drops a hand-edited one, not the whole map', async () => {
    disk.set('driftstack', {
      simulatorWindowSize: {
        [LAPTOP]: { width: 300, height: 650 },
        [DESK]: { width: 'wide', height: 900 },
        '': { width: 1, height: 1 },
      },
    });
    expect((await loadSettings()).simulatorWindowSize).toEqual({
      [LAPTOP]: { width: 300, height: 650 },
    });
  });

  it('VACUITY CONTROL: with nothing remembered the field is ABSENT (not `{}`), like an older settings.json', async () => {
    disk.set('driftstack', { baseUrl: 'https://api.driftstack.dev' });
    expect('simulatorWindowSize' in (await loadSettings())).toBe(false);
  });

  it('CRITICAL the one-time plaintext purge rewrites the whole object and KEEPS the remembered sizes', async () => {
    disk.set('driftstack', {
      apiKey: 'ds_live_legacy_plaintext',
      simulatorWindowSize: { [LAPTOP]: { width: 300, height: 650 } },
    });
    await loadSettings();
    expect(persisted()).not.toHaveProperty('apiKey');
    expect(persisted().simulatorWindowSize).toEqual({ [LAPTOP]: { width: 300, height: 650 } });
  });
});

describe('saveSettings — the Settings view cannot forget what the simulator remembered', () => {
  it('CRITICAL a save that carries no sizes keeps the ones on disk (remembered after this copy was loaded)', async () => {
    await persistSimulatorWindowSize(LAPTOP, { width: 300, height: 650 });
    await saveSettings({ ...DEFAULT_SETTINGS, themeMode: 'light' }, { credentialUnchanged: true });
    expect(persisted().simulatorWindowSize).toEqual({ [LAPTOP]: { width: 300, height: 650 } });
  });

  it('a save that carries sizes writes those', async () => {
    await persistSimulatorWindowSize(LAPTOP, { width: 300, height: 650 });
    await saveSettings(
      { ...DEFAULT_SETTINGS, simulatorWindowSize: { [DESK]: { width: 422, height: 900 } } },
      { credentialUnchanged: true },
    );
    expect(persisted().simulatorWindowSize).toEqual({ [DESK]: { width: 422, height: 900 } });
  });

  it('VACUITY CONTROL: with nothing on disk and none carried, the saved object has no such key', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS }, { credentialUnchanged: true });
    expect(persisted()).not.toHaveProperty('simulatorWindowSize');
  });
});
