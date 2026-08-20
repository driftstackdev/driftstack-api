// Regression coverage for two ProxiesView proxy-management bugs:
//
//  1. "Test all" ran the native SOCKS5 probe against EVERY saved proxy —
//     including VPN/HTTP endpoints that have no honest SOCKS5 handshake. That
//     probe always returns reachable:false, so a healthy WireGuard/OpenVPN proxy
//     got flagged "unreachable" in the pool stats AND that false-negative was
//     persisted to the probe cache, where the launch path's test-before-open
//     gate then spuriously warned "was unreachable" on every launch. The per-card
//     Test button already gated on isSocks5Probeable; Test-all must too.
//
//  2. The card re-hydrated a proxy's cached exit IP / country on reload even when
//     the LAST capability probe was reachable:false. saveProbeResult preserves
//     the prior exit-geo across a failed re-test, so a proxy that was healthy
//     then went down showed a STALE "exit US 1.2.3.4" next to the red
//     "unreachable" pill — a misleading exit location for a dead proxy.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type { ProbeCacheMap } from '../../src/lib/proxy-probe-cache';

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const saveProbeResult = vi.fn(() => Promise.resolve({}));

const SOCKS5_PROXY: ProxyConfig = {
  id: 'socks1',
  label: 'eu-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'socks5',
};

const WIREGUARD_PROXY: ProxyConfig = {
  id: 'wg1',
  label: 'wg-london',
  host: 'wg.example.com',
  port: 51820,
  username: null,
  password: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'wireguard',
  wireguard: {
    private_key: 'PRIV',
    peer_public_key: 'PEER',
    endpoint: 'wg.example.com:51820',
    allowed_ips: '0.0.0.0/0',
    address: '10.7.0.2/32',
  },
};

let stored: ProxyConfig[] = [];
let probeCache: ProbeCacheMap = {};

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
}));

vi.mock('../../src/lib/proxy-probe-cache', () => ({
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve(probeCache),
  saveExitResult: vi.fn(() => Promise.resolve()),
  saveProbeResult: (...args: unknown[]) => saveProbeResult(...(args as [])),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
}));

const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

describe('ProxiesView "Test all" skips non-SOCKS5 proxies', () => {
  beforeEach(() => {
    testProxy.mockReset();
    saveProbeResult.mockClear();
    stored = [SOCKS5_PROXY, WIREGUARD_PROXY];
    probeCache = {};
  });

  it('probes only the SOCKS5 proxy, never the VPN endpoint', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 30,
      message: 'ok',
    });
    render(<ProxiesView />);
    const btn = await screen.findByRole('button', { name: 'Test all' });
    fireEvent.click(btn);

    // The SOCKS5 proxy lands a result; the WireGuard one is never probed.
    await waitFor(() => {
      expect(testProxy).toHaveBeenCalledTimes(1);
    });
    expect(testProxy).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'proxy.example.com', port: 1080 }),
    );
    // Crucially the VPN endpoint was NOT SOCKS5-probed.
    expect(testProxy).not.toHaveBeenCalledWith(expect.objectContaining({ host: 'wg.example.com' }));
    // And no false-negative was persisted for the VPN proxy.
    await waitFor(() => {
      const probedIds = saveProbeResult.mock.calls.map((c) => (c as unknown[])[0]);
      expect(probedIds).not.toContain('wg1');
    });
  });
});

describe('ProxiesView does not re-hydrate stale exit-geo for a down proxy', () => {
  beforeEach(() => {
    testProxy.mockReset();
    stored = [SOCKS5_PROXY];
  });

  it('hides the cached exit IP when the last capability probe was unreachable', async () => {
    // Cached: the proxy went down on its last test, but a prior healthy probe
    // had recorded an exit IP/country that saveProbeResult preserved.
    probeCache = {
      socks1: {
        at: Date.now(),
        result: {
          reachable: false,
          auth_ok: false,
          udp_associate: false,
          can_route: false,
          connect_reply: 0xff,
          latency_ms: 0,
          message: 'TCP connect failed: timed out',
        },
        exitIp: '203.0.113.7',
        exitCountry: 'US',
      },
    };
    render(<ProxiesView />);
    // The down verdict renders…
    expect(await screen.findByText('unreachable')).toBeTruthy();
    // …but the stale exit IP must NOT — the row shows the honest prompt instead.
    expect(screen.queryByText('203.0.113.7')).toBeNull();
    expect(screen.getByText('run Test for exit IP')).toBeTruthy();
  });

  it('still hydrates the exit IP when the last probe was healthy', async () => {
    probeCache = {
      socks1: {
        at: Date.now(),
        result: {
          reachable: true,
          auth_ok: true,
          udp_associate: true,
          can_route: true,
          connect_reply: 0x00,
          latency_ms: 40,
          message: 'ok',
        },
        exitIp: '203.0.113.7',
        exitCountry: 'US',
      },
    };
    render(<ProxiesView />);
    // The exit IP renders in the proxy row AND the test-detail line — both fed
    // from the hydrated healthy cache entry.
    const ips = await screen.findAllByText('203.0.113.7');
    expect(ips.length).toBeGreaterThan(0);
  });
});
