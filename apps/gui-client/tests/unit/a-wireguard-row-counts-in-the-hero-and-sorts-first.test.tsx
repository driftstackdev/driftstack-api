// (n) N19 — the Proxies hero tallies and the status sort were blind to every VPN row.
//
// ⛔ MEASURED: `tested`, `healthy` and `statusRank` all read `testResults`, and
// `deriveProbeViewWithEndpointRows` DELETES the entry of every endpoint row from that
// map by design — a VPN row's cached `result` is a fail-closed placeholder, not a SOCKS5
// verdict. So `testResults[id]` is permanently undefined for a WireGuard row whatever
// the fleet said, and three things followed:
//   • a row reading "tunnel down" contributed nothing to "N needs attention";
//   • the default status sort left it exactly where it was — and "the broken proxy is
//     the first row" is the entire argument for preferring this grid to the card deck
//     it replaced (see the-broken-proxy-is-the-first-row);
//   • a WireGuard-only pool never reached the "N healthy · N WebRTC + QUIC" summary, no
//     matter how many tunnels came up: the hero stayed on the generic sentence.
//
// The tallies read the SAME state the row renders now (the fleet failure, the endpoint
// pre-flight, the fleet vantage), seeded here through the probe cache exactly as a real
// check would leave it.

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const NOW = Date.now();

/** The fail-closed placeholder a VPN row's cache entry carries instead of a SOCKS5
 *  verdict — never usable, which is why every tally used to skip the row. */
const PLACEHOLDER: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'endpoint check only',
};

const HEALTHY: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 30,
  message: 'ok',
};

const TUNNEL_DOWN = 'The Mac that runs your profiles could not bring this tunnel up.';

function wgRow(): ProxyConfig {
  return {
    id: 'wg1',
    label: 'proxy-wireguard',
    host: 'wg.example.com',
    port: 51820,
    username: null,
    password: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme: 'wireguard',
    serverId: 'aprx_wg',
    wireguard: {
      private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
      endpoint: 'wg.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.7.0.2/32',
    },
  };
}

function socksRow(): ProxyConfig {
  return {
    id: 's1',
    label: 'proxy-socks',
    host: 'socks.example.com',
    port: 1080,
    username: 'user',
    password: 'pass',
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme: 'socks5',
  };
}

const RESOLVED = { resolved: true, ip: '198.51.100.1', message: 'Resolved' };

/** The cache a fleet FAILURE leaves on a VPN row. */
const WG_DOWN: ProbeCacheModule.CachedProbe = {
  result: PLACEHOLDER,
  at: NOW,
  endpoint: RESOLVED,
  fleetFailureReason: TUNNEL_DOWN,
  exitSupersededAt: NOW,
};
/** The cache a fleet VERDICT leaves on a VPN row whose tunnel came up. */
const WG_UP: ProbeCacheModule.CachedProbe = {
  result: PLACEHOLDER,
  at: NOW,
  endpoint: RESOLVED,
  measuredFrom: 'fleet',
  nodeId: 'mac-mini-07',
  serverLatencyMs: 42,
  serverProbeAt: NOW,
};
/** Endpoint resolved, fleet never answered — a VPN row with no verdict at all. */
const WG_UNTESTED: ProbeCacheModule.CachedProbe = {
  result: PLACEHOLDER,
  at: NOW,
  endpoint: RESOLVED,
};
/** The DNS pre-flight itself failed — the row's other red. */
const WG_UNRESOLVED: ProbeCacheModule.CachedProbe = {
  result: PLACEHOLDER,
  at: NOW,
  endpoint: { resolved: false, ip: '', message: 'NXDOMAIN' },
};
/** A healthy SOCKS5 row, so the SOCKS5 half of every tally stays measured too. */
const SOCKS_OK: ProbeCacheModule.CachedProbe = { result: HEALTHY, at: NOW };

let stored: ProxyConfig[] = [];
let cache: ProbeCacheModule.ProbeCacheMap = {};

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => Promise.resolve(HEALTHY)),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() => Promise.resolve(RESOLVED)),
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  // Spread the REAL module: the derivations that decide what a VPN row's verdict IS
  // (deriveProbeViewWithEndpointRows deleting the placeholder from testResults, the
  // freshness window) are the subject here and must not be stubbed.
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve(cache),
  saveExitResult: vi.fn(() => Promise.resolve({})),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ settings: { apiKey: null, baseUrl: 'http://x' } }),
}));

const { ProxiesView } = await import('../../src/views/ProxiesView');

/** Row labels top-to-bottom — the subject of the sort arms. */
function rowOrder(): string[] {
  const body = document.querySelector('[data-component="proxy-table"] tbody');
  return [...(body?.querySelectorAll('tr') ?? [])].map(
    (tr) => tr.querySelector('td:nth-child(2) > div')?.textContent?.trim() ?? '',
  );
}

function heroText(): string {
  return document.querySelector('[data-component="proxies-hero"]')?.textContent ?? '';
}

function tableHeaderText(): string {
  return document.querySelector('[data-component="proxy-table"]')?.textContent ?? '';
}

beforeEach(() => {
  stored = [];
  cache = {};
});

describe('(n) N19 — a WireGuard verdict reaches the hero and the sort', () => {
  it('CRITICAL a tunnel-down WireGuard row is counted in "needs attention" and sorts to the TOP, above a healthy SOCKS5 row', async () => {
    stored = [socksRow(), wgRow()];
    cache = { s1: SOCKS_OK, wg1: WG_DOWN };
    render(<ProxiesView />);

    await waitFor(() => expect(tableHeaderText()).toContain('1 needs attention'));
    expect(rowOrder()[0]).toContain('proxy-wireguard');
    expect(rowOrder()[1]).toContain('proxy-socks');
    // The row itself already said so — the tally simply had not been reading it.
    expect(screen.getByText(TUNNEL_DOWN)).toBeInTheDocument();
  });

  it('CRITICAL CONTROL — the same row with a FLEET verdict and no failure counts as healthy and sorts BELOW nothing: it is not an attention row', async () => {
    stored = [socksRow(), wgRow()];
    cache = { s1: SOCKS_OK, wg1: WG_UP };
    render(<ProxiesView />);

    await waitFor(() => expect(heroText()).toContain('2'));
    expect(heroText()).toMatch(/2\s*healthy/);
    expect(tableHeaderText()).not.toContain('needs attention');
    // Original order preserved: equal rank ties break on position, never on label.
    expect(rowOrder()[0]).toContain('proxy-socks');
  });

  it('CRITICAL a WireGuard-only pool reaches the healthy summary instead of the generic "Protected locally…" sentence', async () => {
    stored = [wgRow()];
    cache = { wg1: WG_UP };
    render(<ProxiesView />);

    await waitFor(() => expect(heroText()).toMatch(/1\s*healthy/));
    expect(heroText()).not.toContain('Protected locally on this device');
    // The pool stats appear for the same reason — the row is TESTED now.
    expect(document.querySelector('[data-component="proxy-pool-stats"]')).not.toBeNull();
  });

  it('CRITICAL VACUITY CONTROL — a VPN row with no verdict is neither healthy nor attention. A tally that counted every VPN row would satisfy the arms above and fail this.', async () => {
    stored = [wgRow()];
    cache = { wg1: WG_UNTESTED };
    render(<ProxiesView />);

    await screen.findByText('proxy-wireguard');
    await new Promise((r) => setTimeout(r, 20));
    expect(heroText()).toContain('Protected locally on this device');
    expect(heroText()).not.toMatch(/\d+\s*healthy/);
    expect(tableHeaderText()).not.toContain('needs attention');
    expect(document.querySelector('[data-component="proxy-pool-stats"]')).toBeNull();
  });

  it('an endpoint that does not resolve is the row’s other red, and it counts too', async () => {
    stored = [wgRow()];
    cache = { wg1: WG_UNRESOLVED };
    render(<ProxiesView />);

    await waitFor(() => expect(tableHeaderText()).toContain('1 needs attention'));
  });

  it('CONTROL — a control-plane fallback measured no tunnel, so it is not "healthy": the row stays untested, exactly as its own pill reads', async () => {
    stored = [wgRow()];
    cache = { wg1: { ...WG_UP, measuredFrom: 'control_plane', nodeId: undefined } };
    render(<ProxiesView />);

    await screen.findByText('proxy-wireguard');
    await new Promise((r) => setTimeout(r, 20));
    expect(heroText()).not.toMatch(/\d+\s*healthy/);
    expect(tableHeaderText()).not.toContain('needs attention');
  });

  it('CONTROL — the SOCKS5 half of every tally is unchanged: a broken SOCKS5 row still counts and still sorts first', async () => {
    stored = [socksRow(), { ...socksRow(), id: 's2', label: 'proxy-broken' }];
    cache = {
      s1: SOCKS_OK,
      s2: { result: { ...HEALTHY, reachable: false, can_route: false }, at: NOW },
    };
    render(<ProxiesView />);

    await waitFor(() => expect(tableHeaderText()).toContain('1 needs attention'));
    expect(rowOrder()[0]).toContain('proxy-broken');
  });
});
