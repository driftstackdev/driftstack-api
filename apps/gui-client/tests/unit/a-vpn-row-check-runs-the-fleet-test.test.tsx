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
const saveFleetFailure = vi.fn<(...a: unknown[]) => Promise<Record<string, never>>>(() =>
  Promise.resolve({}),
);
const { updateAccountProxy, testAccountProxy } = vi.hoisted(() => ({
  updateAccountProxy:
    vi.fn<
      (
        baseUrl: string,
        apiKey: string,
        id: string,
        patch: Record<string, unknown>,
      ) => Promise<{ id: string }>
    >(),
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
  // (n) N2 — the account row is REFRESHED from this Mac's material before the fleet leg,
  // so the tunnel a check measures is the config the customer holds and not the one the
  // last launch stored. Doubled here (it is a PUT) and recorded in the same call order,
  // which is what makes "before" measurable rather than merely asserted.
  updateProxy: (baseUrl: string, apiKey: string, id: string, patch: Record<string, unknown>) => {
    callOrder.push('updateAccountProxy');
    return updateAccountProxy(baseUrl, apiKey, id, patch);
  },
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
  saveFleetFailure: (...a: unknown[]) => saveFleetFailure(...a),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
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
  updateAccountProxy.mockReset();
  updateAccountProxy.mockResolvedValue({ id: 'aprx_vpn' });
  saveEndpointResult.mockClear();
  saveExitResult.mockClear();
  saveServerProbeResult.mockClear();
  saveFleetFailure.mockClear();
  callOrder.length = 0;
  settingsStub.settings.apiKey = 'ds_test_x';
  stored = [vpnRow()];
});

async function clickCheck(): Promise<void> {
  const btn = await screen.findByRole('button', { name: /^check vpn$|^re-check$/i });
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
    // (n) N2 — and the account row was refreshed BETWEEN the two: resolve → push → fleet.
    expect(updateAccountProxy).toHaveBeenCalledTimes(1);
    expect(updateAccountProxy.mock.calls[0]?.[3]).toMatchObject({
      scheme: 'openvpn',
      host: 'vpn.example.com',
      openvpn: { config_blob: 'client\nremote vpn.example.com 1194\n' },
    });
    expect(callOrder.indexOf('updateAccountProxy')).toBeLessThan(
      callOrder.indexOf('testAccountProxy'),
    );
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
    // (l) #2 — an HTTP row's button is "Check endpoint" (DNS only), never "Check VPN".
    fireEvent.click(await screen.findByRole('button', { name: /^check endpoint$/i }));
    expect(await screen.findByText('endpoint ok')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(testAccountProxy).not.toHaveBeenCalled();
    expect(screen.queryByText('tunnel up')).toBeNull();
  });

  it('a control-plane FALLBACK (no test Mac free) is not a tunnel verdict — "endpoint ok", never "tunnel up"', async () => {
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

// (h) VPN surfaces audit — findings 1, 6, 9, 12, 13, 15, 19, 22, 23, 25, 26.
const NO_NODE: AccountProxiesModule.AccountProxyTestResult = {
  ok: false,
  reason: 'No fleet Mac was free to test this VPN tunnel. Try again in a minute.',
  measured_from: 'control_plane',
  not_run: 'no_node',
};
const FLEET_FAILED: AccountProxiesModule.AccountProxyTestResult = {
  ok: false,
  reason: 'The Mac that runs your profiles could not bring this tunnel up.',
  measured_from: 'fleet',
};
const quicChip = (): HTMLElement | null =>
  document.querySelector('[data-component="vpn-quic-chip"]');

async function clickTestAll(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
}

describe('(h) — the VPN row says what its check does, and renders what the fleet measured', () => {
  it('CRITICAL the button title, the exit placeholder and the Protocols cell name the CHECK, not a Test the row lacks', async () => {
    render(<ProxiesView />);
    // (l) #10 / #11 — one name for the action ("Check VPN", as on the card) and
    // no "fleet Mac" in the customer's sentence.
    const btn = await screen.findByRole('button', { name: /^check vpn$/i });
    expect(btn.getAttribute('title')).toBe(
      'Check VPN — resolves the endpoint, then the test Mac brings the tunnel up and measures its latency and exit.',
    );
    expect(btn.getAttribute('title')).not.toMatch(/DNS-resolve|verifies at launch/);
    expect(screen.getByText('no exit measured yet — run Check VPN')).toBeInTheDocument();
    expect(screen.queryByText('run Test for exit IP')).toBeNull();
    // The Protocols cell is a QUIC-only chip (UDP is carried by the tunnel, not
    // probed), honest about not having measured yet and naming Check.
    const chip = quicChip();
    expect(chip?.getAttribute('data-ok')).toBe('unmeasured');
    expect(chip?.getAttribute('title')).toMatch(/run Check VPN/);
    expect(chip?.getAttribute('title')).not.toMatch(/click Test/);
    expect(document.querySelector('[data-component="proxy-capabilities"]')).toBeNull();
  });

  it('CRITICAL after a fleet ok the Protocols cell shows the fleet relay verdict (was a permanent "untested")', async () => {
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('42ms')).toBeInTheDocument();
    expect(quicChip()?.getAttribute('data-ok')).toBe('true');
    testAccountProxy.mockResolvedValue({ ...FLEET_OK, quic_probe: false });
    await clickCheck();
    await waitFor(() => expect(quicChip()?.getAttribute('data-ok')).toBe('false'));
  });

  // Finding 12 — the failed branch dropped latency/vantage/relay/fingerprint but
  // NOT the exit, so the earlier successful test's exit IP, flag and city stayed
  // beside the red "tunnel down". Mutation: drop the exitResults dropKey in the
  // failed branch and this arm reds.
  it('CRITICAL a fleet FAILURE drops the exit and the QUIC verdict the previous ok had shown, and persists the failure', async () => {
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    expect(quicChip()?.getAttribute('data-ok')).toBe('true');
    testAccountProxy.mockResolvedValue(FLEET_FAILED);
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    expect(screen.queryByText('203.0.113.9')).toBeNull();
    expect(screen.queryByText('Amsterdam, North Holland')).toBeNull();
    expect(screen.queryByText('42ms')).toBeNull();
    expect(quicChip()?.getAttribute('data-ok')).toBe('unmeasured');
    // The failure is WRITTEN (finding 1): the cache must not keep carrying the
    // superseded ok fields for the next emit to re-hydrate.
    await waitFor(() => expect(saveFleetFailure).toHaveBeenCalledTimes(1));
    expect(saveFleetFailure.mock.calls[0]?.[0]).toBe('vpn1');
    expect(saveServerProbeResult).toHaveBeenCalledTimes(1);
  });

  // (i) I2 — the failed branch's `setQuicMeasured(dropKey)` had no direct
  // guard: the arm above seeds only the fleet RELAY verdict (quicProbe), and a
  // live session's HTTP/3 verdict (quicMeasured 'h3') outranks it in the chip,
  // so dropping quicProbe alone would leave the chip green. MUTATION: drop the
  // quicMeasured dropKey in handleCheckEndpoint's failed branch → the chip stays
  // data-ok="true" → red. The cache is mocked here (loadProbeCache → {}), so no
  // emit can revert the chip on the view's behalf.
  it('CRITICAL a fleet FAILURE reverts a live session’s HTTP/3 chip (quicMeasured h3) to unmeasured', async () => {
    testAccountProxy.mockResolvedValue({
      ...FLEET_OK,
      quic_measured: 'h3',
      quic_measured_at: new Date().toISOString(),
    });
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('42ms')).toBeInTheDocument();
    expect(quicChip()?.getAttribute('data-ok')).toBe('true');
    expect(quicChip()?.getAttribute('title')).toMatch(/live session/);
    testAccountProxy.mockResolvedValue(FLEET_FAILED);
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    expect(quicChip()?.getAttribute('data-ok')).toBe('unmeasured');
    expect(quicChip()?.getAttribute('title')).not.toMatch(/live session/);
  });

  it('the previous verdict stays on the row for the whole fleet wait, until THIS check answers', async () => {
    testAccountProxy.mockResolvedValue(FLEET_FAILED);
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    let release: (r: AccountProxiesModule.AccountProxyTestResult) => void = () => undefined;
    testAccountProxy.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await clickCheck();
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(2));
    // Still "tunnel down" while the fleet is working — not a flash of "endpoint ok".
    expect(screen.getByText('tunnel down')).toBeInTheDocument();
    release(FLEET_OK);
    expect(await screen.findByText('tunnel up')).toBeInTheDocument();
    expect(screen.queryByText('tunnel down')).toBeNull();
  });
});

describe('(h) — a resolved row whose tunnel nothing measured is "not tested", never "up", "down" or "unresolved"', () => {
  it('CRITICAL no_node is a muted notice on the row and a "not tested (no test Mac free)" in the sweep', async () => {
    testAccountProxy.mockResolvedValue(NO_NODE);
    render(<ProxiesView />);
    await clickTestAll();
    const notice = await screen.findByText(NO_NODE.reason);
    expect(notice.className).toContain('text-ink-muted');
    expect(screen.queryByText('tunnel down')).toBeNull();
    expect(screen.getByText('endpoint ok')).toBeInTheDocument();
    expect(
      await screen.findByText('1 VPN tunnel not tested (no test Mac free) — nothing was tested'),
    ).toBeInTheDocument();
  });

  it('CRITICAL the mixed sentence: up, down and not tested, each counted once', async () => {
    stored = [
      vpnRow(),
      { ...vpnRow(), id: 'vpn2', label: 'ResVPN 2', serverId: 'aprx_vpn2' },
      { ...vpnRow(), id: 'vpn3', label: 'ResVPN 3', serverId: 'aprx_vpn3' },
    ];
    testAccountProxy.mockImplementation((_b, _k, id) =>
      Promise.resolve(id === 'aprx_vpn' ? FLEET_OK : id === 'aprx_vpn2' ? FLEET_FAILED : NO_NODE),
    );
    render(<ProxiesView />);
    await clickTestAll();
    expect(
      await screen.findByText(
        'Tested 3 — 1 VPN tunnel up, 1 down, 1 not tested (no test Mac free)',
      ),
    ).toBeInTheDocument();
  });

  // (i) I4 — a fleet ok with NO timing still brought the tunnel UP: the row
  // adopts the exit and the QUIC chip from that reply, so the pill and the tally
  // say "up" and name the missing number — the row was tallied "not tested"
  // while wearing the fields that same reply put on it. MUTATION: return the
  // notTested bucket for `latencyMs === null` again → red.
  it('CRITICAL a fleet ok with NO timing is "tunnel up · no latency", and the tally counts it up (no latency reported)', async () => {
    testAccountProxy.mockResolvedValue({ ...FLEET_OK, latency_ms: null });
    render(<ProxiesView />);
    await clickTestAll();
    expect(
      await screen.findByText('Tested 1 — 1 VPN tunnel up (no latency reported)'),
    ).toBeInTheDocument();
    expect(screen.getByText('tunnel up · no latency')).toBeInTheDocument();
    expect(screen.queryByText('endpoint ok')).toBeNull();
    expect(screen.queryByText('tunnel up')).toBeNull();
    expect(screen.queryByText(/not tested/)).toBeNull();
    // The row wears that reply's exit and relay verdict — the pill now agrees
    // with them — and shows no number it was not given.
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    expect(quicChip()?.getAttribute('data-ok')).toBe('true');
    expect(screen.queryByText('42ms')).toBeNull();
    expect(document.querySelector('[data-latency-vantage]')).toBeNull();
  });

  it('CONTROL — a fleet ok WITH a timing is plain "tunnel up", and the clause carries no parenthetical', async () => {
    render(<ProxiesView />);
    await clickTestAll();
    expect(await screen.findByText('Tested 1 — 1 VPN tunnel up')).toBeInTheDocument();
    expect(screen.getByText('tunnel up')).toBeInTheDocument();
    expect(screen.queryByText('tunnel up · no latency')).toBeNull();
  });

  it('the mixed sentence names how many of the up tunnels reported no latency', async () => {
    stored = [
      vpnRow(),
      { ...vpnRow(), id: 'vpn2', label: 'ResVPN 2', serverId: 'aprx_vpn2' },
      { ...vpnRow(), id: 'vpn3', label: 'ResVPN 3', serverId: 'aprx_vpn3' },
    ];
    testAccountProxy.mockImplementation((_b, _k, id) =>
      Promise.resolve(
        id === 'aprx_vpn'
          ? FLEET_OK
          : id === 'aprx_vpn2'
            ? { ...FLEET_OK, latency_ms: null }
            : FLEET_FAILED,
      ),
    );
    render(<ProxiesView />);
    await clickTestAll();
    expect(
      await screen.findByText('Tested 3 — 2 VPN tunnels up (1 with no latency reported), 1 down'),
    ).toBeInTheDocument();
  });

  it('a control-plane fallback ok, and a row with no API key, are "not tested" with their own reason (finding 6/15: no more "No proxy results landed")', async () => {
    const { node_id: _dropped, ...cp } = FLEET_OK;
    testAccountProxy.mockResolvedValue({ ...cp, measured_from: 'control_plane' });
    const first = render(<ProxiesView />);
    await clickTestAll();
    expect(
      await screen.findByText(
        '1 VPN tunnel not tested (measured from the server, not the test Mac) — nothing was tested',
      ),
    ).toBeInTheDocument();
    first.unmount();
    settingsStub.settings.apiKey = null;
    render(<ProxiesView />);
    await clickTestAll();
    expect(
      await screen.findByText(
        '1 VPN tunnel not tested (Connect your API key in Settings to test it) — nothing was tested',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('No proxy results landed — run Test all again.')).toBeNull();
  });

  it('the skipped clause names the ACTUAL not_run reason (a busy Mac is not a live session)', async () => {
    testAccountProxy.mockResolvedValue({
      ok: false,
      reason: 'The Mac that runs your profiles is busy with another tunnel or test.',
      measured_from: 'fleet',
      not_run: 'node_busy',
    });
    render(<ProxiesView />);
    await clickTestAll();
    expect(
      await screen.findByText(
        '1 VPN tunnel skipped (the test Mac was busy; try again in a minute) — nothing was tested',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/live session/)).toBeNull();
  });

  // Finding 25 — the resolver THROWING was stored as an unresolved DNS verdict
  // and counted as a checked tunnel that is not up.
  it('CRITICAL a resolver that fails to RUN is "could not run", not "unresolved", and no tunnel verdict', async () => {
    resolveEndpoint.mockRejectedValue(new Error('native command failed'));
    render(<ProxiesView />);
    await clickTestAll();
    expect(
      await screen.findByText(
        '1 VPN check could not run (the address lookup failed; try again) — nothing was tested',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('unresolved')).toBeNull();
    expect(screen.queryByText('endpoint ✗')).toBeNull();
    const notice = screen.getByText('The endpoint check could not run on this Mac. Try again.');
    expect(notice.className).toContain('text-ink-muted');
    expect(testAccountProxy).not.toHaveBeenCalled();
    expect(screen.queryByText(/VPN tunnels? up/)).toBeNull();
  });
});
