// (l) SOCKS5/chat audit — findings #14 and #16 (L6).
//
// #14 On a SOCKS5 Test whose exit probe failed (null), the grid's honest "exit
//     geo unavailable — the probe did not complete" state was overwritten
//     seconds later by the next cache emit (the fleet test's persist, the
//     sweeper, a list adoption): `saveProbeResult` carries the PREVIOUS exit
//     across the capability write and nothing recorded "the exit probe failed",
//     so the derivation re-hydrated the older IP beside "Tested just now".
// #16 A scheme-only edit (vpn→socks5, same host/port/credentials) neither
//     invalidated the probe cache nor cleared the card's VPN banner/notice:
//     `connChanged` compared host/port/username/password only, and the card
//     rendered `vpnFailure` / `vpnNotice` ungated by `vpn`.
//
// The cache arms use the real module over a store double; the grid arm renders
// ProxiesView over that same real cache so the emit path is the one under test.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';

const stores = new Map<string, Map<string, unknown>>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private file: string;
    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }
    private map(): Map<string, unknown> {
      let m = stores.get(this.file);
      if (!m) {
        m = new Map();
        stores.set(this.file, m);
      }
      return m;
    }
    get(key: string): Promise<unknown> {
      return Promise.resolve(this.map().get(key));
    }
    set(key: string, value: unknown): Promise<void> {
      this.map().set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};
const SOCKS5: ProxyConfig = {
  id: 'socks1',
  label: 'eu-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'socks5',
};
const WG: ProxyConfig = {
  id: 'wg1',
  label: 'wg-london',
  host: 'wg.example.com',
  port: 51820,
  username: null,
  password: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'wireguard',
  wireguard: {
    private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
    peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
    endpoint: 'wg.example.com:51820',
    allowed_ips: '0.0.0.0/0',
    address: '10.7.0.2/32',
  },
};

let stored: ProxyConfig[] = [];
const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const probeProxyExit = vi.fn<(input: unknown) => Promise<unknown>>();
const updateProxy = vi.fn(() => Promise.resolve({}));

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: (...a: unknown[]) => updateProxy(...(a as [])),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: (input: unknown) => probeProxyExit(input),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const cache = await import('../../src/lib/proxy-probe-cache');
const { ProxiesView } = await import('../../src/views/ProxiesView');

const STORE = 'proxy-probe-cache.json';
function seedCache(probes: Record<string, unknown>): void {
  stores.set(STORE, new Map<string, unknown>([['probes', probes]]));
}
const NOW = 1_800_000_000_000;
const healthyWithExit = (exitAt: number) => ({
  result: OK,
  at: NOW - 60_000,
  exitIp: '203.0.113.7',
  exitCountry: 'US',
  exitCity: 'Ashburn',
  exitTimezone: 'America/New_York',
  exitAt,
});

beforeEach(() => {
  stores.clear();
  stored = [SOCKS5];
  testProxy.mockReset();
  testProxy.mockResolvedValue(OK);
  probeProxyExit.mockReset();
  probeProxyExit.mockResolvedValue(null);
  updateProxy.mockClear();
});

describe('#14 — the cache records a failed exit probe', () => {
  it('clearExitResult drops every exit field, stamps exitProbeFailedAt, keeps the rest, and survives a reload', async () => {
    seedCache({ socks1: { ...healthyWithExit(NOW - 1000), serverLatencyMs: 30, quicProbe: true } });
    await cache.clearExitResult('socks1', NOW);
    const c = (await cache.loadProbeCache()).socks1;
    expect(c).toEqual({
      result: OK,
      at: NOW - 60_000,
      serverLatencyMs: 30,
      quicProbe: true,
      exitProbeFailedAt: NOW,
    });
  });

  it('the derivation emits the NULL state (not absent) for a usable entry whose exit probe failed', async () => {
    seedCache({ socks1: healthyWithExit(NOW - 1000) });
    const all = await cache.clearExitResult('socks1', NOW);
    const view = cache.deriveProbeViewState(all, NOW);
    expect('socks1' in view.exitResults).toBe(true);
    expect(view.exitResults.socks1).toBeNull();
  });

  it('a capability re-test carries the stamp; a measured exit clears it', async () => {
    seedCache({ socks1: healthyWithExit(NOW - 1000) });
    await cache.clearExitResult('socks1', NOW);
    let c = (await cache.saveProbeResult('socks1', OK, NOW + 1)).socks1;
    expect(c?.exitProbeFailedAt).toBe(NOW);
    expect(c?.exitIp).toBeUndefined();
    c = (await cache.saveExitResult('socks1', '198.51.100.9', 'NL', {}, NOW + 2)).socks1;
    expect(c?.exitProbeFailedAt).toBeUndefined();
    expect(c?.exitIp).toBe('198.51.100.9');
  });

  it('CONTROL — a down proxy with the stamp emits nothing (the usable gate still governs)', async () => {
    seedCache({
      socks1: {
        ...healthyWithExit(NOW - 1000),
        result: { ...OK, reachable: false, can_route: false },
      },
    });
    const all = await cache.clearExitResult('socks1', NOW);
    expect('socks1' in cache.deriveProbeViewState(all, NOW).exitResults).toBe(false);
  });

  it('is a no-op for a proxy with no entry', async () => {
    seedCache({});
    expect(await cache.clearExitResult('ghost', NOW)).toEqual({});
  });
});

describe('#14 — the grid keeps "exit geo unavailable" through the next cache emit', () => {
  // MUTATION: drop the `clearExitResult` call in ProxiesView.handleTest → the
  // sweeper-shaped emit below re-hydrates 203.0.113.7 → red.
  it('CRITICAL a Test whose exit probe fails shows the null state, and a later emit does not bring the OLD exit back', async () => {
    seedCache({ socks1: healthyWithExit(NOW - 1000) });
    render(<ProxiesView />);
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^re-test$/i }));
    await waitFor(() => expect(probeProxyExit).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText('exit geo unavailable — the probe did not complete'),
    ).toBeInTheDocument();
    expect(screen.queryByText('203.0.113.7')).toBeNull();
    await waitFor(async () =>
      expect((await cache.loadProbeCache()).socks1?.exitProbeFailedAt).toBeTypeOf('number'),
    );
    // Another writer emits (the sweeper re-testing this row, a fleet persist…).
    await act(async () => {
      await cache.saveProbeResult('socks1', OK, Date.now());
    });
    expect(
      screen.getByText('exit geo unavailable — the probe did not complete'),
    ).toBeInTheDocument();
    expect(screen.queryByText('203.0.113.7')).toBeNull();
    expect(screen.queryByText('run Test for exit IP')).toBeNull();
  });

  it('VACUITY CONTROL — a Test whose exit probe SUCCEEDS shows the new exit, and the stamp is not set', async () => {
    seedCache({ socks1: healthyWithExit(NOW - 1000) });
    probeProxyExit.mockResolvedValue({
      ip: '198.51.100.9',
      country: 'NL',
      city: null,
      region: null,
      timezone: 'Europe/Amsterdam',
    });
    render(<ProxiesView />);
    await screen.findByText('203.0.113.7');
    fireEvent.click(screen.getByRole('button', { name: /^re-test$/i }));
    expect(await screen.findByText('198.51.100.9')).toBeInTheDocument();
    await waitFor(async () =>
      expect((await cache.loadProbeCache()).socks1?.exitIp).toBe('198.51.100.9'),
    );
    expect((await cache.loadProbeCache()).socks1?.exitProbeFailedAt).toBeUndefined();
  });
});

describe('#16 — a scheme-only edit is a changed connection', () => {
  // MUTATION: drop `prev.scheme !== draft.scheme` from connChanged → no
  // invalidation, no re-test → red.
  it('CRITICAL vpn→socks5 with the same host/port invalidates the cache entry and re-tests the row', async () => {
    stored = [WG];
    seedCache({
      wg1: {
        result: { ...OK, reachable: false, auth_ok: false, can_route: false },
        at: NOW,
        endpoint: { resolved: true, ip: '1.2.3.4', message: 'ok' },
        fleetFailureReason: 'The last fleet check could not bring this tunnel up.',
        exitSupersededAt: NOW,
      },
    });
    render(<ProxiesView />);
    await screen.findByText('wg-london');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'socks5' } });
    stored = [{ ...WG, scheme: 'socks5', wireguard: undefined }];
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateProxy).toHaveBeenCalledTimes(1));
    // The row gets the check of its NEW kind…
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
    // …and the stale VPN entry (its endpoint verdict and failure sentence) is
    // gone: what the store holds now is that SOCKS5 re-test's own write.
    await waitFor(async () => {
      const c = (await cache.loadProbeCache()).wg1;
      expect(c?.endpoint).toBeUndefined();
      expect(c?.fleetFailureReason).toBeUndefined();
      expect(c?.result.reachable).toBe(true);
    });
  });

  it('CONTROL — a label-only rename keeps the entry and runs no test', async () => {
    stored = [WG];
    seedCache({
      wg1: {
        result: { ...OK, reachable: false, auth_ok: false, can_route: false },
        at: NOW,
        endpoint: { resolved: true, ip: '1.2.3.4', message: 'ok' },
      },
    });
    render(<ProxiesView />);
    await screen.findByText('wg-london');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const label = await screen.findByDisplayValue('wg-london');
    fireEvent.change(label, { target: { value: 'wg-paris' } });
    stored = [{ ...WG, label: 'wg-paris' }];
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateProxy).toHaveBeenCalledTimes(1));
    await screen.findByText('wg-paris');
    expect((await cache.loadProbeCache()).wg1).toBeDefined();
    expect(testProxy).not.toHaveBeenCalled();
  });
});

describe('#16 — the profile card gates the VPN banner and notice on `vpn`, as the grid gates on scheme', () => {
  function cardProps(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
    return {
      name: 'amsterdam shopper',
      monogram: 'AS',
      hue: 200,
      deviceLabel: 'iPhone 17',
      running: false,
      selected: false,
      lastUsedIso: null,
      folder: '',
      tags: [],
      hasProxy: true,
      proxyExplicit: true,
      flag: '🌍',
      countryCode: null,
      exitIp: null,
      latencyMs: null,
      latencyFillPct: 0,
      latencyGood: false,
      probed: true,
      capabilities: null,
      checkedAtIso: null,
      busy: false,
      launching: false,
      anyBusy: false,
      testing: false,
      testDisabled: false,
      launchDisabled: false,
      onToggleSelect: vi.fn(),
      onPrimary: vi.fn(),
      onWatch: vi.fn(),
      onTest: vi.fn(),
      vpnFailure: 'The last fleet check could not bring this tunnel up.',
      vpnNotice: 'No test Mac was free to test this VPN tunnel. Try again in a minute.',
      ...over,
    };
  }

  it('CRITICAL a card whose proxy is no longer a VPN renders neither the banner nor the notice', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: false })} />);
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
    expect(document.querySelector('[data-component="proxy-vpn-failure"]')).toBeNull();
    expect(document.querySelector('[data-component="proxy-vpn-notice"]')).toBeNull();
    expect(screen.queryByText('VPN tunnel down')).toBeNull();
    cleanup();
  });

  it('VACUITY CONTROL — a VPN card renders both', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: true })} />);
    expect(
      document.querySelector('[data-component="proxy-broken-banner"][data-vpn-failure="true"]'),
    ).not.toBeNull();
    expect(screen.getByText('VPN tunnel down')).toBeTruthy();
    expect(document.querySelector('[data-component="proxy-vpn-notice"]')).not.toBeNull();
    cleanup();
  });
});
