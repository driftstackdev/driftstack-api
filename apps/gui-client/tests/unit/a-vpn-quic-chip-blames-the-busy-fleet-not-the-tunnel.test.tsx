// (o) O5 — a Test that could not reach a fleet Mac must not read as a failed QUIC detection.
//
// MEASURED: when every fleet Mac is busy (or a deployment has none) the control plane
// answers with `measured_from: 'control_plane'` and NO `quic_ok` at all, and the client
// drops `quic_ok` unless `measured_from === 'fleet'` (account-proxies.ts). So the VPN
// row's QUIC chip stays "QUIC untested" forever, under the hint "Not measured yet — run
// Check VPN: the test Mac brings the tunnel up and probes QUIC through it." Pressing
// Check re-runs the same control-plane leg and changes nothing — the residual input that
// still reads to the owner as "it's not detecting my QUIC".
//
// The absence is about the FLEET, not about the tunnel, and the chip now says so.
//
// ⛔ 2026-09-11 — THE FIRST VERSION OF THIS GUARD PINNED A STATE PRODUCTION CANNOT ENTER.
//    It keyed the chip on `vantage === 'control_plane'` and fed it a fixture
//    `{ok:true, latency_ms:55, measured_from:'control_plane'}` — a reply the route emits
//    only for a socks5 row, which never renders this chip. For an openvpn/wireguard row
//    the fleet miss is `{ok:false, reason:'No fleet Mac was free…',
//    measured_from:'control_plane', not_run:'no_node'}` (account-me.ts), the client maps
//    it to `kind:'not_run'`, and NOTHING writes a `serverVantage` off that path — the
//    view writes one inside the `ok` arm only. So the branch was unreachable and the real
//    dead-end wording survived. The fixtures below are the route's own reply shapes, and
//    the signal is the `not_run` discriminator.
//
// ⛔ PRODUCTION LINES WHOSE REVERSION REDS ARM 1:
//    • `applyServerProbeOutcome`'s `outcome.kind === 'not_run' ? outcome.why === 'no_node'
//      ? {…[id]: true}` write in ProxiesView.tsx — delete it and the chip never learns the
//      fleet was missed.
//    • `VpnQuicChip`'s `noFleetMac ? NO_TEST_MAC_QUIC_HINT : …`. Collapse it to the old
//      single hint and arm 1 reds. Collapse it the OTHER way (always the new hint) and the
//      VACUITY CONTROLS (arms 3-4) red — the direction the real failure goes: a row that
//      never had a server test blaming a busy fleet that was never asked.

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
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
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

/** ⛔ THE ROUTE'S OWN REPLY when no fleet Mac was free for a VPN row (account-me.ts:
 *  the openvpn/wireguard fleet-miss arm). `ok:false` because nothing measured the
 *  tunnel; `not_run:'no_node'` is the discriminator a client branches on; the
 *  control-plane label says only that no node produced this — the control plane cannot
 *  bring a tunnel up, so it never falls back to one for a VPN row. There is no QUIC
 *  leg on it, and none can appear until a Mac frees up. */
const NO_NODE: AccountProxiesModule.AccountProxyTestResult = {
  ok: false,
  reason: 'No fleet Mac was free to test this VPN tunnel. Try again in a minute.',
  measured_from: 'control_plane',
  not_run: 'no_node',
};

/** The other fleet miss with the same shape: a deployment with no fleet at all. Same
 *  discriminator, and the same true sentence about where QUIC is measured. */
const NO_FLEET_AT_ALL: AccountProxiesModule.AccountProxyTestResult = {
  ok: false,
  reason: 'VPN tunnels are tested from a fleet Mac, and this deployment has none set up.',
  measured_from: 'control_plane',
  not_run: 'no_node',
};

/** CONTROL: a fleet Mac DID run the leg and the tunnel did not relay QUIC. */
const FLEET_QUIC_FALSE: AccountProxiesModule.AccountProxyTestResult = {
  ok: true,
  latency_ms: 42,
  measured_from: 'fleet',
  node_id: 'mac-mini-07',
  quic_probe: false,
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

function quicChip(): Element {
  const el = document.querySelector('[data-component="vpn-quic-chip"]');
  if (el === null) throw new Error('the VPN QUIC chip did not render');
  return el;
}

async function check(): Promise<void> {
  const btn = await screen.findByRole('button', { name: /^check vpn$|^re-check$/i });
  fireEvent.click(btn);
}

describe('(o) O5 — an unmeasured QUIC verdict names the cause the customer can act on', () => {
  it('ARM 1 — CRITICAL: the route\'s real busy-fleet reply (ok:false + not_run:"no_node") says no test Mac was free, and names the Mac that would measure it', async () => {
    testAccountProxy.mockResolvedValue(NO_NODE);
    render(<ProxiesView />);
    await check();

    await waitFor(() => {
      expect(quicChip().getAttribute('data-unmeasured')).toBe('no_fleet_mac');
    });
    const title = quicChip().getAttribute('title') ?? '';
    expect(title).toMatch(/no test Mac was free/i);
    expect(title).toMatch(/measured from the Mac that runs your profiles/i);
    // ⛔ it must NOT send the customer back to the button that just produced this.
    expect(title).not.toMatch(/run Check VPN/i);
    // Still "untested" — absence is not a negative verdict about the tunnel.
    expect(quicChip().getAttribute('data-ok')).toBe('unmeasured');
  });

  it('ARM 2 — CONTROL: a FLEET-vantage quic_ok:false still reads as the measured negative, never as a busy fleet', async () => {
    testAccountProxy.mockResolvedValue(FLEET_QUIC_FALSE);
    render(<ProxiesView />);
    await check();

    await waitFor(() => {
      expect(quicChip().getAttribute('data-ok')).toBe('false');
    });
    const title = quicChip().getAttribute('title') ?? '';
    expect(title).toMatch(/does not relay through this tunnel/i);
    expect(title).toMatch(/measured from the test Mac/i);
    expect(title).not.toMatch(/no test Mac was free/i);
  });

  it('ARM 2b — a deployment with NO fleet at all takes the same branch: same discriminator, same true sentence', async () => {
    testAccountProxy.mockResolvedValue(NO_FLEET_AT_ALL);
    render(<ProxiesView />);
    await check();

    await waitFor(() => {
      expect(quicChip().getAttribute('data-unmeasured')).toBe('no_fleet_mac');
    });
    expect(quicChip().getAttribute('title') ?? '').toMatch(/measured from the Mac that runs/i);
  });

  it('ARM 4 — CRITICAL VACUITY CONTROL: a refusal that DID reach a Mac (a live session holds the tunnel) is NOT blamed on a busy fleet', async () => {
    // The direction the real failure goes for a discriminator-driven fix: keying on
    // "any not_run" (or on the control-plane label, which rides on this reply too)
    // would tell a customer whose session is holding the tunnel that no Mac was free.
    testAccountProxy.mockResolvedValue({
      ok: false,
      reason: 'A live session is browsing through this VPN right now.',
      measured_from: 'control_plane',
      not_run: 'live_session',
    });
    render(<ProxiesView />);
    await check();

    // The row shows the refusal as its own notice — that is the reply having landed.
    await screen.findByText(/live session is browsing through this VPN/i);
    expect(quicChip().getAttribute('data-unmeasured')).toBe('never_tested');
    expect(quicChip().getAttribute('title') ?? '').not.toMatch(/no test Mac was free/i);
  });

  it('ARM 3 — CRITICAL VACUITY CONTROL: a row no server test has ever landed on keeps the "run Check VPN" wording — the fleet was never asked, so it cannot be blamed', () => {
    // This is the direction the real failure goes. A fix that made EVERY unmeasured row
    // say "no test Mac was free" would satisfy arm 1 and be a new false claim here.
    render(<ProxiesView />);
    return waitFor(() => {
      expect(quicChip().getAttribute('data-unmeasured')).toBe('never_tested');
      const title = quicChip().getAttribute('title') ?? '';
      expect(title).toMatch(/run Check VPN/i);
      expect(title).not.toMatch(/no test Mac was free/i);
    });
  });
});

// (o) O4 — the SAME grid, the OS cell beside that chip. These arms live here because
// this file already mounts the real ProxiesView with a VPN row and drives its Check
// button, which is the only way to observe the in-flight state of a grid row.
//
// ⛔ PRODUCTION LINE WHOSE REVERSION REDS ARM 5: the OS cell's
//    `isVpnScheme(p.scheme) ? VPN_TUNNEL_OS_FINGERPRINT : testing ?
//    OS_FINGERPRINT_MEASURING : undefined` in ProxiesView.tsx. Restore the bare
//    `testing ? OS_FINGERPRINT_MEASURING : undefined` and arm 5 reds: pressing Check
//    VPN puts "measuring…" on a row nothing is measuring, for the whole fleet wait.
//    Drop the `osFingerprint ??` that fronts it and ARM 12 of
//    an-absent-os-fingerprint-says-why-it-is-absent.test.tsx reds (a real reading
//    would be replaced by a cause).
describe('(o) O4/O3 — the grid never claims to be fingerprinting a tunnel', () => {
  function osChip(): Element {
    const el = document.querySelector('[data-component="proxy-os-fingerprint"]');
    if (el === null) throw new Error('the OS chip did not render');
    return el;
  }

  it('ARM 5 — CRITICAL: while "Check VPN" is in flight the OS chip says WHY a tunnel has no fingerprint, and never that one is being measured', async () => {
    // Nothing is measuring: `'host' in resolved` is false for every openvpn/wireguard
    // wire, so the control plane never consults the observer for this row — the reply
    // says `os_fingerprint_unavailable: 'vpn_tunnel'`. A chip saying "measuring…" for
    // the 30-45 s fleet wait is a false claim about work in progress, and it then
    // contradicts itself. Held OPEN here: the reply never resolves while we look.
    testAccountProxy.mockImplementation(
      () => new Promise<AccountProxiesModule.AccountProxyTestResult>(() => undefined),
    );
    render(<ProxiesView />);
    await check();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^checking/i })).toBeTruthy();
    });
    const title = osChip().getAttribute('title') ?? '';
    expect(title).not.toMatch(/measuring/i);
    expect(title).toMatch(/VPN tunnel/i);
    expect(title).toMatch(/No test can produce one here/i);
    // ⛔ and no dead-end instruction on a row whose button is not even called Test.
    expect(title).not.toMatch(/Run Test/i);
  });

  it('ARM 6 — a VPN row that has NEVER been checked already carries the cause — the chip was blank under a dead-end hint before any reply existed', () => {
    render(<ProxiesView />);
    return waitFor(() => {
      expect(osChip().getAttribute('title') ?? '').toMatch(/VPN tunnel/i);
      expect(osChip().getAttribute('title') ?? '').not.toMatch(/Run Test/i);
    });
  });

  it('ARM 7 — CRITICAL VACUITY CONTROL: a SOCKS5 row is untouched — no cause, and "measuring" is still what an in-flight Test says', async () => {
    // The direction the real failure goes: deriving the cause from the row instead of
    // from the reply is only safe while it is gated on the SCHEME. A fix that put the
    // tunnel sentence (or the never-measuring rule) on every row reds here.
    stored = [{ ...vpnRow(), id: 's1', scheme: 'socks5', port: 1080, openvpn: undefined }];
    testAccountProxy.mockImplementation(
      () => new Promise<AccountProxiesModule.AccountProxyTestResult>(() => undefined),
    );
    render(<ProxiesView />);
    await waitFor(() => {
      expect(osChip().getAttribute('title') ?? '').not.toMatch(/VPN tunnel/i);
    });
    expect(osChip().getAttribute('title') ?? '').toMatch(/not measured/i);
  });
});
