// Security regression: proxy passwords and VPN private configuration belong in
// the OS credential store, never the settings.json proxy registry.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { addProxy, listProxies, removeProxy, updateProxy } = await import('../../src/lib/proxies');

const base = {
  label: 'Amsterdam',
  host: 'proxy.example.com',
  port: 1080,
  username: 'alice',
};

describe('proxy protected credential storage', () => {
  beforeEach(() => {
    disk.clear();
    keychain.clear();
    failSecretAccess = false;
    invoke.mockClear();
  });

  it('adds SOCKS credentials to Keychain while persisting metadata only', async () => {
    const added = await addProxy({ ...base, password: 'socks-secret', scheme: 'socks5' });

    expect(added.password).toBe('socks-secret');
    const persisted = disk.get('proxies') as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).not.toHaveProperty('password');
    expect(persisted[0]).not.toHaveProperty('openvpn');
    expect(persisted[0]).not.toHaveProperty('wireguard');
    expect(JSON.stringify(persisted)).not.toContain('socks-secret');

    const protectedValue = keychain.get(`proxy_secret:${added.id}`);
    expect(protectedValue).toBeDefined();
    expect(JSON.parse(protectedValue ?? '{}')).toEqual({
      version: 1,
      binding: {
        host: base.host,
        port: base.port,
        username: base.username,
        scheme: 'socks5',
      },
      password: 'socks-secret',
    });
    await expect(listProxies()).resolves.toEqual([added]);
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

    const ovpn = await addProxy({
      ...base,
      label: 'OVPN',
      password: null,
      scheme: 'openvpn',
      openvpn,
    });
    const wg = await addProxy({
      ...base,
      label: 'WG',
      password: null,
      scheme: 'wireguard',
      wireguard,
    });

    const serializedDisk = JSON.stringify(disk.get('proxies'));
    expect(serializedDisk).not.toContain('PRIVATE');
    expect(serializedDisk).not.toContain('vpn-password');
    expect(serializedDisk).not.toContain('wg-private-key');
    expect((await listProxies()).find((proxy) => proxy.id === ovpn.id)?.openvpn).toEqual(openvpn);
    expect((await listProxies()).find((proxy) => proxy.id === wg.id)?.wireguard).toEqual(wireguard);
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

    const loaded = await listProxies();
    expect(loaded[0]?.password).toBe('legacy-socks-secret');
    expect(loaded[1]?.wireguard?.private_key).toBe('legacy-wg-private');
    expect(keychain.get('proxy_secret:legacy-socks')).toContain('legacy-socks-secret');
    expect(keychain.get('proxy_secret:legacy-wg')).toContain('legacy-wg-private');
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

    const loaded = await listProxies();
    expect(loaded[0]?.password).toBe('current-protected-secret');
    expect(keychain.get('proxy_secret:already-protected')).toContain('current-protected-secret');
    expect(JSON.stringify(disk.get('proxies'))).not.toContain('stale-disk-secret');
  });

  it('purges a malformed non-array registry that may contain legacy credentials', async () => {
    disk.set('proxies', { password: 'orphaned-plaintext', private_key: 'orphaned-private' });
    await expect(listProxies()).resolves.toEqual([]);
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

    const loaded = await listProxies();
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

    const loaded = await listProxies();
    expect(loaded[0]?.password).toBe('only-in-memory-this-launch');
    expect(keychain.size).toBe(0);
    expect(JSON.stringify(disk.get('proxies'))).not.toContain('only-in-memory-this-launch');
    await expect(listProxies()).resolves.toEqual(loaded);
  });

  it('fails closed instead of adding a plaintext fallback when Keychain is locked', async () => {
    failSecretAccess = true;
    await expect(addProxy({ ...base, password: 'must-not-fallback' })).rejects.toThrow(
      'credential store locked',
    );
    expect(disk.get('proxies')).toBeUndefined();
    expect(JSON.stringify([...disk.values()])).not.toContain('must-not-fallback');
  });

  it('updates the protected payload without writing the replacement to disk', async () => {
    const added = await addProxy({ ...base, password: 'old-secret' });
    const updated = await updateProxy(added.id, { ...base, password: 'new-secret' });

    expect(updated?.password).toBe('new-secret');
    expect(keychain.get(`proxy_secret:${added.id}`)).toContain('new-secret');
    expect(JSON.stringify(disk.get('proxies'))).not.toContain('new-secret');
    expect(JSON.stringify(disk.get('proxies'))).not.toContain('old-secret');
  });

  it('removes a prior VPN private block when the proxy changes scheme', async () => {
    const added = await addProxy({
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

    const updated = await updateProxy(added.id, {
      ...base,
      password: 'socks-password',
      scheme: 'socks5',
    });
    expect(updated?.wireguard).toBeUndefined();
    expect(keychain.get(`proxy_secret:${added.id}`)).not.toContain('retired-private-key');
    expect(keychain.get(`proxy_secret:${added.id}`)).toContain('socks-password');
  });

  it('deletes the per-proxy protected entry after removing its metadata', async () => {
    const added = await addProxy({ ...base, password: 'remove-me' });
    expect(keychain.has(`proxy_secret:${added.id}`)).toBe(true);
    await removeProxy(added.id);
    expect(keychain.has(`proxy_secret:${added.id}`)).toBe(false);
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
    await expect(listProxies()).rejects.toThrow('credentials are corrupted');
  });

  it('rejects sanitized metadata whose protected credential entry disappeared', async () => {
    disk.set('proxies', [
      {
        id: 'missing-secret',
        ...base,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await expect(listProxies()).rejects.toThrow('credentials are missing');
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
    await expect(listProxies()).rejects.toThrow('do not match proxy metadata');
  });
});
