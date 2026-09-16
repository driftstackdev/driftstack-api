// (V6 2026-09-16) ITEM 3 — the Proxies grid's UDP chip for a VPN row.
//
// ⛔ THE GRID HAD NO UDP CHIP AT ALL for a VPN row, on the rule "a tunnel carries
// UDP; nothing probes it here". That rule stops being true: the node's three-state
// `udp_associate` (true | false | null, with a `udp_detail` sentence) is
// contracted. A surface that renders NOTHING has no way to say a measured NO —
// absence and a negative verdict would both have looked like silence, which is
// precisely the confusion this item exists to remove.
//
// So the cell shows three states, and the third is not a negative:
//   • no reading      → '⇢ UDP', its own glyph, "UDP travels inside the VPN";
//   • measured false  → '⤵ UDP', muted, a real verdict about this tunnel;
//   • measured true   → '✓ UDP', green.
//
// The fixtures are the ROUTE'S OWN reply shapes. Today's VPN reply carries no
// `udp_associate` at all (the control plane drops the node's asserted literal —
// apps/server/src/routes/account-me.ts `capabilityReadingsForReply`), so the first
// arm is the state every customer is in right now.
//
// ⛔ PRODUCTION LINES WHOSE REVERSION REDS AN ARM HERE:
//  • `<VpnUdpChip udpProbe={udpProbe} />` in the VPN branch of the Protocols cell
//    (views/ProxiesView.tsx) — remove it and every arm reds with "the VPN UDP chip
//    did not render", which is the state the grid shipped in before this item.
//  • `setUdpProbe((m) => (udpRelay !== undefined ? { ...m, [id]: udpRelay } : m))`
//    in `applyServerProbeOutcome` (views/ProxiesView.tsx) — delete it and the two
//    MEASURED arms red; change the `: m` to `: dropKey(m, id)` and the ROLLOUT arm
//    reds (a reply that measured nothing erasing one that did).
//  • `VpnUdpChip`'s `udpProbe === undefined` early return — collapse it into the
//    boolean chip and the NOT-MEASURED arm reds on `data-ok`, and the chip starts
//    rendering '⤵ UDP' for a tunnel nobody probed.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const resolveEndpoint =
  vi.fn<
    (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
  >();
const { updateAccountProxy, testAccountProxy } = vi.hoisted(() => ({
  updateAccountProxy: vi.fn<(...a: unknown[]) => Promise<{ id: string }>>(),
  testAccountProxy:
    vi.fn<(...a: unknown[]) => Promise<AccountProxiesModule.AccountProxyTestResult>>(),
}));

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
  testProxy: vi.fn<(input: unknown) => Promise<ProxyTestResult>>(),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: (host: string, port: number) => resolveEndpoint(host, port),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  updateProxy: (...a: unknown[]) => updateAccountProxy(...a),
  testAccountProxy: (...a: unknown[]) => testAccountProxy(...a),
}));

// ⛔ The cache writers are inert, deliberately: this file measures what the VIEW
// does with a reply, so every chip below is the in-memory application
// (`applyServerProbeOutcome`) and never a cache emit that could mask it.
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve({}),
  saveExitResult: vi.fn(() => Promise.resolve({})),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveOsFingerprint: vi.fn(() => Promise.resolve({})),
  saveServerProbeResult: vi.fn(() => Promise.resolve({})),
  saveEndpointResult: vi.fn(() => Promise.resolve({})),
  saveFleetFailure: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

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

/** TODAY'S reply for a healthy tunnel: the route dropped the node's asserted
 *  `udp_associate` and `h2_ok`, and the QUIC leg was declared skipped. Nothing on
 *  it says anything about UDP. */
const FLEET_OK_NO_UDP: AccountProxiesModule.AccountProxyTestResult = {
  ok: true,
  latency_ms: 61,
  measured_from: 'fleet',
  node_id: 'mac-mini-07',
  quic_detail: 'skipped: quic leg not probed on the vpn path',
};

/** The MIGRATED node's reply, through the route: a leg that ran and failed. */
const FLEET_UDP_FALSE: AccountProxiesModule.AccountProxyTestResult = {
  ...FLEET_OK_NO_UDP,
  udp_associate: false,
  udp_detail: 'udp relay refused by the tunnel peer',
};

const FLEET_UDP_TRUE: AccountProxiesModule.AccountProxyTestResult = {
  ...FLEET_OK_NO_UDP,
  udp_associate: true,
  udp_detail: 'udp relayed through the tunnel',
};

beforeEach(() => {
  resolveEndpoint.mockReset();
  resolveEndpoint.mockResolvedValue({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
  testAccountProxy.mockReset();
  updateAccountProxy.mockReset();
  updateAccountProxy.mockResolvedValue({ id: 'aprx_vpn' });
  settingsStub.settings.apiKey = 'ds_test_x';
  stored = [vpnRow()];
});

function udpChip(): Element {
  const el = document.querySelector('[data-component="vpn-udp-chip"]');
  if (el === null) throw new Error('the VPN UDP chip did not render');
  return el;
}

async function check(): Promise<void> {
  const btn = await screen.findByRole('button', { name: /^check vpn$|^re-check$/i });
  fireEvent.click(btn);
}

describe("a VPN row's UDP chip tells a measurement apart from an absence", () => {
  it('CRITICAL a row nobody has checked reads NOT MEASURED — not a negative verdict', async () => {
    render(<ProxiesView />);
    await waitFor(() => {
      expect(udpChip().getAttribute('data-ok')).toBe('unmeasured');
    });
    expect(udpChip().getAttribute('data-udp')).toBe('tunnel');
    expect(udpChip().textContent).toContain('⇢');
    const title = udpChip().getAttribute('title') ?? '';
    expect(title).toMatch(/travels inside the VPN/i);
    // ⛔ THE POSITIVE HALF. `not.toMatch(/no udp/i)` is satisfied by a sentence
    // that never mentions measurement — and this one did not: it opened with a
    // flat claim about the tunnel's UDP, in the state that exists because the
    // control plane dropped the node's asserted `true`. The state must be said.
    expect(title).toMatch(/not been measured|not measured yet/i);
    // ⛔ THE ASSERTION THIS ITEM IS ABOUT.
    expect(title).not.toMatch(/no udp/i);
  });

  it("CRITICAL today's fleet reply carries no udp_associate, so a SUCCESSFUL check leaves it not measured", async () => {
    // The state every customer is in right now: the tunnel came up, the latency
    // is real, and UDP was never probed. The chip must not turn into a verdict
    // just because the check succeeded.
    testAccountProxy.mockResolvedValue(FLEET_OK_NO_UDP);
    render(<ProxiesView />);
    await check();
    // The reply landed — the fleet latency is on the row.
    await screen.findByText('61ms');
    expect(udpChip().getAttribute('data-ok')).toBe('unmeasured');
    expect(udpChip().getAttribute('title') ?? '').toMatch(/not been measured|not measured yet/i);
    expect(udpChip().getAttribute('title') ?? '').not.toMatch(/no udp/i);
  });

  it('CRITICAL a MEASURED false renders the negative verdict, distinguishable from the absence', async () => {
    testAccountProxy.mockResolvedValue(FLEET_UDP_FALSE);
    render(<ProxiesView />);
    await check();
    await waitFor(() => {
      expect(udpChip().getAttribute('data-ok')).toBe('false');
    });
    expect(udpChip().getAttribute('data-udp')).toBe('false');
    expect(udpChip().textContent).toContain('⤵');
    const title = udpChip().getAttribute('title') ?? '';
    // A MEASURED negative may say "no UDP" — that is exactly the difference.
    expect(title).toMatch(/no udp/i);
    expect(title).toMatch(/measured/i);
  });

  it('VACUITY CONTROL a MEASURED true renders green, so the arm above is not "anything present is a ⤵"', async () => {
    testAccountProxy.mockResolvedValue(FLEET_UDP_TRUE);
    render(<ProxiesView />);
    await check();
    await waitFor(() => {
      expect(udpChip().getAttribute('data-ok')).toBe('true');
    });
    expect(udpChip().textContent).toContain('✓');
    expect(udpChip().getAttribute('title') ?? '').toMatch(/relays through this tunnel/i);
  });

  it('CRITICAL ROLLOUT a legacy Mac answering after a migrated one does not erase the verdict', async () => {
    // A fleet with one migrated Mac and one legacy Mac. The legacy reply measured
    // NOTHING about UDP, and a non-measurement must never retire a measurement —
    // the (V5) "a successful re-check turns the green chip untested" defect,
    // arriving through the field added beside the one it was fixed for.
    testAccountProxy.mockResolvedValue(FLEET_UDP_TRUE);
    render(<ProxiesView />);
    await check();
    await waitFor(() => {
      expect(udpChip().getAttribute('data-ok')).toBe('true');
    });
    testAccountProxy.mockResolvedValue(FLEET_OK_NO_UDP);
    await check();
    await screen.findByText('61ms');
    expect(udpChip().getAttribute('data-ok')).toBe('true');
    // …and a migrated Mac measuring the OPPOSITE does replace it: the rule is
    // "a non-measurement cannot retire one", not "the first verdict wins".
    testAccountProxy.mockResolvedValue(FLEET_UDP_FALSE);
    await check();
    await waitFor(() => {
      expect(udpChip().getAttribute('data-ok')).toBe('false');
    });
  });

  it('CRITICAL a fleet FAILURE drops it — a tunnel that did not come up has no UDP verdict', async () => {
    testAccountProxy.mockResolvedValue(FLEET_UDP_TRUE);
    render(<ProxiesView />);
    await check();
    await waitFor(() => {
      expect(udpChip().getAttribute('data-ok')).toBe('true');
    });
    testAccountProxy.mockResolvedValue({
      ok: false,
      reason: 'The proxy did not answer. Check the host and port, and that it is online.',
      measured_from: 'fleet',
    });
    await check();
    await screen.findByText(/did not answer/i);
    expect(udpChip().getAttribute('data-ok')).toBe('unmeasured');
  });
});
