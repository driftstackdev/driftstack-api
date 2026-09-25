// 2026-09-17 — TEST ON ADD, COMPLETED. The owner: "Make sure after adding a
// proxy, it auto checks it too for everything."
//
// ⛔ WHAT WAS MEASURED BEFORE THE FIX. Adding a SOCKS5 proxy on the Proxies tab
// already did the whole thing: `handleSave` sets `testAfterSave`, `handleTest`
// runs the native handshake, stores the row on the account and runs Driftstack's
// own test through it. Adding a VPN row beside it did the DNS pre-flight and
// stopped — `handleCheckEndpoint` returned at `serverId === undefined` with
// "Launch a session through this VPN once to save it to your account". Nothing on
// the tab could store a VPN row, so the only way to save one was the launch, and
// a launch through a proxy nobody has checked is the thing that fails. The
// measurement that would explain the failure could never be taken.
//
// It stores the row and tests it now, on the same add, the way the profile card's
// Check VPN already did (`ensureServerProxy`, ProfilesView).
//
// THE FREE-TIER HALF. VPN egress is a paid-plan feature: the store is refused and
// the free-desktop route policy carries no `…/test` route at all. So on a Free
// account the address legs still run and NOTHING IS UPLOADED — asking would send
// the customer's OpenVPN configuration and WireGuard private key to the control
// plane to be told no — and the row says it is not included rather than untested.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import { planExcludesVpnEgress } from '../../src/lib/account-proxies';
import { TIER_FEATURES, type AccountTier } from '@driftstack/api-types';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';
import {
  NOT_ON_THIS_PLAN_LABEL,
  VPN_CHECK_IN_PROGRESS,
  VPN_PLAN_EXCLUDED_CHECK_NOTICE,
} from '../../src/lib/proxy-check-copy';

const { createProxy, testAccountProxy, updateProxy } = vi.hoisted(() => ({
  createProxy: vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(),
  updateProxy: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  testAccountProxy:
    vi.fn<(...args: unknown[]) => Promise<AccountProxiesModule.AccountProxyTestResult>>(),
}));

const resolveEndpoint =
  vi.fn<
    (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
  >();
const addProxy = vi.fn(() => Promise.resolve({}));

/** The registry the view RE-LISTS after a save. The add form submits the empty
 *  draft (host '', port 1080, username null — `validateDraft` is stubbed ok), and
 *  `handleSave` matches the created row on that tuple, so the row below is what
 *  the customer "just added": a VPN one. */
let stored: ProxyConfig[] = [];
const ADDED_VPN: ProxyConfig = {
  id: 'vpn-new',
  label: 'ResVPN',
  host: '',
  port: 1080,
  username: null,
  password: null,
  createdAt: '2026-09-17T00:00:00.000Z',
  scheme: 'openvpn',
  openvpn: { config_blob: 'client\nremote vpn.example.com 1194\n' },
};

const settingsStub: {
  settings: { apiKey: string | null; baseUrl: string };
  accountMe: { tier: string } | null;
} = {
  settings: { apiKey: 'ds_test_x', baseUrl: 'http://x' },
  accountMe: { tier: 'solo_manual' },
};

const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0,
  latency_ms: 30,
  message: 'ok',
};

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: (...args: unknown[]) => addProxy(...(args as [])),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  // The add FORM renders the host advice as the customer types; a hand-listed
  // factory makes a missing export throw on access, which takes the form down.
  hostWarningFor: () => undefined,
  testProxy: vi.fn(() => Promise.resolve(OK)),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: (host: string, port: number) => resolveEndpoint(host, port),
  // The account's id is written back to the local row after a create; a
  // hand-listed factory makes a missing export throw on ACCESS, and that throw
  // lands in the store's own catch and reads as a refusal by the account.
  setProxyServerId: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  createProxy: (...args: unknown[]) => createProxy(...args),
  updateProxy: (...args: unknown[]) => updateProxy(...args),
  testAccountProxy: (...args: unknown[]) => testAccountProxy(...args),
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
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

/** Submit the add form. The empty draft is what lands (`validateDraft` is stubbed
 *  ok), and the row the re-list returns is what the check is run against — the
 *  rule pinned by a-proxy-is-tested-against-the-registry-not-the-draft. */
async function addAProxy(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'New proxy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add proxy' }));
}

const planNotice = (): Element | null =>
  document.querySelector(`span[title="${VPN_PLAN_EXCLUDED_CHECK_NOTICE}"]`);

beforeEach(() => {
  createProxy.mockReset();
  createProxy.mockResolvedValue({ id: 'aprx_new' });
  updateProxy.mockReset();
  updateProxy.mockResolvedValue({});
  testAccountProxy.mockReset();
  testAccountProxy.mockResolvedValue({
    ok: true,
    latency_ms: 61,
    measured_from: 'fleet',
    node_id: 'mac-mini-07',
    quic_probe: true,
    quic_detail: 'h3 relayed',
  } as unknown as AccountProxiesModule.AccountProxyTestResult);
  resolveEndpoint.mockReset();
  resolveEndpoint.mockResolvedValue({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
  addProxy.mockClear();
  stored = [];
  settingsStub.settings.apiKey = 'ds_test_x';
  settingsStub.accountMe = { tier: 'solo_manual' };
});

describe('adding a VPN row on the Proxies tab runs the WHOLE check', () => {
  it('CRITICAL the row is saved to the account and TESTED through Driftstack, on the add — not left with "launch a session once". MUTATION: put the `serverId === undefined` early return back in handleCheckEndpoint and both calls stop', async () => {
    render(<ProxiesView />);
    await screen.findByRole('button', { name: 'New proxy' });
    stored = [ADDED_VPN];
    await addAProxy();

    // The address leg, then the store, then the tunnel test — in that order,
    // against the id the store returned.
    await waitFor(() => expect(resolveEndpoint).toHaveBeenCalled());
    await waitFor(() => expect(createProxy).toHaveBeenCalled());
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalled());
    expect(testAccountProxy.mock.calls[0]?.[2]).toBe('aprx_new');
    // ⛔ And the FLEET vantage, not the control plane's: only a Mac that brings
    // the tunnel up can measure anything through it.
    expect(testAccountProxy.mock.calls[0]?.[3]).toMatchObject({ vantage: 'fleet' });
  });

  it('CRITICAL the wait is VISIBLE and says how long — the check resolves an address, stores the row and waits for a tunnel, which is a minute-and-a-half shape; a bare "Checking…" over that gap reads as a hang and gets the button pressed again', async () => {
    let releaseTest!: (v: AccountProxiesModule.AccountProxyTestResult) => void;
    testAccountProxy.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseTest = res;
        }),
    );
    render(<ProxiesView />);
    await screen.findByRole('button', { name: 'New proxy' });
    stored = [ADDED_VPN];
    await addAProxy();

    const progress = await screen.findByText(VPN_CHECK_IN_PROGRESS);
    expect(progress.getAttribute('role')).toBe('status');
    expect(VPN_CHECK_IN_PROGRESS).toMatch(/90 s/);
    // ⛔ It says WHAT and HOW LONG and nothing about how we run it.
    expect(VPN_CHECK_IN_PROGRESS).not.toMatch(/fleet|node|test Mac|control plane/i);

    releaseTest({
      ok: true,
      latency_ms: 61,
      measured_from: 'fleet',
    } as unknown as AccountProxiesModule.AccountProxyTestResult);
    await waitFor(() => expect(screen.queryByText(VPN_CHECK_IN_PROGRESS)).toBeNull());
  });

  it('CRITICAL ⛔ A FREE ACCOUNT UPLOADS NOTHING. VPN egress is a paid feature, so the store is refused and there is no test route to reach — asking anyway would send the customer’s VPN configuration and private key to be told no. The address leg still runs; the row says it is not included. MUTATION: drop the `planExcludesVpn` gate in handleCheckEndpoint and `createProxy` is called', async () => {
    settingsStub.accountMe = { tier: 'free' };
    render(<ProxiesView />);
    await screen.findByRole('button', { name: 'New proxy' });
    stored = [ADDED_VPN];
    await addAProxy();

    await waitFor(() => expect(planNotice()).not.toBeNull());
    expect(createProxy, 'no credential left this Mac').not.toHaveBeenCalled();
    expect(updateProxy, 'nor by the re-push path').not.toHaveBeenCalled();
    expect(testAccountProxy).not.toHaveBeenCalled();
    // The address leg DID run: what the plan excludes is the part Driftstack runs.
    expect(resolveEndpoint).toHaveBeenCalled();
    expect(screen.getByText('address ok')).toBeInTheDocument();
  });

  it('CRITICAL on a Free account the server-only chip says "not included on this plan", never "untested" — "untested" means a check has not happened YET, so the customer presses a button that cannot work, reads "not measured yet", and concludes the app is broken', async () => {
    settingsStub.accountMe = { tier: 'free' };
    stored = [ADDED_VPN];
    render(<ProxiesView />);
    await screen.findByText('ResVPN');

    const quic = await waitFor(() => {
      const el = document.querySelector('[data-component="vpn-quic-chip"]');
      expect(el).not.toBeNull();
      return el as Element;
    });
    expect(quic.getAttribute('data-unmeasured')).toBe('plan_excluded');
    expect(quic.textContent).toBe(`QUIC — ${NOT_ON_THIS_PLAN_LABEL}`);
    expect(quic.textContent).not.toMatch(/untested/i);
    expect(quic.getAttribute('title')).toMatch(/paid plans/i);
    // ⛔ The UDP chip beside it tells the same story IN ITS LABEL, not only in a
    // hover. Two chips on one row describe ONE refusal, and a bare "⇢ UDP" beside
    // "QUIC — not included on this plan" reads as "not measured yet", which sends
    // the customer to press a button their plan cannot run.
    const udp = document.querySelector('[data-component="vpn-udp-chip"]');
    expect(udp?.getAttribute('title')).toMatch(/paid plans/i);
    expect(udp?.getAttribute('data-unmeasured')).toBe('plan_excluded');
    expect(udp?.textContent).toBe(`UDP — ${NOT_ON_THIS_PLAN_LABEL}`);
  });

  it("CRITICAL ⛔ THE PLAN QUESTION IS ASKED OF THE FEATURE TABLE, NOT OF THE TIER’S NAME. It shipped as `tier === 'free'` — a hand-typed copy of a matrix the repo already publishes and the SERVER enforces from (`requireTierFeature(tier, 'vpnEgress')`). `free` is merely the only tier whose `vpnEgress` is false today, and guessing fails in the expensive direction: a future tier without VPN egress would upload the customer’s private key to be refused on arrival. MUTATION: `planExcludesVpnEgress` back to `tier === 'free'` and the first loop reds", () => {
    for (const [tier, features] of Object.entries(TIER_FEATURES))
      expect(
        planExcludesVpnEgress({ tier: tier as AccountTier }),
        `${tier}: the client must answer whatever the table says`,
      ).toBe(features.vpnEgress === false);
    // ⛔ AN UNKNOWN OR ABSENT TIER IS NOT EXCLUDED. `null` is "still loading, or no
    // API key" and an unrecognised string is a NEWER server; refusing on either
    // would quietly stop checking VPN rows for a paying customer during every /me
    // round trip, and the server’s own refusal is the honest backstop.
    expect(planExcludesVpnEgress(null)).toBe(false);
    expect(planExcludesVpnEgress({})).toBe(false);
    expect(planExcludesVpnEgress({ tier: null })).toBe(false);
    expect(planExcludesVpnEgress({ tier: 'a_tier_from_a_newer_server' as AccountTier })).toBe(
      false,
    );
    // VACUITY CONTROL — the loop above is not "every tier answers false".
    expect(TIER_FEATURES.free.vpnEgress).toBe(false);
    expect(planExcludesVpnEgress({ tier: 'free' })).toBe(true);

    // ⛔⛔ AND THE SOURCE PIN, because BEHAVIOUR ALONE CANNOT CATCH THIS ONE.
    // `tier === 'free'` and "read `vpnEgress` out of the table" agree on every
    // tier that exists TODAY — measured: swapping the implementation back leaves
    // the loop above green — so a behavioural arm would report a passing grade for
    // the exact defect this item exists to remove. They diverge only on a tier the
    // table does not yet hold, which is precisely the day it matters and the day
    // nobody is looking. So the instrument is the one that can discriminate: the
    // function must CONSULT the table, and must not decide on a tier's name.
    // (2026-09-24) The helper moved to lib/plan-features.ts so a view can ask it
    // while rendering; account-proxies re-exports it. The pin follows the body.
    const src = readFileSync(resolve(__dirname, '../../src/lib/plan-features.ts'), 'utf8');
    expect(src.indexOf('export function planExcludesVpnEgress')).toBeGreaterThan(-1);
    const body = src.slice(src.indexOf('export function planExcludesVpnEgress'));
    const fn = body.slice(0, body.indexOf('\n}') + 2);
    expect(fn, 'the plan question is asked of TIER_FEATURES').toContain('TIER_FEATURES');
    expect(fn, '…and answered by the vpnEgress feature').toContain('vpnEgress');
    expect(fn, 'never by a hand-typed tier name').not.toMatch(/'free'|"free"/);
  });

  it('VACUITY CONTROL — a PAID account’s chip is unchanged: the plan wording appears only where the plan really excludes the check', async () => {
    stored = [ADDED_VPN];
    render(<ProxiesView />);
    await screen.findByText('ResVPN');
    const quic = await waitFor(() => {
      const el = document.querySelector('[data-component="vpn-quic-chip"]');
      expect(el).not.toBeNull();
      return el as Element;
    });
    expect(quic.getAttribute('data-unmeasured')).toBe('never_tested');
    expect(quic.textContent).toBe('QUIC untested');
  });

  it('⛔ CONTROL — an account that has NOT ANSWERED yet is not treated as Free: a refusal on a null /me would silently stop checking VPN rows for a paying customer during every round trip', async () => {
    settingsStub.accountMe = null;
    render(<ProxiesView />);
    await screen.findByRole('button', { name: 'New proxy' });
    stored = [ADDED_VPN];
    await addAProxy();
    await waitFor(() => expect(createProxy).toHaveBeenCalled());
    expect(planNotice()).toBeNull();
  });
});
