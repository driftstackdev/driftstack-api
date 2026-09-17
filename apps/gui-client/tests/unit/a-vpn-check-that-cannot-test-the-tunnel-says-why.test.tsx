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
  VPN_NO_EXIT_YET_SHORT,
  VPN_NO_EXIT_YET_TITLE,
  VPN_NOT_STORED_CHECK_NOTICE,
  VPN_NOT_STORED_TALLY_REASON,
  VPN_STORE_FAILED_TALLY_REASON,
} from '../../src/lib/proxy-check-copy';

const resolveEndpoint =
  vi.fn<
    (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
  >();
const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const { createAccountProxy } = vi.hoisted(() => ({
  /** ⛔ 2026-09-17 — the tab's check now STORES an unsaved VPN row before testing
   *  it, so the create is part of this file's subject and must be deterministic:
   *  left to the real module it would attempt a fetch from jsdom and the arms
   *  below would pass or fail on a network error's shape. */
  createAccountProxy: vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(),
}));
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
  // ⛔ 2026-09-17 — the tab's check STORES an unsaved VPN row now, and the store
  // writes the account's id back to the local row. A hand-listed factory makes a
  // missing export THROW on access, and that throw landed in the store's own
  // catch and read as "Couldn't save this VPN" — a bookkeeping failure reported
  // as a refusal by the account.
  setProxyServerId: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  // The export is `createProxy`; proxy-server-test imports it aliased.
  createProxy: (...args: unknown[]) => createAccountProxy(...args),
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
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
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

/** The store-refusal notice's own element, read by its opening clause so it is
 *  never confused with the two gate notices `notice()` reads. */
const storeRefusalNotice = (): string | null =>
  document.querySelector('span[title^="Address found. Couldn\'t save this VPN"]')?.textContent ??
  null;

const notice = (): string | null =>
  // The muted notice slot: the (d)/(h) not_run sentence's own element, keyed by
  // its title so the tally clause (which repeats the phrase) is not matched.
  document.querySelector(`span[title="${VPN_NOT_STORED_CHECK_NOTICE}"]`)?.textContent ??
  document.querySelector(`span[title="${VPN_NO_API_KEY_CHECK_NOTICE}"]`)?.textContent ??
  null;

beforeEach(() => {
  createAccountProxy.mockReset();
  createAccountProxy.mockRejectedValue(
    Object.assign(new Error('refused'), { status: 403, detail: 'vpn egress is not enabled' }),
  );
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
  // ⛔ PIN REPLACED 2026-09-17 — the arm this replaces asserted the CLOSED LOOP,
  // not a behaviour worth keeping. It pinned that an unsaved VPN row's check
  // "says so, with the next step, and the fleet is never asked", where the next
  // step was "launch a session through this VPN once". Nothing on this tab could
  // store a VPN row, so the only way to save one was the launch — and the launch
  // through an unchecked proxy is the thing that fails. The measurement that
  // would have explained the failure could never be taken.
  //
  // The tab's check stores the row itself now, exactly as the profile card's
  // already did. What the arms below keep is the half that was right: a check
  // that CANNOT proceed says why, in the row's own notice, beside the pre-flight
  // verdict rather than instead of it.
  it('CRITICAL an unsaved VPN row is STORED and then tested — the add-time check no longer sends the customer to launch a session through a proxy nobody has checked. MUTATION: put the `serverId === undefined` early return back in handleCheckEndpoint and this reds', async () => {
    createAccountProxy.mockResolvedValue({ id: 'aprx_new' });
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 42,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
    } as unknown as AccountProxiesModule.AccountProxyTestResult);
    stored = [vpnRow({ serverId: undefined })];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$/i }));
    await waitFor(() => expect(createAccountProxy).toHaveBeenCalled());
    // …and the tunnel IS tested, against the id the store just returned.
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalled());
    expect(testAccountProxy.mock.calls[0]?.[2]).toBe('aprx_new');
    expect(notice(), 'nothing left to explain: the check ran').toBeNull();
  });

  it('CRITICAL the store being REFUSED is the answer, and it names the refusal rather than a step the customer cannot take — the fleet is never asked', async () => {
    stored = [vpnRow({ serverId: undefined })];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$/i }));
    await waitFor(() => expect(storeRefusalNotice()).not.toBeNull());
    expect(storeRefusalNotice()).toContain('Address found.');
    expect(testAccountProxy).not.toHaveBeenCalled();
    // The pre-flight's own verdict still shows — the notice is beside it, not instead.
    expect(screen.getByText('address ok')).toBeInTheDocument();
  });

  it('⛔ the sentence that DID reach the customer is honest about what it means now — a row not saved to the account is not told to launch a session through it', () => {
    expect(VPN_NOT_STORED_CHECK_NOTICE).toBe(
      'Address found. This VPN is not saved to your account, so it was not tested. Run Check VPN again.',
    );
    expect(VPN_NOT_STORED_CHECK_NOTICE).not.toMatch(/launch a session/i);
    expect(VPN_NOT_STORED_TALLY_REASON).not.toMatch(/launch a session/i);
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

  it('the Test-all tally for a row the account REFUSED names the refusal, in the same clause slot the not-saved reason used', async () => {
    stored = [vpnRow({ serverId: undefined })];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    expect(
      await screen.findByText(
        `1 VPN tunnel not tested (${VPN_STORE_FAILED_TALLY_REASON}) — nothing was tested`,
      ),
    ).toBeInTheDocument();
  });

  it('CRITICAL no API key: the row says so with the ONE Settings next step, and the fleet is never asked', async () => {
    settingsStub.settings.apiKey = null;
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$/i }));
    await waitFor(() => expect(notice()).toBe(VPN_NO_API_KEY_CHECK_NOTICE));
    expect(VPN_NO_API_KEY_CHECK_NOTICE).toBe(
      'Address found. Connect your API key in Settings to test it.',
    );
    expect(testAccountProxy).not.toHaveBeenCalled();
  });

  it('the notice belongs to THAT check: it stays through the wait, and is GONE once the next check lands another answer', async () => {
    // ⛔ PIN UPDATED 2026-09-17 — the REASON moved, the rule did not. An unsaved
    // row is stored now, so the reason a check leaves a notice here is the
    // account REFUSING the store; the notice's lifetime is what this arm is about.
    stored = [vpnRow({ serverId: undefined })];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$/i }));
    await waitFor(() => expect(storeRefusalNotice()).not.toBeNull());
    // Re-check with the resolver held open. The notice is dropped when the
    // check LANDS (`settle()`), not when it starts — (h): clearing at the
    // start left a bare row for the whole fleet wait — so it is STILL there
    // while this check is in flight. Asserted, not narrated.
    let release!: (v: { resolved: boolean; ip: string; message: string }) => void;
    resolveEndpoint.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^re-check$/i }));
    await waitFor(() => expect(screen.getByText('Checking…')).toBeInTheDocument());
    expect(storeRefusalNotice()).not.toBeNull();
    // (m) M1 — the ABSENCE this arm never asserted: land an answer that is not
    // that reason (the endpoint no longer resolves) and the previous notice is
    // GONE — nothing replaces it, and the row wears THIS check's own verdict.
    // With the same answer landing twice, "cleared and re-derived" and "sticky"
    // read identically; a different answer is what tells them apart.
    // MUTATION: drop `settle()` from handleCheckEndpoint's unresolved branch →
    // the not-stored sentence stays beside "address not found" → red.
    release({ resolved: false, ip: '', message: 'DNS lookup failed' });
    await waitFor(() => expect(screen.queryByText('Checking…')).toBeNull());
    expect(screen.getByText('address not found')).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(storeRefusalNotice()).toBeNull();
    expect(screen.queryByText(VPN_NOT_STORED_CHECK_NOTICE)).toBeNull();
    expect(screen.queryByText(VPN_NO_API_KEY_CHECK_NOTICE)).toBeNull();
    // A third check that resolves again brings the same reason back (nothing
    // about the row changed): re-derived per check — never sticky, never
    // dropped for good. The fleet was never asked at any point.
    fireEvent.click(screen.getByRole('button', { name: /^(re-check|check vpn)$/i }));
    await waitFor(() => expect(storeRefusalNotice()).not.toBeNull());
    expect(screen.queryByText('address not found')).toBeNull();
    expect(testAccountProxy).not.toHaveBeenCalled();
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
  // Phase B (2026-09-11): the card's exit line is ONE fixed 18px row, so it
  // shows the SHORT clause ('no exit measured yet') and carries the grid's
  // full sentence as its title — the same constant family, never a retype.
  it('CRITICAL says why there is no exit and names Check VPN — the same words as the grid (short clause on the line, full sentence in its title)', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: true })} />);
    const line = screen.getByText(VPN_NO_EXIT_YET_SHORT);
    expect(line.getAttribute('title')).toBe(VPN_NO_EXIT_YET_TITLE);
    expect(VPN_NO_EXIT_YET.startsWith(`${VPN_NO_EXIT_YET_SHORT} — run `)).toBe(true);
    expect(screen.queryByText('no exit IP')).toBeNull();
    cleanup();
  });

  it('CRITICAL labels the empty latency "not measured", never "stale" — nothing was ever measured', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: true })} />);
    expect(screen.getByText('not measured')).toBeTruthy();
    expect(screen.queryByText('stale')).toBeNull();
    cleanup();
  });

  it('CONTROL — a probed SOCKS5 card with no exit keeps "no exit IP" (the VPN clause is gated on `vpn`); its pill is "not measured" too — "stale" is gone from the card (G9)', () => {
    // Phase B deleted 'stale': a number that was never taken did not age. The
    // discriminator this arm exists for — the VPN clause never leaks onto a
    // SOCKS5 card — is unchanged.
    render(<ProfilePhoneCard {...cardProps({ vpn: false })} />);
    expect(screen.getByText('no exit IP')).toBeTruthy();
    expect(screen.getByText('not measured')).toBeTruthy();
    expect(screen.queryByText('stale')).toBeNull();
    expect(screen.queryByText(VPN_NO_EXIT_YET)).toBeNull();
    expect(screen.queryByText(VPN_NO_EXIT_YET_SHORT)).toBeNull();
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
