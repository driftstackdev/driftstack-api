// Security regression: 24h simulator control credentials belong in the OS
// credential store, never WebView localStorage or reload history.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = new Map<string, string>();
let credentialStoreLocked = false;
const invoke = vi.fn((command: string, args: { key: string; value?: string }): Promise<unknown> => {
  if (credentialStoreLocked) return Promise.reject(new Error('credential store locked'));
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

const {
  clearPersistedControlKey,
  loadProtectedControlKey,
  migrateLegacyControlKeys,
  persistControlKey,
  safeSimulatorSearch,
} = await import('../../src/lib/simulator-control-key');

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

let storage: MemoryStorage;

describe('simulator control-key protected storage', () => {
  beforeEach(() => {
    keychain.clear();
    credentialStoreLocked = false;
    invoke.mockClear();
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });

  it('persists and restores a session key only through its scoped credential-store item', async () => {
    await persistControlKey('agt_safe-1', 'gck_secret');
    expect(keychain.get('gui_control:agt_safe-1')).toBe('gck_secret');
    expect(storage.length).toBe(0);
    await expect(loadProtectedControlKey('agt_safe-1')).resolves.toBe('gck_secret');
    expect(invoke.mock.calls.filter(([command]) => command === 'secret_load')).toHaveLength(0);
  });

  it('purges every legacy value but migrates only the active session', async () => {
    storage.setItem('ds-gck-agt_first', 'gck_first');
    storage.setItem('ds-gck-agt_second', 'gck_second');
    storage.setItem('ds-gck-../../invalid', 'gck_invalid');
    storage.setItem('unrelated-preference', 'keep');

    const legacy = await migrateLegacyControlKeys('agt_second');

    expect(legacy).toEqual(
      new Map([
        ['agt_first', 'gck_first'],
        ['agt_second', 'gck_second'],
      ]),
    );
    expect(keychain.has('gui_control:agt_first')).toBe(false);
    expect(keychain.get('gui_control:agt_second')).toBe('gck_second');
    expect([...storage.values.keys()]).toEqual(['unrelated-preference']);
  });

  it('prefers an existing protected value over stale legacy plaintext', async () => {
    keychain.set('gui_control:agt_same', 'gck_current');
    storage.setItem('ds-gck-agt_same', 'gck_stale');

    await migrateLegacyControlKeys('agt_same');
    await expect(loadProtectedControlKey('agt_same')).resolves.toBe('gck_current');

    expect(keychain.get('gui_control:agt_same')).toBe('gck_current');
    expect(storage.getItem('ds-gck-agt_same')).toBeNull();
    expect(invoke.mock.calls.filter(([command]) => command === 'secret_load')).toHaveLength(1);
  });

  it('a sessionless upgrade purges historical plaintext without creating stale Keychain entries', async () => {
    storage.setItem('ds-gck-agt_expired_1', 'gck_expired_1');
    storage.setItem('ds-gck-agt_expired_2', 'gck_expired_2');

    const legacy = await migrateLegacyControlKeys('');

    expect(legacy.size).toBe(2);
    expect(storage.length).toBe(0);
    expect(keychain.size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('purges plaintext while Keychain is locked and returns only an in-memory launch fallback', async () => {
    storage.setItem('ds-gck-agt_locked', 'gck_memory_only');
    credentialStoreLocked = true;

    const legacy = await migrateLegacyControlKeys('agt_locked');
    await expect(loadProtectedControlKey('agt_locked')).rejects.toThrow('credential store locked');

    expect(legacy.get('agt_locked')).toBe('gck_memory_only');
    expect(storage.getItem('ds-gck-agt_locked')).toBeNull();
    expect(keychain.size).toBe(0);
    expect(invoke.mock.calls.filter(([command]) => command === 'secret_load')).toHaveLength(1);
  });

  it('deletes protected and stale legacy copies on explicit session end', async () => {
    keychain.set('gui_control:agt_end', 'gck_end');
    storage.setItem('ds-gck-agt_end', 'gck_stale');

    await clearPersistedControlKey('agt_end');

    expect(keychain.has('gui_control:agt_end')).toBe(false);
    expect(storage.getItem('ds-gck-agt_end')).toBeNull();
  });

  it('rejects unsafe ids without invoking the credential store and scrubs all secret fields', async () => {
    await persistControlKey('../../escape', 'gck_secret');
    await clearPersistedControlKey('../../escape');
    await expect(loadProtectedControlKey('../../escape')).resolves.toBe('');
    expect(invoke).not.toHaveBeenCalled();

    const safe = new URLSearchParams(safeSimulatorSearch('agt_safe'));
    expect(safe.get('window')).toBe('simulator');
    expect(safe.get('session')).toBe('agt_safe');
    expect(safe.has('token')).toBe(false);
    expect(safe.has('ck')).toBe(false);
  });
});
