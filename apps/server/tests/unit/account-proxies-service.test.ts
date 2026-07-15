// ARC A slice 4 — AccountProxiesService.resolveForDispatch security tests.
//
// resolveForDispatch is the sensitive path: it decrypts a stored proxy password
// (owner-scoped TMK) and re-asserts the SSRF host-guard before the proxy is
// injected into a session dispatch. Covered here: owner-scoping (B can't resolve
// A's proxy), password unwrap, SSRF fail-closed, http-scheme skip, no-key
// behaviour.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SocksProxyConfig } from '@driftstack/api-types';
import { InMemoryAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';
import { AccountProxiesService, UnsafeProxyHostError } from '../../src/services/account-proxies.js';
import { encryptAccountProxySecret } from '../../src/lib/account-proxy-secret-encryption.js';

const MASTER = Buffer.alloc(32, 7);
const ACCT_A = '11111111-1111-1111-1111-111111111111';
const ACCT_B = '22222222-2222-2222-2222-222222222222';

async function seed(
  repo: InMemoryAccountProxiesRepo,
  accountId: string,
  over: Partial<Parameters<InMemoryAccountProxiesRepo['create']>[1]> = {},
) {
  const id = over.id ?? randomUUID();
  return repo.create(accountId, {
    label: 'p',
    scheme: 'socks5',
    host: 'proxy.customer.example',
    port: 1080,
    username: 'user',
    wrappedPassword: encryptAccountProxySecret(
      MASTER,
      { accountId, proxyId: id, slot: 'password' },
      'hunter2',
    ),
    ...over,
    id,
  });
}

describe('AccountProxiesService.resolveForDispatch', () => {
  it('resolves a socks5 proxy and unwraps the password under the owner TMK', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg).not.toBeNull();
    expect(cfg?.host).toBe('proxy.customer.example');
    expect(cfg?.port).toBe(1080);
    expect(cfg?.username).toBe('user');
    expect(cfg?.password).toBe('hunter2');
    expect(cfg?.require_remote_dns).toBe(true);
  });

  // Proxy UDP pre-detection (A3 W2756): resolveForDispatch emits a VERIFIED,
  // FRESH (within the 7-day TTL) udp_capable on the wire so the harness can skip
  // the per-session ~3s probe; stale/absent → omitted → fork async-probe (today).
  const recentIso = (): string => new Date(Date.now() - 60_000).toISOString();
  const staleIso = (): string => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  it('udp_capable: a FRESH verified TRUE is emitted on the wire', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, {
      config: { udp_capable: true, udp_verified_at: recentIso() },
    });
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg?.udp_capable).toBe(true);
  });

  it('udp_capable: a FRESH verified FALSE (TCP-only) is emitted so the fork skips the probe + disables h3', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, {
      config: { udp_capable: false, udp_verified_at: recentIso() },
    });
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg?.udp_capable).toBe(false);
  });

  it('udp_capable: a STALE verified value (older than the 7-day TTL) is OMITTED → fork re-probes', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, {
      config: { udp_capable: true, udp_verified_at: staleIso() },
    });
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg).not.toBeNull();
    expect(cfg?.udp_capable).toBeUndefined();
  });

  it('udp_capable: ABSENT (no verified value — the default) is OMITTED → fork async-probe = today’s safe behavior', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg).not.toBeNull();
    expect(cfg?.udp_capable).toBeUndefined();
  });

  it('OWNER SCOPING: account B cannot resolve account A’s proxy (null, never decrypts)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    expect(await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_B })).toBeNull();
  });

  it('unknown id → null', async () => {
    const svc = new AccountProxiesService(new InMemoryAccountProxiesRepo(), MASTER);
    expect(await svc.resolveForDispatch({ proxyId: 'nope', accountId: ACCT_A })).toBeNull();
  });

  it('SSRF FAIL-CLOSED: a stored private/loopback host throws UnsafeProxyHostError', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', 'localhost', '::1']) {
      const row = await seed(repo, ACCT_A, { host });
      await expect(svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A })).rejects.toThrow(
        UnsafeProxyHostError,
      );
    }
  });

  it('http-scheme proxy is not dispatch-injectable yet → null', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, { scheme: 'http' });
    expect(await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A })).toBeNull();
  });

  it('no master key with a stored password fails closed', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, null);
    const row = await seed(repo, ACCT_A);
    const cfg = await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
    });
    expect(cfg).toBeNull();
  });

  it('a proxy with no stored password resolves without one', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, { wrappedPassword: null, username: null });
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg?.password).toBeUndefined();
    expect(cfg?.username).toBeUndefined();
  });

  // OVPN/WG slice 4 — VPN rows resolve to the FLAT inline wire (A3 W2163), with
  // the secret unwrapped under the owner TMK + cross-account isolation preserved.
  it('resolves a WireGuard proxy to the FLAT wire (type sibling fields, secret unwrapped)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const id = randomUUID();
    const row = await repo.create(ACCT_A, {
      id,
      label: 'wg',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      username: null,
      wrappedPassword: null,
      wrappedSecret: encryptAccountProxySecret(
        MASTER,
        { accountId: ACCT_A, proxyId: id, slot: 'wireguard-private-key' },
        'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      ),
      config: {
        peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
        endpoint: 'vpn.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
      },
    });
    const cfg = await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A });
    expect(cfg).toEqual({
      type: 'wireguard',
      private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
      endpoint: 'vpn.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.7.0.2/32',
    });
  });

  it('resolves an OpenVPN proxy to the FLAT wire (config_blob from the unwrapped secret)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const id = randomUUID();
    const row = await repo.create(ACCT_A, {
      id,
      label: 'ovpn',
      scheme: 'openvpn',
      host: 'vpn.example.com',
      port: 1194,
      username: null,
      wrappedPassword: null,
      wrappedSecret: encryptAccountProxySecret(
        MASTER,
        { accountId: ACCT_A, proxyId: id, slot: 'openvpn-config' },
        JSON.stringify({ config_blob: 'client\nremote vpn.example.com 1194\n' }),
      ),
      config: { username: 'u' },
    });
    const cfg = await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A });
    expect(cfg).toEqual({
      type: 'openvpn',
      config_blob: 'client\nremote vpn.example.com 1194\n',
      username: 'u',
    });
  });

  it('OWNER SCOPING (VPN): account B cannot resolve account A’s WireGuard secret → null (GCM unwrap fails)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const id = randomUUID();
    const row = await repo.create(ACCT_A, {
      id,
      label: 'wg',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      username: null,
      wrappedPassword: null,
      wrappedSecret: encryptAccountProxySecret(
        MASTER,
        { accountId: ACCT_A, proxyId: id, slot: 'wireguard-private-key' },
        'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      ),
      config: {
        peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
        endpoint: 'vpn.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
      },
    });
    expect(await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_B })).toBeNull();
  });
});

describe('AccountProxiesService.findOwned', () => {
  it('returns the row for the owner, null cross-account', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    expect((await svc.findOwned(row.id, ACCT_A))?.id).toBe(row.id);
    expect(await svc.findOwned(row.id, ACCT_B)).toBeNull();
  });
});
