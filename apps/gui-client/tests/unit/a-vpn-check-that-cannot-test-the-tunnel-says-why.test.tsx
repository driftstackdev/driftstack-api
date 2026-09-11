// (l) SOCKS5/chat audit — findings #1, #2, #3, #9, #10 (L1–L3).
//
// #1  A single-row Check on a VPN row the test Mac cannot be asked about (not
//     stored on the account / no API key) used to `settle()` and return: the
//     reason reached ONLY the Test-all tally, and the row went back to
//     "endpoint ok" + "run Check for the exit" with nothing saying why the
//     tunnel was not tested — the customer was sent round the same loop.
// #2  An HTTP row wore the VPN button copy ("…brings the tunnel up and measures
//     its exit") and the VPN exit prompt, promising a test the code never runs
//     for an http scheme (handleCheckEndpoint returns after the DNS pre-flight).
// #3  The profile card said "no exit IP" (a dead end) for a checked-but-no-exit
//     VPN state, and labelled the latency "stale" beside "checked just now"
//     although no latency was ever measured.
// #9  Three next steps for one missing credential ("sign in", "from the
//     dashboard", "in Settings"); Settings is the only one the GUI can name.
// #10 One action, four names across two surfaces.
//
// Every string is read from lib/proxy-check-copy in the app; the arms below pin
// the TEXT (a copy change must red here, not only rewire) and the placement.

import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';
import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import {
  CHECK_ENDPOINT_TITLE,
  CHECK_VPN_TITLE,
  DESKTOP_CREDENTIAL_NEXT_STEP,
  MISSING_API_KEY_NEXT_STEP,
  VPN_NO_API_KEY_CHECK_NOTICE,
  VPN_NO_EXIT_YET,
  VPN_NOT_STORED_CHECK_NOTICE,
  VPN_NOT_STORED_TALLY_REASON,
} from '../../src/lib/proxy-check-copy';

const resolveEndpoint =
  vi.fn<
    (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
  >();
const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
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
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: (host: string, port: number) => resolveEndpoint(host, port),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => testAccountProxy(baseUrl, apiKey, id, opts),
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
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => settingsStub,
}));

const { ProxiesView } = await import('../../src/views/ProxiesView');

function vpnRow(over: Partial<ProxyConfig> = {}): ProxyConfig {
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
    ...over,
  };
}
function httpRow(): ProxyConfig {
  return {
    id: 'h1',
    label: 'Corp HTTP',
    host: 'proxy.example.com',
    port: 8080,
    username: null,
    password: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme: 'http',
    serverId: 'aprx_http',
  };
}

const notice = (): string | null =>
  // The muted notice slot: the (d)/(h) not_run sentence's own element, keyed by
  // its title so the tally clause (which repeats the phrase) is not matched.
  document.querySelector(`span[title="${VPN_NOT_STORED_CHECK_NOTICE}"]`)?.textContent ??
  document.querySelector(`span[title="${VPN_NO_API_KEY_CHECK_NOTICE}"]`)?.textContent ??
  null;

beforeEach(() => {
  resolveEndpoint.mockReset();
  resolveEndpoint.mockResolvedValue({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
  testProxy.mockReset();
  testAccountProxy.mockReset();
  settingsStub.settings.apiKey = 'ds_test_x';
  stored = [vpnRow()];
});

describe('#1 — a single-row Check that cannot test the tunnel leaves a notice saying why', () => {
  // MUTATION: drop either setVpnNotices call in handleCheckEndpoint's not-stored /
  // no-key branch → the row returns to "endpoint ok" with no notice → red.
  it('CRITICAL not stored on the account: the row says so, with the next step, and the fleet is never asked', async () => {
    stored = [vpnRow({ serverId: undefined })];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$/i }));
    await waitFor(() => expect(notice()).toBe(VPN_NOT_STORED_CHECK_NOTICE));
    // The next step is a control the GUI HAS: nothing on the Proxies tab
    // stores a proxy on the account — the first launch through it does — so
    // "Store this proxy on your account" named a step with no button.
    expect(VPN_NOT_STORED_CHECK_NOTICE).toBe(
      'Endpoint resolves. Launch a session through this proxy once to store it on your account; then Check VPN can test the tunnel.',
    );
    expect(VPN_NOT_STORED_CHECK_NOTICE).not.toMatch(/^Endpoint resolves\. Store /);
    expect(testAccountProxy).not.toHaveBeenCalled();
    // The pre-flight's own verdict still shows — the notice is beside it, not instead.
    expect(screen.getByText('endpoint ok')).toBeInTheDocument();
  });

  // MUTATION: swap the two gates back (not-stored before no-key) → the row
  // tells a keyless customer to store the proxy, which a launch without a key
  // never does → red.
  it('CRITICAL no API key AND not stored: the KEY is the blocker named (a launch stores nothing without one)', async () => {
    settingsStub.settings.apiKey = null;
    stored = [vpnRow({ serverId: undefined })];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$/i }));
    await waitFor(() => expect(notice()).toBe(VPN_NO_API_KEY_CHECK_NOTICE));
    expect(document.querySelector(`span[title="${VPN_NOT_STORED_CHECK_NOTICE}"]`)).toBeNull();
    expect(testAccountProxy).not.toHaveBeenCalled();
  });

  it('the Test-all tally for an unstored row names the same launch-once next step', async () => {
    stored = [vpnRow({ serverId: undefined })];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    expect(
      await screen.findByText(
        `1 VPN tunnel not tested (${VPN_NOT_STORED_TALLY_REASON}) — nothing was tested`,
      ),
    ).toBeInTheDocument();
    expect(VPN_NOT_STORED_TALLY_REASON).toMatch(/launch a session/i);
  });

  it('CRITICAL no API key: the row says so with the ONE Settings next step, and the fleet is never asked', async () => {
    settingsStub.settings.apiKey = null;
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$/i }));
    await waitFor(() => expect(notice()).toBe(VPN_NO_API_KEY_CHECK_NOTICE));
    expect(VPN_NO_API_KEY_CHECK_NOTICE).toBe(
      'Endpoint resolves. Connect your API key in Settings to test it.',
    );
    expect(testAccountProxy).not.toHaveBeenCalled();
  });

  it('the notice belongs to THAT check: the next Check clears it before it answers', async () => {
    stored = [vpnRow({ serverId: undefined })];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$/i }));
    await waitFor(() => expect(notice()).toBe(VPN_NOT_STORED_CHECK_NOTICE));
    // Re-check with the resolver held open: the previous notice must be gone
    // while this check is in flight (it was the previous check's answer).
    let release!: (v: { resolved: boolean; ip: string; message: string }) => void;
    resolveEndpoint.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^re-check$/i }));
    await waitFor(() => expect(screen.getByText('Checking…')).toBeInTheDocument());
    // The notice is dropped when the check LANDS (`settle()`), so it is still
    // there during the wait — (h): clearing at the start left a bare row for
    // the whole fleet wait. Release, and the same reason comes back (nothing
    // changed), which proves the notice is re-derived per check, not sticky.
    release({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
    await waitFor(() => expect(screen.queryByText('Checking…')).toBeNull());
    expect(notice()).toBe(VPN_NOT_STORED_CHECK_NOTICE);
  });

  it('VACUITY CONTROL — a stored row with a key reaches the fleet and gets NO not-tested notice', async () => {
    testAccountProxy.mockResolvedValue({
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
    });
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$/i }));
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    await screen.findByText('203.0.113.9');
    expect(notice()).toBeNull();
  });
});

describe('#2 / #10 — the row is named for what its check DOES', () => {
  it('CRITICAL an HTTP row offers "Check endpoint" (DNS only), says so in its title, and shows no exit prompt', async () => {
    stored = [httpRow()];
    render(<ProxiesView />);
    const btn = await screen.findByRole('button', { name: /^check endpoint$/i });
    expect(btn.getAttribute('title')).toBe(CHECK_ENDPOINT_TITLE);
    expect(CHECK_ENDPOINT_TITLE).not.toMatch(/tunnel up|measures its exit|VPN/);
    expect(screen.getByText('verified at launch')).toBeInTheDocument();
    expect(screen.queryByText(VPN_NO_EXIT_YET)).toBeNull();
    expect(screen.queryByText(/run Check/)).toBeNull();
    expect(screen.queryByRole('button', { name: /check vpn/i })).toBeNull();
    // And the check itself is the pre-flight alone.
    fireEvent.click(btn);
    await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith('proxy.example.com', 8080));
    expect(testAccountProxy).not.toHaveBeenCalled();
    expect(testProxy).not.toHaveBeenCalled();
  });

  it('CRITICAL a VPN row offers "Check VPN" — the card menu\'s name — and its exit cell names that check', async () => {
    render(<ProxiesView />);
    const btn = await screen.findByRole('button', { name: /^check vpn$/i });
    expect(btn.getAttribute('title')).toBe(CHECK_VPN_TITLE);
    expect(CHECK_VPN_TITLE.startsWith('Check VPN — ')).toBe(true);
    expect(screen.getByText(VPN_NO_EXIT_YET)).toBeInTheDocument();
    expect(VPN_NO_EXIT_YET).toBe('no exit measured yet — run Check VPN');
    expect(screen.queryByText('run Check for the exit')).toBeNull();
    expect(screen.queryByRole('button', { name: /check endpoint/i })).toBeNull();
  });
});

describe('#3 — the profile card for a checked-but-no-exit VPN row', () => {
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
      checkedAtIso: new Date().toISOString(),
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
      ...over,
    };
  }

  // MUTATION: restore `p.probed ? 'no exit IP' : …` → the VPN arm reads the
  // dead end again → red.
  it('CRITICAL says why there is no exit and names Check VPN — the same words as the grid', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: true })} />);
    expect(screen.getByText(VPN_NO_EXIT_YET)).toBeTruthy();
    expect(screen.queryByText('no exit IP')).toBeNull();
    cleanup();
  });

  it('CRITICAL labels the empty latency "not measured", never "stale" — nothing was ever measured', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: true })} />);
    expect(screen.getByText('not measured')).toBeTruthy();
    expect(screen.queryByText('stale')).toBeNull();
    cleanup();
  });

  it('CONTROL — a probed SOCKS5 card with no exit keeps "no exit IP" and "stale" (a number that aged)', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: false })} />);
    expect(screen.getByText('no exit IP')).toBeTruthy();
    expect(screen.getByText('stale')).toBeTruthy();
    expect(screen.queryByText(VPN_NO_EXIT_YET)).toBeNull();
    cleanup();
  });

  it('the card menu names the action "Check VPN" with the grid\'s own title', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: true })} />);
    expect(screen.getByLabelText(CHECK_VPN_TITLE)).toBeTruthy();
    cleanup();
  });
});

describe('#9 — one next step for a missing API key', () => {
  it('every proxy-check sentence for a missing key carries the Settings next step', async () => {
    expect(MISSING_API_KEY_NEXT_STEP).toBe('Connect your API key in Settings to test it');
    expect(VPN_NO_API_KEY_CHECK_NOTICE).toContain(MISSING_API_KEY_NEXT_STEP);
    expect(DESKTOP_CREDENTIAL_NEXT_STEP).toContain(MISSING_API_KEY_NEXT_STEP);
    const real = await vi.importActual<typeof AccountProxiesModule>(
      '../../src/lib/account-proxies',
    );
    expect(real.DESKTOP_CREDENTIAL_FLEET_TEST_REASON).toContain(MISSING_API_KEY_NEXT_STEP);
    for (const s of [
      VPN_NO_API_KEY_CHECK_NOTICE,
      DESKTOP_CREDENTIAL_NEXT_STEP,
      real.DESKTOP_CREDENTIAL_FLEET_TEST_REASON,
    ]) {
      expect(s).not.toMatch(/dashboard|sign in/i);
    }
  });

  it('the Test-all tally for a keyless row uses the same sentence', async () => {
    settingsStub.settings.apiKey = null;
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    expect(
      await screen.findByText(
        `1 VPN tunnel not tested (${MISSING_API_KEY_NEXT_STEP}) — nothing was tested`,
      ),
    ).toBeInTheDocument();
  });
});
