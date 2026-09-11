// (q) Item 14 (B) — a VPN launch dispatches the ROW's stored exit when the
// exit-identity cache is cold.
//
// The pre-launch probe warms the exit-identity cache for a socks5 row and
// returns BEFORE dialling a VPN row (the control plane cannot bring a tunnel
// up), so for an openvpn/wireguard proxy the cache is never warm and the
// dispatch omitted `exit_identity` on EVERY VPN launch — the box then started
// on the archetype-zone fallback (host-looking time, no exit ip/country/tz)
// while a socks5 session got the block from its probe. The row holds the
// tunnel's last observed exit (`exitObserved`, written by the fleet-vantage
// Check and by a live session's capability report), and the mid-session swap
// already reads it (`storedVpnExitAsSwapIdentity`, N14). The dispatch now does
// the same on a cache miss, under the same refusals.
//
// Guard reasoning (agent-sessions.ts, dispatchSessionAssignOnCreate):
//   * revert the `storedVpnExit` read (`exitSource = cachedExit` only) → the
//     CRITICAL arm's `frame.exit_identity` is undefined → red;
//   * drop the `vpnWireType !== null` gate → the socks5 CONTROL sees findOwned
//     called and an exit_identity it must not carry → red;
//   * drop the `cachedExit === undefined` gate → the cache-wins CONTROL sees
//     findOwned called → red;
//   * the superseded / no-country / undated refusals live in the shared helper,
//     and the superseded CONTROL here reds if the dispatch stops honouring it;
//   * remove the try/catch around findOwned → the throw arm sends NO frame
//     (the outer best-effort catch drops the whole dispatch) → red.
//
// Shape: the dispatch is invoked directly (as agent-sessions-fleet-dispatch.test.ts
// does) because buildTestApp does not wire `sessionDispatch`; one registry and
// one registered node per arm.

import { describe, expect, it, vi } from 'vitest';
import {
  dispatchSessionAssignOnCreate,
  type SessionDispatchConfig,
} from '../../src/routes/agent-sessions.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import type { AccountProxiesService } from '../../src/services/account-proxies.js';
import type { AccountProxyRow } from '../../src/db/account-proxies-repo.js';
import { InMemoryExitIdentityCache } from '../../src/services/exit-identity-cache.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const NODE_ID = 'local-mac-vpn-exit-001';
const NODE_UUID = '22222222-2222-4222-8222-222222222222';

const DISPATCH: SessionDispatchConfig = {
  archetype: 'iphone16pro_ios18_6_safari18_6',
  behaviorProfile: 'default',
  initialUrl: 'https://example.com',
  proxy: { host: '127.0.0.1', port: 1080, udp_associate: true, require_remote_dns: false },
};

const OBSERVED_AT = new Date('2026-09-01T00:00:00Z');
const STORED_EXIT = {
  ip: '203.0.113.9',
  country: 'NL',
  timezone: 'Europe/Amsterdam',
  observed_via: 'probe' as const,
};

const OPENVPN_WIRE = {
  type: 'openvpn',
  config_blob: 'client\nremote vpn.example.com 1194\n',
};
const WIREGUARD_WIRE = {
  type: 'wireguard',
  private_key: 'k',
  peer_public_key: 'p',
  endpoint: '198.51.100.1:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.0.0.2/32',
};
const SOCKS_WIRE = {
  host: '203.0.113.7',
  port: 1080,
  udp_associate: true,
  require_remote_dns: true,
};

function macWithLivekit() {
  const apiKey = 'devkey';
  const wsUrl = 'ws://localhost:7880';
  return {
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
}

function nodesRepo(): DrizzleFleetNodesRepo {
  const mac = macWithLivekit();
  return {
    findAnyWithLivekit: () => Promise.resolve(mac),
    findNearestWithLivekit: () => Promise.resolve(mac),
  } as unknown as DrizzleFleetNodesRepo;
}

/** A row holding a stored exit; `supersededAt` dates a later contradiction. */
function rowWith(
  exit: AccountProxyRow['exitObserved'],
  supersededAt: Date | null = null,
  observedAt: Date | null = OBSERVED_AT,
): AccountProxyRow {
  return {
    exitObserved: exit,
    exitObservedAt: observedAt,
    exitSupersededAt: supersededAt,
  } as unknown as AccountProxyRow;
}

function proxySvc(
  resolved: unknown,
  findOwned: (id: string, accountId: string) => Promise<AccountProxyRow | null>,
): { svc: AccountProxiesService; findOwned: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(findOwned);
  return {
    svc: {
      resolveForDispatch: () => Promise.resolve(resolved),
      findOwned: spy,
    } as unknown as AccountProxiesService,
    findOwned: spy,
  };
}

async function dispatch(args: {
  resolved: unknown;
  row: AccountProxyRow | null | Error;
  cache?: InMemoryExitIdentityCache;
}): Promise<{
  frame: Record<string, unknown> | undefined;
  sent: number;
  findOwned: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}> {
  const sent: string[] = [];
  const registry = new FleetControlRegistry();
  registry.register(NODE_ID, (d) => sent.push(d));
  const { svc, findOwned } = proxySvc(args.resolved, () =>
    args.row instanceof Error ? Promise.reject(args.row) : Promise.resolve(args.row),
  );
  const warn = vi.fn();
  await dispatchSessionAssignOnCreate({
    ownerTier: 'api_builder',
    sessionId: 'agt_vpn_exit',
    fleetControlRegistry: registry,
    fleetNodesRepo: nodesRepo(),
    livekitSecretEncryptionKey: KEY,
    sessionDispatch: DISPATCH,
    accountId: 'acc_1',
    proxyId: 'prx_vpn',
    accountProxiesService: svc,
    exitIdentityCache: args.cache ?? new InMemoryExitIdentityCache(),
    logger: { info: vi.fn(), warn },
  });
  return {
    frame: sent[0] !== undefined ? (JSON.parse(sent[0]) as Record<string, unknown>) : undefined,
    sent: sent.length,
    findOwned,
    warn,
  };
}

describe('dispatchSessionAssignOnCreate — a VPN wire with a COLD exit cache reads the row’s stored exit', () => {
  it('CRITICAL openvpn + empty cache + stored exit → the assign carries exit_identity from the ROW, dated by the observation', async () => {
    const { frame, sent, findOwned } = await dispatch({
      resolved: OPENVPN_WIRE,
      row: rowWith(STORED_EXIT),
    });
    expect(sent).toBe(1);
    expect(findOwned).toHaveBeenCalledWith('prx_vpn', 'acc_1');
    const identity = frame!.exit_identity as Record<string, unknown>;
    expect(identity, JSON.stringify(frame)).toBeDefined();
    expect(identity.ip).toBe(STORED_EXIT.ip);
    expect(identity.country).toBe('NL');
    expect(identity.timezone).toBe(STORED_EXIT.timezone);
    // The row stores no region/city — the wire says so, never invents one.
    expect(identity.region).toBeNull();
    expect(identity.city).toBeNull();
    // A tunnel carries UDP by nature — the same rule the cache path applies.
    expect(identity.quic_ok).toBe(true);
    // The observation's OWN date, never the dispatch time.
    expect(identity.probed_at).toBe(OBSERVED_AT.toISOString());
  });

  it('CRITICAL wireguard takes the same path (both VPN schemes, not only openvpn)', async () => {
    const { frame, sent } = await dispatch({
      resolved: WIREGUARD_WIRE,
      row: rowWith(STORED_EXIT),
    });
    expect(sent).toBe(1);
    expect((frame!.exit_identity as Record<string, unknown>).timezone).toBe(STORED_EXIT.timezone);
  });

  it('CONTROL — a stored exit the last Check CONTRADICTED (exit_superseded_at set) is NOT dispatched: the session still starts, without the block', async () => {
    const { frame, sent } = await dispatch({
      resolved: OPENVPN_WIRE,
      row: rowWith(STORED_EXIT, new Date('2026-09-02T00:00:00Z')),
    });
    expect(sent).toBe(1);
    expect(frame!.exit_identity).toBeUndefined();
  });

  it('CONTROL — an exit with no country or no date cannot cross the wire: omitted, never sent malformed', async () => {
    const noCountry = await dispatch({
      resolved: OPENVPN_WIRE,
      row: rowWith({ ...STORED_EXIT, country: null }),
    });
    expect(noCountry.sent).toBe(1);
    expect(noCountry.frame!.exit_identity).toBeUndefined();
    const undated = await dispatch({
      resolved: OPENVPN_WIRE,
      row: rowWith(STORED_EXIT, null, null),
    });
    expect(undated.sent).toBe(1);
    expect(undated.frame!.exit_identity).toBeUndefined();
  });

  it('CONTROL — a socks5 wire keeps the CACHE as its only source: the row is not even read, and a stored exit does not stand in for an unprobed socks5 exit', async () => {
    const { frame, sent, findOwned } = await dispatch({
      resolved: SOCKS_WIRE,
      row: rowWith(STORED_EXIT),
    });
    expect(sent).toBe(1);
    expect(findOwned).not.toHaveBeenCalled();
    expect(frame!.exit_identity).toBeUndefined();
  });

  it('CONTROL — a WARM cache wins and the row is not read (the probe’s measurement outranks the stored one)', async () => {
    const cache = new InMemoryExitIdentityCache();
    await cache.set('acc_1', 'prx_vpn', {
      ip: '198.51.100.20',
      country: 'DE',
      region: 'Berlin',
      city: 'Berlin',
      timezone: 'Europe/Berlin',
    });
    const { frame, findOwned } = await dispatch({
      resolved: WIREGUARD_WIRE,
      row: rowWith(STORED_EXIT),
      cache,
    });
    expect(findOwned).not.toHaveBeenCalled();
    expect((frame!.exit_identity as Record<string, unknown>).ip).toBe('198.51.100.20');
  });

  it('a row that cannot be found dispatches without the block (a missing row is not a dropped launch)', async () => {
    const { frame, sent } = await dispatch({ resolved: OPENVPN_WIRE, row: null });
    expect(sent).toBe(1);
    expect(frame!.exit_identity).toBeUndefined();
  });

  it('a row-read FAILURE degrades to "no block" and is logged — the dispatch itself still reaches the node', async () => {
    const { frame, sent, warn } = await dispatch({
      resolved: OPENVPN_WIRE,
      row: new Error('db unavailable'),
    });
    expect(sent).toBe(1);
    expect(frame!.exit_identity).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'agent-session-dispatch', proxyId: 'prx_vpn' }),
      expect.stringMatching(/stored VPN exit read failed/),
    );
  });
});
