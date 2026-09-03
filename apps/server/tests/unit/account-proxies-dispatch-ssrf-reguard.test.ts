// A stored VPN row cannot smuggle an unsafe egress target past DISPATCH.
//
// `resolveForDispatch` is, in its own words, "the single choke point that turns a
// stored row into a dispatchable egress config", and it re-checks two things the
// create route also checks. The display host is one of them and is covered. These
// are the other:
//
//   openvpn:   classifyUnsafeVpnTargets({ configBlob: parsed.config_blob })
//   wireguard: classifyUnsafeVpnTargets({ endpoint: str('endpoint'), dns: str('dns') })
//   → return null
//
// Both guards RUN today and neither has ever REJECTED: coverage puts the `if` at 1
// execution and the `return null` beneath it at ZERO, for both schemes. No test has
// ever presented a stored row with an unsafe embedded target, so the refusal path is
// unproven while looking exercised.
//
// What the refusal protects is not hypothetical. The route-level guard is already
// covered by `account-me-proxies` — but a route guard only governs rows created
// THROUGH that route, after it shipped. This one governs the rows themselves:
// registered before the gate existed, written by any other path, or reachable if the
// route guard ever regresses. The source says exactly that: "so a row inserted by any
// other path can't smuggle a private/loopback/metadata host into egress", and, of the
// route-only alternative, "a check on one call site, which is the shape of the bug
// being fixed".
//
// Delete either guard and nothing throws — `candidate` is built and the config is
// handed back for dispatch, so a session egresses to the target. With
// `169.254.169.254` that is the cloud metadata endpoint, reached from inside the
// fleet, which is the reason `classifyUnsafeVpnTargets` exists at all.
//
// ⭐ EVERY row below keeps a SAFE display host (`vpn.example.com`) — the same
// discipline the route-level arms adopted. A refusal here therefore cannot be the
// display-host check doing the work: that check has nothing to complain about, and
// only the embedded target is unsafe. Positive arms with entirely safe rows sit
// alongside, so "refuse every VPN row" cannot satisfy this file.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountProxiesService } from '../../src/services/account-proxies.js';
import type { AccountProxiesRepo, AccountProxyRow } from '../../src/db/account-proxies-repo.js';
import { encryptAccountProxySecret } from '../../src/lib/account-proxy-secret-encryption.js';

const MASTER_KEY = Buffer.alloc(32, 9);
const ACCOUNT_ID = '11111111-2222-3333-4444-555555555555';
const SAFE_DISPLAY_HOST = 'vpn.example.com';
const WG_PRIVATE_KEY = 'A'.repeat(43) + '=';

function row(over: Partial<AccountProxyRow> & { scheme: string }): AccountProxyRow {
  const { id: overrideId, ...rest } = over;
  const id = overrideId ?? randomUUID();
  return {
    id,
    accountId: ACCOUNT_ID,
    label: 'a vpn',
    host: SAFE_DISPLAY_HOST,
    port: 1194,
    username: null,
    wrappedPassword: null,
    wrappedSecret: null,
    config: {},
    quicMeasured: null,
    quicMeasuredAt: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...rest,
  };
}

function wrap(proxyId: string, scheme: 'openvpn' | 'wireguard', plaintext: string): string {
  return encryptAccountProxySecret(
    MASTER_KEY,
    {
      accountId: ACCOUNT_ID,
      proxyId,
      slot: scheme === 'openvpn' ? 'openvpn-config' : 'wireguard-private-key',
    },
    plaintext,
  );
}

function serviceFor(stored: AccountProxyRow): AccountProxiesService {
  const repo = {
    findById: () => Promise.resolve(stored),
  } as unknown as AccountProxiesRepo;
  return new AccountProxiesService(repo, MASTER_KEY);
}

/** api_builder carries vpnEgress; a tier without it is refused earlier, by a
 *  different guard, and would mask what this file is measuring. */
const TIER = 'api_builder';

function wireguardRow(config: Record<string, unknown>): AccountProxyRow {
  const id = randomUUID();
  return row({
    id,
    scheme: 'wireguard',
    // Every field the flat wire schema requires, so a null result can only come
    // from the SSRF re-guard. Without these the row fails schema validation and the
    // negative arms would pass with the guard DELETED — a test proving nothing.
    config: {
      peer_public_key: 'B'.repeat(43) + '=',
      allowed_ips: '0.0.0.0/0',
      address: '10.7.0.2/32',
      ...config,
    },
    wrappedSecret: wrap(id, 'wireguard', WG_PRIVATE_KEY),
  });
}

function openvpnRow(remote: string): AccountProxyRow {
  const id = randomUUID();
  const blob = ['client', 'dev tun', 'proto udp', `remote ${remote} 1194`].join('\n');
  return row({
    id,
    scheme: 'openvpn',
    config: {},
    wrappedSecret: wrap(id, 'openvpn', JSON.stringify({ config_blob: blob })),
  });
}

describe('dispatch re-guards the embedded VPN egress target', () => {
  it('CRITICAL a stored WireGuard row whose endpoint is the cloud metadata address resolves to null, even though its display host is safe. Without the re-guard the config is handed to dispatch and the session egresses to 169.254.169.254 from inside the fleet — and the create-route guard cannot help, because it only governs rows created through that route after it shipped.', async () => {
    const svc = serviceFor(wireguardRow({ endpoint: '169.254.169.254:51820' }));

    await expect(
      svc.resolveForDispatch({ proxyId: randomUUID(), accountId: ACCOUNT_ID, tier: TIER }),
    ).resolves.toBeNull();
  });

  it('CRITICAL a stored WireGuard row whose DNS is a private address resolves to null. The endpoint alone is not the whole egress surface: DNS is resolved through the tunnel, so a guard that checked only the endpoint would leave it reachable.', async () => {
    const svc = serviceFor(wireguardRow({ endpoint: 'vpn.example.com:51820', dns: '10.0.0.53' }));

    await expect(
      svc.resolveForDispatch({ proxyId: randomUUID(), accountId: ACCOUNT_ID, tier: TIER }),
    ).resolves.toBeNull();
  });

  it('CRITICAL a stored OpenVPN row whose embedded `remote` is loopback resolves to null. The display host is decorative for a VPN profile — the connection goes to the `remote` inside the encrypted config blob, which nothing outside this guard inspects at dispatch.', async () => {
    const svc = serviceFor(openvpnRow('127.0.0.1'));

    await expect(
      svc.resolveForDispatch({ proxyId: randomUUID(), accountId: ACCOUNT_ID, tier: TIER }),
    ).resolves.toBeNull();
  });

  it('still resolves a WireGuard row whose endpoint and DNS are both public', async () => {
    const svc = serviceFor(wireguardRow({ endpoint: 'vpn.example.com:51820', dns: '1.1.1.1' }));

    const resolved = await svc.resolveForDispatch({
      proxyId: randomUUID(),
      accountId: ACCOUNT_ID,
      tier: TIER,
    });

    expect(resolved, 'a safe row must still dispatch').not.toBeNull();
  });

  it('still resolves an OpenVPN row whose embedded remote is public', async () => {
    const svc = serviceFor(openvpnRow('vpn.example.com'));

    const resolved = await svc.resolveForDispatch({
      proxyId: randomUUID(),
      accountId: ACCOUNT_ID,
      tier: TIER,
    });

    expect(resolved, 'a safe row must still dispatch').not.toBeNull();
  });
});
