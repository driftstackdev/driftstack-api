// Security regression: proxy passwords and VPN private configuration belong in
// the OS credential store, never the settings.json proxy registry.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProxyLibModule from '../../src/lib/proxies';

const disk = new Map<string, unknown>();
const keychain = new Map<string, string>();
let failSecretAccess = false;

const invoke = vi.fn((command: string, args: { key: string; value?: string }): Promise<unknown> => {
  if (command === 'secret_load') {
    if (failSecretAccess) return Promise.reject(new Error('credential store locked'));
    return Promise.resolve(keychain.get(args.key) ?? null);
  }
  if (command === 'secret_save') {
    if (failSecretAccess) return Promise.reject(new Error('credential store locked'));
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

type ProxyLib = typeof ProxyLibModule;
let proxyLib: ProxyLib;

async function reloadProxyLib(): Promise<void> {
  vi.resetModules();
  proxyLib = await import('../../src/lib/proxies');
}

const base = {
  label: 'Amsterdam',
  host: 'proxy.example.com',
  port: 1080,
  username: 'alice',
};

describe('proxy protected credential storage', () => {
  beforeEach(async () => {
    disk.clear();
    keychain.clear();
    failSecretAccess = false;
    invoke.mockClear();
    await reloadProxyLib();
  });

  it('adds SOCKS credentials to Keychain while persisting metadata only', async () => {
    const added = await proxyLib.addProxy({ ...base, password: 'socks-secret', scheme: 'socks5' });

    expect(added.password).toBe('socks-secret');
    const persisted = disk.get('proxies') as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).not.toHaveProperty('password');
    expect(persisted[0]).not.toHaveProperty('openvpn');
    expect(persisted[0]).not.toHaveProperty('wireguard');
    expect(JSON.stringify(persisted)).not.toContain('socks-secret');

    expect(keychain.get('proxy_vault_key')).toMatch(/^v1:/);
    expect([...keychain.keys()]).toEqual(['proxy_vault_key']);
    expect(JSON.stringify(disk.get('proxy_secret_envelopes_v2'))).not.toContain('socks-secret');
    await expect(proxyLib.listProxies()).resolves.toEqual([added]);
  });

  it('lists sanitized metadata without reading any protected value', async () => {
    disk.set('proxies', [
      {
        id: 'metadata-only',
        ...base,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    keychain.set('proxy_secret:metadata-only', 'must-not-be-read');

    await expect(proxyLib.listProxyMetadata()).resolves.toEqual([
      {
        id: 'metadata-only',
        ...base,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('migrates and purges legacy secrets before returning metadata', async () => {
    disk.set('proxies', [
      {
        id: 'legacy-metadata',
        ...base,
        password: 'legacy-secret',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const metadata = await proxyLib.listProxyMetadata();
    expect(metadata).toEqual([
      {
        id: 'legacy-metadata',
        ...base,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(keychain.get('proxy_vault_key')).toMatch(/^v1:/);
    expect(keychain.has('proxy_secret:legacy-metadata')).toBe(false);
    expect(JSON.stringify(disk.get('proxy_secret_envelopes_v2'))).not.toContain('legacy-secret');
    expect(JSON.stringify(disk.get('proxies'))).not.toContain('legacy-secret');
  });

  it('caches successful protected reads for the lifetime of the process', async () => {
    await proxyLib.addProxy({ ...base, password: 'cached-secret' });
    await reloadProxyLib();
    invoke.mockClear();

    await expect(proxyLib.listProxies()).resolves.toHaveLength(1);
    await expect(proxyLib.listProxies()).resolves.toHaveLength(1);
    expect(invoke.mock.calls.filter(([command]) => command === 'secret_load')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('secret_load', { key: 'proxy_vault_key' });
  });

  it('backs off after a protected-store denial instead of prompt-looping', async () => {
    await proxyLib.addProxy({ ...base, password: 'denied-secret' });
    await reloadProxyLib();
    invoke.mockClear();
    failSecretAccess = true;

    await expect(proxyLib.listProxies()).rejects.toThrow('credential store locked');
    await expect(proxyLib.listProxies()).rejects.toThrow('credential store locked');
    expect(invoke.mock.calls.filter(([command]) => command === 'secret_load')).toHaveLength(1);
  });

  it('hydrates five proxies with one Keychain read after a process restart', async () => {
    for (let i = 0; i < 5; i++) {
      await proxyLib.addProxy({
        ...base,
        label: `Proxy ${String(i + 1)}`,
        host: `proxy-${String(i + 1)}.example.com`,
        password: `secret-${String(i + 1)}`,
      });
    }
    expect([...keychain.keys()]).toEqual(['proxy_vault_key']);
    await reloadProxyLib();
    invoke.mockClear();

    const loaded = await proxyLib.listProxies();
    expect(loaded.map((proxy) => proxy.password)).toEqual([
      'secret-1',
      'secret-2',
      'secret-3',
      'secret-4',
      'secret-5',
    ]);
    expect(invoke.mock.calls.filter(([command]) => command === 'secret_load')).toEqual([
      ['secret_load', { key: 'proxy_vault_key' }],
    ]);
  });

  it('round-trips OpenVPN and WireGuard blocks only through protected storage', async () => {
    const openvpn = {
      config_blob: 'client\nremote vpn.example.com 1194\n<key>PRIVATE</key>',
      username: 'vpn-user',
      password: 'vpn-password',
    };
    const wireguard = {
      private_key: 'wg-private-key',
      peer_public_key: 'wg-peer-key',
      endpoint: 'wg.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.7.0.2/32',
      dns: '1.1.1.1',
    };

    const ovpn = await proxyLib.addProxy({
      ...base,
      label: 'OVPN',
      password: null,
      scheme: 'openvpn',
      openvpn,
    });
    const wg = await proxyLib.addProxy({
      ...base,
      label: 'WG',
      password: null,
      scheme: 'wireguard',
      wireguard,
    });

    const serializedDisk = JSON.stringify([...disk.values()]);
    expect(serializedDisk).not.toContain('PRIVATE');
    expect(serializedDisk).not.toContain('vpn-password');
    expect(serializedDisk).not.toContain('wg-private-key');
    expect((await proxyLib.listProxies()).find((proxy) => proxy.id === ovpn.id)?.openvpn).toEqual(
      openvpn,
    );
    expect((await proxyLib.listProxies()).find((proxy) => proxy.id === wg.id)?.wireguard).toEqual(
      wireguard,
    );
  });

  it('migrates legacy secret-bearing rows and purges every plaintext field', async () => {
    disk.set('proxies', [
      {
        id: 'legacy-socks',
        ...base,
        password: 'legacy-socks-secret',
        createdAt: '2026-01-01T00:00:00.000Z',
        scheme: 'socks5',
      },
      {
        id: 'legacy-wg',
        ...base,
        label: 'Legacy WG',
        password: null,
        createdAt: '2026-01-02T00:00:00.000Z',
        scheme: 'wireguard',
        wireguard: {
          private_key: 'legacy-wg-private',
          peer_public_key: 'peer',
          endpoint: 'wg.example.com:51820',
          allowed_ips: '0.0.0.0/0',
          address: '10.7.0.2/32',
        },
      },
    ]);

    const loaded = await proxyLib.listProxies();
    expect(loaded[0]?.password).toBe('legacy-socks-secret');
    expect(loaded[1]?.wireguard?.private_key).toBe('legacy-wg-private');
    expect([...keychain.keys()]).toEqual(['proxy_vault_key']);
    expect(JSON.stringify(disk.get('proxy_secret_envelopes_v2'))).not.toContain(
      'legacy-socks-secret',
    );
    expect(JSON.stringify(disk.get('proxy_secret_envelopes_v2'))).not.toContain(
      'legacy-wg-private',
    );
    const persisted = disk.get('proxies') as Record<string, unknown>[];
    for (const row of persisted) {
      expect(row).not.toHaveProperty('password');
      expect(row).not.toHaveProperty('openvpn');
      expect(row).not.toHaveProperty('wireguard');
    }
    expect(JSON.stringify(persisted)).not.toContain('legacy-socks-secret');
    expect(JSON.stringify(persisted)).not.toContain('legacy-wg-private');
  });

  it('prefers an existing protected value over a stale legacy plaintext copy', async () => {
    disk.set('proxies', [
      {
        id: 'already-protected',
        ...base,
        password: 'stale-disk-secret',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    keychain.set(
      'proxy_secret:already-protected',
      JSON.stringify({
        version: 1,
        binding: { host: base.host, port: base.port, username: base.username, scheme: null },
        password: 'current-protected-secret',
      }),
    );

    const loaded = await proxyLib.listProxies();
    expect(loaded[0]?.password).toBe('current-protected-secret');
    expect(keychain.has('proxy_secret:already-protected')).toBe(false);
    expect(keychain.get('proxy_vault_key')).toMatch(/^v1:/);
    expect(JSON.stringify(disk.get('proxies'))).not.toContain('stale-disk-secret');
  });

  it('purges a malformed non-array registry that may contain legacy credentials', async () => {
    disk.set('proxies', { password: 'orphaned-plaintext', private_key: 'orphaned-private' });
    await expect(proxyLib.listProxies()).resolves.toEqual([]);
    expect(disk.get('proxies')).toEqual([]);
    expect(JSON.stringify(disk.get('proxies'))).not.toContain('orphaned');
  });

  it('drops duplicate ids rather than aliasing one credential onto two endpoints', async () => {
    disk.set('proxies', [
      { id: 'duplicate', ...base, createdAt: '2026-01-01T00:00:00.000Z' },
      {
        id: 'duplicate',
        ...base,
        host: 'attacker-controlled.example',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    keychain.set(
      'proxy_secret:duplicate',
      JSON.stringify({
        version: 1,
        binding: { host: base.host, port: base.port, username: base.username, scheme: null },
        password: 'secret',
      }),
    );

    const loaded = await proxyLib.listProxies();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.host).toBe(base.host);
    expect(disk.get('proxies')).toHaveLength(1);
  });

  it('purges a legacy plaintext secret even while Keychain is locked', async () => {
    disk.set('proxies', [
      {
        id: 'memory-only',
        ...base,
        password: 'only-in-memory-this-launch',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    failSecretAccess = true;

    const loaded = await proxyLib.listProxies();
    expect(loaded[0]?.password).toBe('only-in-memory-this-launch');
    expect(keychain.size).toBe(0);
    expect(JSON.stringify(disk.get('proxies'))).not.toContain('only-in-memory-this-launch');
    await expect(proxyLib.listProxies()).resolves.toEqual(loaded);
  });

  it('fails closed without purging the only legacy copy when the vault key is corrupt', async () => {
    disk.set('proxies', [
      {
        id: 'recoverable-legacy',
        ...base,
        password: 'recoverable-secret',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    keychain.set('proxy_vault_key', 'not-versioned');

    await expect(proxyLib.listProxies()).rejects.toThrow('vault key has an unsupported format');
    expect(JSON.stringify(disk.get('proxies'))).toContain('recoverable-secret');
    expect(disk.get('proxy_secret_envelopes_v2')).toBeUndefined();
  });

  it('fails closed instead of adding a plaintext fallback when Keychain is locked', async () => {
    failSecretAccess = true;
    await expect(proxyLib.addProxy({ ...base, password: 'must-not-fallback' })).rejects.toThrow(
      'credential store locked',
    );
    expect(disk.get('proxies')).toBeUndefined();
    expect(JSON.stringify([...disk.values()])).not.toContain('must-not-fallback');
  });

  it('rejects an oversized secret before any ciphertext or metadata is persisted', async () => {
    const oversized = 'x'.repeat(128 * 1024);
    await expect(proxyLib.addProxy({ ...base, password: oversized })).rejects.toThrow(
      'exceed the storage limit',
    );
    expect(disk.get('proxies')).toBeUndefined();
    expect(disk.get('proxy_secret_envelopes_v2')).toBeUndefined();
    expect(JSON.stringify([...disk.values()])).not.toContain(oversized);
  });

  it('updates the protected payload without writing the replacement to disk', async () => {
    const added = await proxyLib.addProxy({ ...base, password: 'old-secret' });
    const updated = await proxyLib.updateProxy(added.id, { ...base, password: 'new-secret' });

    expect(updated?.password).toBe('new-secret');
    expect([...keychain.keys()]).toEqual(['proxy_vault_key']);
    expect(JSON.stringify([...disk.values()])).not.toContain('new-secret');
    expect(JSON.stringify([...disk.values()])).not.toContain('old-secret');
    await reloadProxyLib();
    await expect(proxyLib.listProxies()).resolves.toMatchObject([{ password: 'new-secret' }]);
  });

  it('removes a prior VPN private block when the proxy changes scheme', async () => {
    const added = await proxyLib.addProxy({
      ...base,
      password: null,
      scheme: 'wireguard',
      wireguard: {
        private_key: 'retired-private-key',
        peer_public_key: 'peer',
        endpoint: 'wg.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
      },
    });

    const updated = await proxyLib.updateProxy(added.id, {
      ...base,
      password: 'socks-password',
      scheme: 'socks5',
    });
    expect(updated?.wireguard).toBeUndefined();
    expect(JSON.stringify([...disk.values()])).not.toContain('retired-private-key');
    expect(JSON.stringify([...disk.values()])).not.toContain('socks-password');
    await reloadProxyLib();
    const reloaded = await proxyLib.listProxies();
    expect(reloaded).toMatchObject([{ password: 'socks-password' }]);
    expect(reloaded[0]?.wireguard).toBeUndefined();
  });

  it('deletes the per-proxy ciphertext after removing its metadata but retains the shared key', async () => {
    const added = await proxyLib.addProxy({ ...base, password: 'remove-me' });
    expect(
      (disk.get('proxy_secret_envelopes_v2') as Record<string, unknown>)[added.id],
    ).toBeDefined();
    await proxyLib.removeProxy(added.id);
    expect(keychain.has(`proxy_secret:${added.id}`)).toBe(false);
    expect(keychain.has('proxy_vault_key')).toBe(true);
    expect(
      (disk.get('proxy_secret_envelopes_v2') as Record<string, unknown>)[added.id],
    ).toBeUndefined();
    expect(disk.get('proxies')).toEqual([]);
  });

  it('rejects malformed protected payloads instead of launching with guessed credentials', async () => {
    disk.set('proxies', [
      {
        id: 'corrupt',
        ...base,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    keychain.set('proxy_secret:corrupt', '{not-json');
    await expect(proxyLib.listProxies()).rejects.toThrow('credentials are corrupted');
  });

  it('rejects sanitized metadata whose protected credential entry disappeared', async () => {
    disk.set('proxies', [
      {
        id: 'missing-secret',
        ...base,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await expect(proxyLib.listProxies()).rejects.toThrow('credentials are missing');
  });

  it('rejects credentials bound to a different endpoint instead of misrouting them', async () => {
    disk.set('proxies', [
      {
        id: 'swapped',
        ...base,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    keychain.set(
      'proxy_secret:swapped',
      JSON.stringify({
        version: 1,
        binding: {
          host: 'different.example.com',
          port: base.port,
          username: base.username,
          scheme: null,
        },
        password: 'must-not-be-forwarded',
      }),
    );
    await expect(proxyLib.listProxies()).rejects.toThrow('do not match proxy metadata');
    expect(keychain.has('proxy_secret:swapped')).toBe(true);
  });

  it('rejects a ciphertext envelope relocated to another proxy id', async () => {
    const first = await proxyLib.addProxy({ ...base, label: 'First', password: 'first-secret' });
    const second = await proxyLib.addProxy({ ...base, label: 'Second', password: 'second-secret' });
    const envelopes = disk.get('proxy_secret_envelopes_v2') as Record<string, unknown>;
    envelopes[second.id] = envelopes[first.id];
    disk.set('proxy_secret_envelopes_v2', envelopes);
    await reloadProxyLib();

    await expect(proxyLib.listProxies()).rejects.toThrow('credentials are corrupted');
  });
});
