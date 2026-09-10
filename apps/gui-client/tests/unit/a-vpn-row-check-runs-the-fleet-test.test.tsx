// (b) VPN exit parity — a VPN grid row's "Check endpoint" used to STOP at the
// DNS pre-flight: a bare "endpoint ✓" and nothing else, while a SOCKS5 row's
// Test went on to the control plane's fleet test for latency, vantage, exit
// and OS. The server now dispatches a VPN row to a fleet Mac (the inline VPN
// wire), so the row runs the SAME shared step after the pre-flight
// (lib/proxy-server-test): latency + exit/geo like a SOCKS5 row.
//
// Arms:
//   • CRITICAL — the check resolves FIRST, then asks the fleet (vantage=fleet),
//     never the native SOCKS5 probe; the row then shows the fleet number, its
//     "fleet" marker, the observed exit and a "tunnel up" pill.
//   • CONTROL — an unresolved endpoint never reaches the fleet; no API key never
//     reaches the fleet (the fleet can only test a proxy stored on the account).
//   • a fleet `ok:false` reads "tunnel down" with the fleet's sentence, and the
//     row keeps no number.
//   • Test all now sweeps the VPN row through THIS path (its endpoint check +
//     fleet test), still never the SOCKS5 handshake, and the summary says so.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const resolveEndpoint =
  vi.fn<
    (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
  >();
const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const saveEndpointResult = vi.fn<(...a: unknown[]) => Promise<Record<string, never>>>(() =>
  Promise.resolve({}),
);
const saveExitResult = vi.fn<(...a: unknown[]) => Promise<Record<string, never>>>(() =>
  Promise.resolve({}),
);
const saveServerProbeResult = vi.fn<(...a: unknown[]) => Promise<Record<string, never>>>(() =>
  Promise.resolve({}),
);
const { testAccountProxy } = vi.hoisted(() => ({
  testAccountProxy:
    vi.fn<
      (
        baseUrl: string,
        apiKey: string,
        id: string,
        opts?: { vantage?: 'cp' | 'fleet' },
      ) => Promise<AccountProxiesModule.AccountProxyTestResult>
    >(),
}));
/** The order the two legs were entered in, so "resolve FIRST" is measured. */
const callOrder: string[] = [];

let stored: ProxyConfig[] = [];
const settingsStub = { settings: { apiKey: 'ds_test_x' as string | null, baseUrl: 'http://x' } };

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => {
    callOrder.push('testProxy');
    return testProxy(input);
  },
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: (host: string, port: number) => {
    callOrder.push('resolveEndpoint');
    return resolveEndpoint(host, port);
  },
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => {
    callOrder.push('testAccountProxy');
    return testAccountProxy(baseUrl, apiKey, id, opts);
  },
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve({}),
  saveExitResult: (...a: unknown[]) => saveExitResult(...a),
  saveProbeResult: vi.fn(() => Promise.resolve()),
  saveOsFingerprint: vi.fn(() => Promise.resolve({})),
  saveServerProbeResult: (...a: unknown[]) => saveServerProbeResult(...a),
  saveEndpointResult: (...a: unknown[]) => saveEndpointResult(...a),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => settingsStub,
}));

const { ProxiesView } = await import('../../src/views/ProxiesView');

function vpnRow(): ProxyConfig {
  return {
    id: 'vpn1',
    label: 'ResVPN',
    host: 'vpn.example.com',
    port: 1194,
    username: null,
    password: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme: 'openvpn',
    serverId: 'aprx_vpn',
    openvpn: { config_blob: 'client\nremote vpn.example.com 1194\n' },
  };
}
function socks5Row(): ProxyConfig {
  return {
    id: 's1',
    label: 'Socks',
    host: '127.0.0.1',
    port: 1080,
    username: null,
    password: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme: 'socks5',
  };
}

const HEALTHY: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};

const FLEET_OK: AccountProxiesModule.AccountProxyTestResult = {
  ok: true,
  latency_ms: 42,
  measured_from: 'fleet',
  node_id: 'mac-mini-07',
  quic_probe: true,
  exit_observed: {
    ip: '203.0.113.9',
    country: 'NL',
    timezone: 'Europe/Amsterdam',
    region: 'North Holland',
    city: 'Amsterdam',
  },
};

beforeEach(() => {
  resolveEndpoint.mockReset();
  resolveEndpoint.mockResolvedValue({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
  testProxy.mockReset();
  testProxy.mockResolvedValue(HEALTHY);
  testAccountProxy.mockReset();
  testAccountProxy.mockResolvedValue(FLEET_OK);
  saveEndpointResult.mockClear();
  saveExitResult.mockClear();
  saveServerProbeResult.mockClear();
  callOrder.length = 0;
  settingsStub.settings.apiKey = 'ds_test_x';
  stored = [vpnRow()];
});

async function clickCheck(): Promise<void> {
  const btn = await screen.findByRole('button', { name: /check endpoint|re-check/i });
  callOrder.length = 0;
  fireEvent.click(btn);
}

describe('(b) — a VPN row’s Check endpoint runs the fleet test after the pre-flight', () => {
  it('CRITICAL resolves first, then asks the fleet for THIS row — never the SOCKS5 probe', async () => {
    render(<ProxiesView />);
    await clickCheck();
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    expect(testAccountProxy).toHaveBeenCalledWith('http://x', 'ds_test_x', 'aprx_vpn', {
      vantage: 'fleet',
    });
    expect(resolveEndpoint).toHaveBeenCalledWith('vpn.example.com', 1194);
    // The DNS pre-flight is the FIRST leg; the fleet is asked after it, and the
    // SOCKS5 handshake is never sent to a VPN endpoint.
    expect(callOrder.indexOf('resolveEndpoint')).toBeLessThan(
      callOrder.indexOf('testAccountProxy'),
    );
    expect(testProxy).not.toHaveBeenCalled();
    // The pre-flight's cache write lands BEFORE the fleet result is persisted on
    // top of it (it drops the previous check's server fields).
    await waitFor(() => expect(saveServerProbeResult).toHaveBeenCalledTimes(1));
    expect(saveEndpointResult.mock.invocationCallOrder[0]).toBeLessThan(
      saveServerProbeResult.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('CRITICAL the row shows the fleet number with its marker, the observed exit, and a "tunnel up" pill', async () => {
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('42ms')).toBeInTheDocument();
    expect(
      screen
        .getByText('42ms')
        .closest('[data-latency-vantage]')
        ?.getAttribute('data-latency-vantage'),
    ).toBe('fleet');
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('Amsterdam, North Holland')).toBeInTheDocument();
    expect(screen.getByText('tunnel up')).toBeInTheDocument();
    // Never the SOCKS5 pill's words: this Mac made no connection.
    expect(screen.queryByText(/from this Mac/)).toBeNull();
    // And the exit is adopted into the exit cache through the shared step.
    await waitFor(() => expect(saveExitResult).toHaveBeenCalledTimes(1));
    expect(saveExitResult.mock.calls[0]?.slice(0, 4)).toEqual([
      'vpn1',
      '203.0.113.9',
      'NL',
      { city: 'Amsterdam', region: 'North Holland', timezone: 'Europe/Amsterdam', asnOrg: null },
    ]);
  });

  it('CONTROL — an endpoint that does not resolve never reaches the fleet', async () => {
    resolveEndpoint.mockResolvedValue({ resolved: false, ip: '', message: 'NXDOMAIN' });
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('unresolved')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(testAccountProxy).not.toHaveBeenCalled();
    expect(screen.queryByText('42ms')).toBeNull();
  });

  it('CONTROL — an HTTP row gets the pre-flight ALONE: no tunnel to test, so the fleet is never asked', async () => {
    stored = [{ ...vpnRow(), scheme: 'http' }];
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('endpoint ok')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(testAccountProxy).not.toHaveBeenCalled();
    expect(screen.queryByText('tunnel up')).toBeNull();
  });

  it('a control-plane FALLBACK (no fleet Mac free) is not a tunnel verdict — "endpoint ok", never "tunnel up"', async () => {
    const { node_id: _dropped, ...cp } = FLEET_OK;
    testAccountProxy.mockResolvedValue({ ...cp, measured_from: 'control_plane' });
    render(<ProxiesView />);
    await clickCheck();
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('endpoint ok')).toBeInTheDocument();
    expect(screen.queryByText('tunnel up')).toBeNull();
  });

  it('CONTROL — without an API key the pre-flight runs alone (the fleet cannot be asked)', async () => {
    settingsStub.settings.apiKey = null;
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('endpoint ok')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(testAccountProxy).not.toHaveBeenCalled();
  });

  it('a fleet `ok:false` reads "tunnel down" with the fleet’s sentence and leaves no number', async () => {
    testAccountProxy.mockResolvedValue({
      ok: false,
      reason: 'The Mac that runs your profiles could not connect through this proxy.',
      measured_from: 'fleet',
    });
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    expect(
      screen.getByText('The Mac that runs your profiles could not connect through this proxy.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('42ms')).toBeNull();
    expect(saveServerProbeResult).not.toHaveBeenCalled();
    expect(saveExitResult).not.toHaveBeenCalled();
  });
});

describe('(b) — Test all sweeps the VPN row through its own path', () => {
  it('the SOCKS5 row gets the native probe, the VPN row the endpoint check + fleet test, and the summary counts both', async () => {
    stored = [socks5Row(), vpnRow()];
    render(<ProxiesView />);
    const btn = await screen.findByRole('button', { name: 'Test all' });
    callOrder.length = 0;
    fireEvent.click(btn);
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    expect(testAccountProxy).toHaveBeenCalledWith('http://x', 'ds_test_x', 'aprx_vpn', {
      vantage: 'fleet',
    });
    expect(resolveEndpoint).toHaveBeenCalledWith('vpn.example.com', 1194);
    // The native probe ran for the SOCKS5 row only.
    expect(testProxy).toHaveBeenCalledTimes(1);
    expect(testProxy).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1' }));
    expect(testProxy).not.toHaveBeenCalledWith(
      expect.objectContaining({ host: 'vpn.example.com' }),
    );
    expect(await screen.findByText('Tested 2 — 1 healthy, 1/1 VPN tunnel up')).toBeInTheDocument();
  });

  it('a VPN-only pool is sweepable (the button is live) and the summary is the VPN sentence', async () => {
    render(<ProxiesView />);
    const btn = await screen.findByRole('button', { name: 'Test all' });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(await screen.findByText('Tested 1 — 1 VPN tunnel up')).toBeInTheDocument();
  });
});
