// T-3 host move, step 6 (2026-09-05) — an EXISTING install's persisted start page moves
// with the website. The migration in lib/settings.ts only rewrites the value this app
// itself shipped as a default; a start URL the customer typed is theirs and stays.
//
// Found by the plan-completion verification: 70efb77a6 changed DEFAULT_SETTINGS.startUrl
// to the .io page but listed the NEW .io forms as the legacy set, so an install that had
// persisted the old `https://driftstack.dev/newtab/` default was never migrated and kept
// opening the .dev start page — invisible on a clean install, which looks correct.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = new Map<string, unknown>();
const keychain = new Map<string, string>();

const invoke = vi.fn((cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === 'keychain_get') return Promise.resolve(keychain.get(String(args?.['key'])) ?? null);
  if (cmd === 'keychain_set') {
    const value = args?.['value'];
    keychain.set(String(args?.['key']), typeof value === 'string' ? value : '');
    return Promise.resolve(null);
  }
  return Promise.resolve(null);
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

const { DEFAULT_SETTINGS, loadSettings } = await import('../../src/lib/settings');

// The key lib/settings.ts writes under (STORE_FILE settings.json, SETTINGS_KEY 'driftstack').
const SETTINGS_KEY = 'driftstack';

describe('T-3 step 6 — a persisted .dev start page migrates to the .io default', () => {
  beforeEach(() => {
    disk.clear();
    keychain.clear();
  });

  it('the shipped default is the .io start page', () => {
    expect(DEFAULT_SETTINGS.startUrl).toBe('https://driftstack.io/newtab/');
  });

  it.each([
    'https://driftstack.dev/newtab/',
    'https://driftstack.dev/newtab',
    'https://driftstack.dev/',
    'https://driftstack.dev',
  ])(
    'CRITICAL an install that persisted the old default %s opens the .io start page',
    async (legacy) => {
      disk.set(SETTINGS_KEY, { baseUrl: DEFAULT_SETTINGS.baseUrl, startUrl: legacy });
      const settings = await loadSettings();
      expect(settings.startUrl).toBe('https://driftstack.io/newtab/');
    },
  );

  it('a start URL the customer typed is left alone — the migration touches only the shipped default', async () => {
    disk.set(SETTINGS_KEY, {
      baseUrl: DEFAULT_SETTINGS.baseUrl,
      startUrl: 'https://example.com/dashboard',
    });
    const settings = await loadSettings();
    expect(settings.startUrl).toBe('https://example.com/dashboard');
  });

  it('the .io default round-trips unchanged', async () => {
    disk.set(SETTINGS_KEY, {
      baseUrl: DEFAULT_SETTINGS.baseUrl,
      startUrl: 'https://driftstack.io/newtab/',
    });
    const settings = await loadSettings();
    expect(settings.startUrl).toBe('https://driftstack.io/newtab/');
  });
});
