// Security regression: the expiring simulator control credential lives only in
// the native process vault. WebView code receives a non-secret generation and
// has no writable or generic-Keychain command.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type NativeArgs = { sessionId?: string; generation?: number };
const nativeVault = new Map<string, string>();

function identity(args: NativeArgs): string {
  return `${args.sessionId ?? ''}\u0000${args.generation ?? 0}`;
}

const invoke = vi.fn((command: string, args: NativeArgs): Promise<unknown> => {
  if (command === 'simulator_control_key_load') {
    return Promise.resolve(nativeVault.get(identity(args)) ?? null);
  }
  if (command === 'simulator_control_key_delete') {
    nativeVault.delete(identity(args));
    return Promise.resolve(null);
  }
  return Promise.reject(new Error(`unexpected command ${command}`));
});

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const {
  clearPersistedControlKey,
  loadProtectedControlKey,
  safeSimulatorSearch,
  scrubLegacyControlKeys,
} = await import('../../src/lib/simulator-control-key');

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    this.reads.push(key);
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

describe('simulator native process control-key bridge', () => {
  beforeEach(() => {
    nativeVault.clear();
    invoke.mockClear();
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });

  it('loads only the exact session generation through the dedicated command', async () => {
    nativeVault.set('agt_safe-1\u00007', 'gck_secret');
    nativeVault.set('agt_safe-1\u00008', 'gck_successor');

    await expect(loadProtectedControlKey('agt_safe-1', 7)).resolves.toBe('gck_secret');
    await expect(loadProtectedControlKey('agt_safe-1', 8)).resolves.toBe('gck_successor');
    await expect(loadProtectedControlKey('agt_other', 7)).resolves.toBe('');

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'simulator_control_key_load',
      'simulator_control_key_load',
      'simulator_control_key_load',
    ]);
    expect(invoke.mock.calls.some(([command]) => String(command).startsWith('secret_'))).toBe(
      false,
    );
  });

  it('makes an old-generation delete unable to remove its successor', async () => {
    nativeVault.set('agt_reused\u000011', 'gck_old');
    nativeVault.set('agt_reused\u000012', 'gck_new');

    await clearPersistedControlKey('agt_reused', 11);

    await expect(loadProtectedControlKey('agt_reused', 11)).resolves.toBe('');
    await expect(loadProtectedControlKey('agt_reused', 12)).resolves.toBe('gck_new');
  });

  it('serializes same-generation operations and recovers after a failed IPC turn', async () => {
    nativeVault.set('agt_ordered\u00003', 'gck_ordered');
    let releaseLoad: (() => void) | undefined;
    invoke.mockImplementationOnce(
      (command: string, args: NativeArgs): Promise<unknown> =>
        new Promise((resolve) => {
          expect(command).toBe('simulator_control_key_load');
          releaseLoad = () => resolve(nativeVault.get(identity(args)) ?? null);
        }),
    );

    const load = loadProtectedControlKey('agt_ordered', 3);
    await vi.waitFor(() => expect(releaseLoad).toBeTypeOf('function'));
    const clear = clearPersistedControlKey('agt_ordered', 3);
    expect(invoke).toHaveBeenCalledTimes(1);
    releaseLoad?.();
    await expect(load).resolves.toBe('gck_ordered');
    await clear;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'simulator_control_key_load',
      'simulator_control_key_delete',
    ]);

    invoke.mockRejectedValueOnce(new Error('native unavailable'));
    await expect(loadProtectedControlKey('agt_ordered', 3)).rejects.toThrow('native unavailable');
    nativeVault.set('agt_ordered\u00003', 'gck_recovered');
    await expect(loadProtectedControlKey('agt_ordered', 3)).resolves.toBe('gck_recovered');
  });

  it('fails closed after a native process restart', async () => {
    nativeVault.set('agt_restart\u00005', 'gck_process_only');
    await expect(loadProtectedControlKey('agt_restart', 5)).resolves.toBe('gck_process_only');

    nativeVault.clear();
    await expect(loadProtectedControlKey('agt_restart', 5)).resolves.toBe('');
  });

  it('scrubs every legacy plaintext entry without reading or importing its value', () => {
    storage.setItem('ds-gck-agt_first', 'gck_first');
    storage.setItem('ds-gck-../../invalid', 'gck_invalid');
    storage.setItem('unrelated-preference', 'keep');

    scrubLegacyControlKeys();

    expect([...storage.values.entries()]).toEqual([['unrelated-preference', 'keep']]);
    expect(storage.reads).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects unsafe identities without native IPC', async () => {
    await expect(loadProtectedControlKey('../../escape', 1)).resolves.toBe('');
    await expect(loadProtectedControlKey('agt_safe', 0)).resolves.toBe('');
    await expect(loadProtectedControlKey('agt_safe', Number.MAX_SAFE_INTEGER + 1)).resolves.toBe(
      '',
    );
    await clearPersistedControlKey('agt_safe', -1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('retains only safe non-secret routing and generation fields', () => {
    const safe = new URLSearchParams(safeSimulatorSearch('agt_safe', 42));
    expect(safe.get('window')).toBe('simulator');
    expect(safe.get('session')).toBe('agt_safe');
    expect(safe.get('cg')).toBe('42');
    expect(safe.has('token')).toBe(false);
    expect(safe.has('ck')).toBe(false);
    expect(safe.has('cke')).toBe(false);

    const unavailableNative = new URLSearchParams(safeSimulatorSearch('../../escape', 0));
    expect(unavailableNative.toString()).toBe('window=simulator&cg=0');
    const inApp = new URLSearchParams(safeSimulatorSearch('../../escape', null));
    expect(inApp.toString()).toBe('window=simulator');
  });
});
