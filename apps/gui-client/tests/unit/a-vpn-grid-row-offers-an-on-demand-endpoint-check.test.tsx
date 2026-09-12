// N4 (owner: "Proxy check OVPN also not working") — the Proxies-tab grid row for a
// VPN scheme used to render a static "Verified at launch" with NO on-demand check
// (its handleTest ran a SOCKS5 probe, meaningless for a UDP VPN endpoint). The
// profile card's Test and the launch gate were already scheme-aware
// (a-vpn-row-is-resolved-never-socks5-probed.test.tsx); this was the last gap.
//
// Now a VPN grid row offers a "Check endpoint" button that DNS-resolves the endpoint
// (endpoint_resolve) — the tunnel itself still verifies at launch. A SOCKS5 row is
// unchanged (its "Test" runs the native probe), the vacuity control.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const resolveEndpoint =
  vi.fn<
    (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
  >();
const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const saveEndpointResult = vi.fn(() => Promise.resolve({}));

let stored: ProxyConfig[] = [];

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: (host: string, port: number) => resolveEndpoint(host, port),
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve({}),
  saveExitResult: vi.fn(() => Promise.resolve()),
  saveProbeResult: vi.fn(() => Promise.resolve()),
  saveEndpointResult: (...a: unknown[]) => saveEndpointResult(...(a as [])),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ settings: { apiKey: null, baseUrl: 'http://localhost:3000' } }),
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

beforeEach(() => {
  resolveEndpoint.mockReset();
  resolveEndpoint.mockResolvedValue({ resolved: true, ip: '203.0.113.9', message: 'Resolved' });
  testProxy.mockReset();
  saveEndpointResult.mockClear();
  stored = [];
});

describe('N4 — a VPN grid row offers an on-demand endpoint check', () => {
  it('renders "Check VPN" (not the static "Verified at launch") and resolves on click', async () => {
    stored = [vpnRow()];
    render(<ProxiesView />);

    // The button exists — reverting N4 restores the static "Verified at launch"
    // span with no button, and this query throws.
    // (l) #10 — the VPN row's check is named "Check VPN" (the card's menu says the same).
    const btn = await screen.findByRole('button', { name: /^check vpn$/i });
    expect(screen.queryByText(/Verified at launch/i)).toBeNull();

    // Clear any mount-time resolution so the click is what we measure.
    resolveEndpoint.mockClear();
    fireEvent.click(btn);
    await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith('vpn.example.com', 1194));
    // The SOCKS5 handshake must never be sent to a VPN endpoint.
    expect(testProxy).not.toHaveBeenCalled();
  });

  it('VACUITY CONTROL — a SOCKS5 grid row keeps its native "Test", not an endpoint check', async () => {
    stored = [socks5Row()];
    render(<ProxiesView />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^(test|re-test|testing…)$/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /check vpn|check endpoint/i })).toBeNull();
  });
});
