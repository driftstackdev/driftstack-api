// An exit identity reports QUIC only when it was measured (owner item 9).
//
// The `exit_identity` block a session is dispatched with carries `quic_ok`, and the
// box shows it as "QUIC ✓ / ✗". It was copied from the proxy's configured
// `udp_capable` flag (and set true for any VPN), so it could show QUIC ✓ that
// nobody had checked. The flag is configuration, not a measurement, and this field
// may only carry a measurement.
//
// `quic_ok` is a required boolean on the wire the box decodes, so "not measured"
// cannot be sent as null without a matching change on the device. It is therefore
// TRUE only when a measurement of this proxy confirmed QUIC — the proxy Test's
// relay check found it (`quic_probe`), or a live session through it negotiated
// HTTP/3 (`quic_measured = 'h3'`) — and FALSE otherwise, including never measured.
// False means "not confirmed", never "confirmed absent".

import { describe, expect, it, vi } from 'vitest';
import {
  dispatchSessionAssignOnCreate,
  measuredQuicOk,
  type SessionDispatchConfig,
} from '../../src/routes/agent-sessions.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import type { AccountProxiesService } from '../../src/services/account-proxies.js';
import type { AccountProxyRow } from '../../src/db/account-proxies-repo.js';
import { InMemoryExitIdentityCache } from '../../src/services/exit-identity-cache.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const NODE_ID = 'local-mac-dev-001';
const NODE_UUID = '11111111-1111-4111-8111-111111111111';
const DISPATCH: SessionDispatchConfig = {
  archetype: 'iphone16pro_ios18_6_safari18_6',
  behaviorProfile: 'regular',
  initialUrl: 'https://example.com',
  proxy: { host: '127.0.0.1', port: 1080, udp_associate: true, require_remote_dns: false },
};
const EXIT = {
  ip: '203.0.113.7',
  country: 'US',
  region: 'California',
  city: 'San Jose',
  timezone: 'America/Los_Angeles',
};

const SOCKS5_CONFIGURED_UDP = {
  host: '203.0.113.7',
  port: 1080,
  udp_associate: true,
  require_remote_dns: true,
  udp_capable: true, // configuration — not a measurement
};
const WIREGUARD = {
  type: 'wireguard',
  private_key: 'k',
  peer_public_key: 'p',
  endpoint: '198.51.100.1:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.0.0.2/32',
};

function fleetRepo(): DrizzleFleetNodesRepo {
  const apiKey = 'devkey';
  const wsUrl = 'ws://localhost:7880';
  const mac = {
    id: NODE_UUID,
    nodeId: NODE_ID,
    publicKeyBase64Url: 'pk',
    registeredAt: new Date(),
    revokedAt: null,
    livekit: {
      apiKey,
      apiSecretCiphertextBase64: encryptLivekitSecret('secret', KEY, {
        nodeId: NODE_UUID,
        apiKey,
        wsUrl,
      }),
      wsUrl,
      registeredAt: new Date(),
    },
  };
  return {
    findAnyWithLivekit: () => Promise.resolve(mac),
    findNearestWithLivekit: () => Promise.resolve(mac),
  } as unknown as DrizzleFleetNodesRepo;
}

/** The measured QUIC readings on the proxy row; everything else is irrelevant here. */
function row(over: Partial<AccountProxyRow>): AccountProxyRow {
  return {
    id: 'prx_1',
    accountId: 'acc_1',
    quicProbe: null,
    quicProbeAt: null,
    quicMeasured: null,
    quicMeasuredAt: null,
    exitObserved: null,
    ...over,
  } as unknown as AccountProxyRow;
}

async function quicOkFor(
  resolved: unknown,
  stored: AccountProxyRow | null | 'throws',
): Promise<unknown> {
  const sent: string[] = [];
  const registry = new FleetControlRegistry();
  registry.register(NODE_ID, (d) => sent.push(d));
  const cache = new InMemoryExitIdentityCache();
  await cache.set('acc_1', 'prx_1', EXIT);
  const service = {
    resolveForDispatch: () => Promise.resolve(resolved),
    findOwned: () =>
      stored === 'throws' ? Promise.reject(new Error('db down')) : Promise.resolve(stored),
  } as unknown as AccountProxiesService;
  await dispatchSessionAssignOnCreate({
    ownerTier: 'api_builder',
    sessionId: 'agt_quic',
    fleetControlRegistry: registry,
    fleetNodesRepo: fleetRepo(),
    livekitSecretEncryptionKey: KEY,
    sessionDispatch: DISPATCH,
    accountId: 'acc_1',
    proxyId: 'prx_1',
    accountProxiesService: service,
    exitIdentityCache: cache,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  expect(sent, 'the session was not dispatched').toHaveLength(1);
  const frame = JSON.parse(sent[0]!) as { exit_identity?: Record<string, unknown> };
  expect(frame.exit_identity, 'the exit identity block was not sent').toBeDefined();
  return frame.exit_identity?.quic_ok;
}

describe('an exit identity reports QUIC only when it was measured', () => {
  it('CRITICAL a socks5 proxy CONFIGURED as UDP-capable, never measured, is not reported as QUIC ✓', async () => {
    expect(await quicOkFor(SOCKS5_CONFIGURED_UDP, row({}))).toBe(false);
  });

  it('CRITICAL a VPN never measured is not reported as QUIC ✓ either — "a tunnel carries UDP" is an expectation, not a check', async () => {
    expect(await quicOkFor(WIREGUARD, row({}))).toBe(false);
  });

  it('CRITICAL a proxy whose Test measured QUIC is reported as QUIC ✓, whatever its configuration says', async () => {
    const measured = row({ quicProbe: true, quicProbeAt: new Date('2026-09-24T10:00:00Z') });
    expect(await quicOkFor({ ...SOCKS5_CONFIGURED_UDP, udp_capable: false }, measured)).toBe(true);
  });

  it('a proxy a live session negotiated HTTP/3 through is reported as QUIC ✓ — the VPN case included', async () => {
    const measured = row({ quicMeasured: 'h3', quicMeasuredAt: new Date('2026-09-24T10:00:00Z') });
    expect(await quicOkFor(WIREGUARD, measured)).toBe(true);
  });

  it('a Test that measured QUIC NOT working, and a session that stayed on h2, both read false', async () => {
    expect(await quicOkFor(SOCKS5_CONFIGURED_UDP, row({ quicProbe: false }))).toBe(false);
    expect(await quicOkFor(WIREGUARD, row({ quicMeasured: 'h2-only' }))).toBe(false);
  });

  it('a failed row read still dispatches the session, and reports QUIC as not confirmed', async () => {
    expect(await quicOkFor(SOCKS5_CONFIGURED_UDP, 'throws')).toBe(false);
  });

  it('the rule itself: true only for a stored measurement that confirmed QUIC', () => {
    expect(measuredQuicOk(null)).toBe(false);
    expect(measuredQuicOk(undefined)).toBe(false);
    expect(measuredQuicOk(row({}))).toBe(false);
    expect(measuredQuicOk(row({ quicProbe: true }))).toBe(true);
    expect(measuredQuicOk(row({ quicMeasured: 'h3' }))).toBe(true);
    expect(measuredQuicOk(row({ quicProbe: false, quicMeasured: 'h2-only' }))).toBe(false);
  });
});
