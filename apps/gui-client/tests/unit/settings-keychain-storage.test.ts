// Security regression: every deployment API key belongs in the OS credential
// store. Older builds wrote self-hosted keys to settings.json (flat `apiKey`
// plus a multi-host `apiKeys` map), creating a plaintext credential inventory.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = new Map<string, unknown>();
const keychain = new Map<string, string>();
let failSaves = false;
const invoke = vi.fn((command: string, args: { key: string; value?: string }): Promise<unknown> => {
  if (command === 'secret_load') return Promise.resolve(keychain.get(args.key) ?? null);
  if (command === 'secret_save') {
    if (failSaves) return Promise.reject(new Error('credential store locked'));
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

const { DEFAULT_SETTINGS, loadBaseUrl, loadSettings, rememberedKeyFor, saveSettings } =
  await import('../../src/lib/settings');

describe('settings API-key protected storage', () => {
  beforeEach(() => {
    disk.clear();
    keychain.clear();
    failSaves = false;
    invoke.mockClear();
  });

  it('saves a self-hosted key only to its scoped keychain entry, never settings.json', async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      baseUrl: 'https://driftstack.internal.acme.com',
      apiKey: 'ds_live_self_hosted_secret',
    });

    expect(keychain.get('api_key:driftstack.internal.acme.com')).toBe('ds_live_self_hosted_secret');
    const persisted = disk.get('driftstack') as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('apiKey');
    expect(persisted).not.toHaveProperty('apiKeys');
    expect(JSON.stringify(persisted)).not.toContain('ds_live_self_hosted_secret');
  });

  it('does not touch the credential store for a known-unchanged key/deployment tuple', async () => {
    keychain.set('api_key:api.driftstack.dev', 'ds_live_existing');
    invoke.mockClear();

    await saveSettings(
      {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.driftstack.dev',
        apiKey: 'ds_live_existing',
        telemetryOptIn: true,
      },
      { credentialUnchanged: true },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(keychain.get('api_key:api.driftstack.dev')).toBe('ds_live_existing');
    expect(disk.get('driftstack')).toMatchObject({ telemetryOptIn: true });
  });

  it('loads only the non-secret base URL without invoking the credential store', async () => {
    disk.set('driftstack', {
      baseUrl: 'https://simulator-control.example.com',
      apiKey: 'legacy-value-that-must-not-be-read-or-migrated',
    });

    await expect(loadBaseUrl()).resolves.toBe('https://simulator-control.example.com');
    expect(invoke).not.toHaveBeenCalled();
    expect(keychain.size).toBe(0);
  });

  it('migrates and purges legacy flat + multi-host plaintext keys on first load', async () => {
    disk.set('driftstack', {
      baseUrl: 'http://localhost:3000',
      apiKey: 'ds_test_flat_legacy',
      apiKeys: {
        localhost_3000: 'ds_test_active_legacy',
        'driftstack.internal.acme.com': 'ds_live_other_legacy',
      },
    });

    const loaded = await loadSettings();
    expect(loaded.apiKey).toBe('ds_test_active_legacy');
    expect(keychain.get('api_key:localhost_3000')).toBe('ds_test_active_legacy');
    expect(keychain.get('api_key:driftstack.internal.acme.com')).toBe('ds_live_other_legacy');
    const persisted = disk.get('driftstack') as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('apiKey');
    expect(persisted).not.toHaveProperty('apiKeys');
    expect(JSON.stringify(persisted)).not.toContain('legacy');
  });

  it('restores a remembered self-hosted deployment from its scoped keychain entry', async () => {
    keychain.set('api_key:onprem.example.com', 'ds_live_onprem');
    await expect(rememberedKeyFor('https://onprem.example.com')).resolves.toBe('ds_live_onprem');
  });

  it('purges legacy plaintext even when the credential store is locked, retaining it only in memory', async () => {
    disk.set('driftstack', {
      baseUrl: 'https://onprem.example.com',
      apiKey: 'ds_live_memory_only',
    });
    failSaves = true;

    const loaded = await loadSettings();
    expect(loaded.apiKey).toBe('ds_live_memory_only');
    expect(keychain.size).toBe(0);
    expect(JSON.stringify(disk.get('driftstack'))).not.toContain('ds_live_memory_only');
  });

  it('rejects an ordinary save when the key remains memory-only', async () => {
    failSaves = true;

    await expect(
      saveSettings({
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.driftstack.dev',
        apiKey: 'ds_live_memory_only',
      }),
    ).rejects.toThrow('credential store write failed');

    expect(keychain.size).toBe(0);
    expect(JSON.stringify(disk.get('driftstack'))).not.toContain('ds_live_memory_only');
  });

  it('sign-out deletes current scoped and legacy entries without writing a disk fallback', async () => {
    keychain.set('api_key:onprem.example.com', 'ds_live_onprem');
    keychain.set('api_key', 'ds_live_legacy');
    await saveSettings({
      ...DEFAULT_SETTINGS,
      baseUrl: 'https://onprem.example.com',
      apiKey: null,
    });
    expect(keychain.has('api_key:onprem.example.com')).toBe(false);
    expect(keychain.has('api_key')).toBe(false);
    expect(JSON.stringify(disk.get('driftstack'))).not.toContain('ds_live');
  });
});
