// (P2, owner 2026-09-12) — "PRoxy tests from proxies tab still show 'slow from
// this mac', but it should also test from the mac worker where it will run i
// guess (you choose and do as recommendeD)".
//
// MEASURED before the fix: the row already had both numbers as props — the
// native SOCKS5 handshake from this Mac (`result.latency_ms`) and the test
// Mac's (`serverLatencyMs`, which the client always asks for with
// `?vantage=fleet`). They were merged (`serverLatencyMs ?? result?.latency_ms`)
// into ONE number, and the health pill was handed the merged verdict with the
// words "from this Mac" hard-coded and a "Measured from your computer" hover.
// So a 180ms measured on the Mac that runs the profile read
// "slow from this Mac". One row, two provenance stories.
//
// The rule this file pins:
//   • both numbers are shown, each labelled with the machine that took it;
//   • the pill's words name the machine whose number it judged — and that is
//     the test Mac's whenever there is one, because only that number predicts
//     a session;
//   • when a side has no number, the row SAYS which side is missing instead of
//     leaving the other to be read as the whole answer — and says WHY, because
//     "has not measured this proxy yet" was printed over states where the test
//     Mac HAD measured it (it ran and failed; it ran and reported no timing);
//   • a fleet failure is never a green row: the pill, the red sentence, the
//     sort rank and the hero's "needs attention" all read it, because the
//     machine that runs the profile is the one that predicts the session;
//   • each side's meter is coloured by ITS OWN number, and each side's hover
//     carries ITS OWN measurement date;
//   • the missing-side labels are never the exact strings that mean "measured
//     there" ("from the test Mac" / "from this Mac").
//
// VACUITY CONTROLS: an untested row prints neither line and no marker at all
// (so the "missing side" arms are not passing on a label that is always
// there), and a server number with NO reported machine keeps the modest plain
// "server" chip (so the naming arms are not passing on a constant).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import type { AccountProxyTestResult } from '../../src/lib/account-proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { ProbeCacheMap } from '../../src/lib/proxy-probe-cache';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const listProxies = vi.fn<() => Promise<ProxyConfig[]>>();
const testAccountProxy =
  vi.fn<
    (
      baseUrl: string,
      apiKey: string,
      id: string,
      opts?: { vantage?: 'cp' | 'fleet' },
    ) => Promise<AccountProxyTestResult>
  >();

/** A fast, fully usable native probe: 42ms measured on THIS Mac. */
const NATIVE_42: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};

const savedProxy: ProxyConfig = {
  id: 'p1',
  label: 'london-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  // Stored on the account, so the row's Test also runs the server-side test
  // (no ensureAccountProxyRow leg to stub).
  serverId: 'aprx_1',
};

// Partial mocks: the pure predicates stay REAL so this suite cannot disagree
// with the app about what "usable" means; only the calls that leave the process
// are replaced.
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => listProxies(),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
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

// Mutable so one arm can sign the customer out: with no API key the fleet leg
// cannot run at all, which is the state the row must NOT label a second time.
// The deps of the view's refresh are the primitives, so a fresh object is safe.
// Only the LOAD is stubbed; the real derivation stays, because the arm below
// depends on how the real one treats an entry with no `endpoint` verdict. An
// empty fixture is also a cleaner baseline than whatever the store holds.
let cacheFixture: ProbeCacheMap = {};
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  loadProbeCache: () => Promise.resolve(cacheFixture),
}));

const settingsStub: { settings: { apiKey: string | null; baseUrl: string } } = {
  settings: { apiKey: 'ds_test', baseUrl: 'http://localhost:3000' },
};
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

async function testTheRow(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
}

function line(container: HTMLElement, vantage: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-latency-vantage="${vantage}"]`);
}

function missing(container: HTMLElement, side: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-latency-missing="${side}"]`);
}

/** The only inline style in a latency line is the meter's fill. */
function meterFill(el: HTMLElement | null): string {
  return el?.querySelector('[style]')?.getAttribute('style') ?? '';
}

describe('the Proxies row shows BOTH vantages, each named', () => {
  beforeEach(() => {
    listProxies.mockReset();
    listProxies.mockResolvedValue([savedProxy]);
    testProxy.mockReset();
    testProxy.mockResolvedValue(NATIVE_42);
    testAccountProxy.mockReset();
    settingsStub.settings = { apiKey: 'ds_test', baseUrl: 'http://localhost:3000' };
    cacheFixture = {};
  });

  it('CRITICAL both numbers survive — 31ms from the test Mac AND 42ms from this Mac, neither collapsed', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
    });
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('from the test Mac');

    const fleet = line(container, 'fleet');
    expect(fleet?.textContent).toContain('31ms');
    expect(fleet?.textContent).toContain('from the test Mac');
    expect(fleet?.getAttribute('title')).toContain('mac-mini-07');

    const local = line(container, 'this_mac');
    expect(local?.textContent).toContain('42ms');
    expect(local?.textContent).toContain('from this Mac');
    expect(local?.getAttribute('title')).toContain('Measured from your computer');

    // Two facts, two numbers: the merge that dropped one is the defect.
    expect(screen.getByText('31ms')).toBeTruthy();
    expect(screen.getByText('42ms')).toBeTruthy();

    // …and the fleet number's hover carries the FLEET measurement's date. The
    // "Tested" column dates the NATIVE verdict on a SOCKS5 row (lib's
    // serverProbeStamps keys endpoint rows only, by design) and a fleet number
    // outlives a native re-test, so one date beside two numbers dates at most
    // one of them. A locale stamp always carries a 4-digit year; the vantage
    // sentence it is appended to carries no digits at all.
    expect(fleet?.getAttribute('title')).toMatch(/Measured .*\d{4}/);
  });

  it('CRITICAL each side\u2019s meter is coloured by ITS OWN number \u2014 31ms green beside 180ms amber', async () => {
    // The single meter this replaced was coloured by the MERGED value, so
    // whichever number it sat beside it was sometimes describing the other one.
    // Fast where it runs, slow locally: the two meters must disagree.
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
    });
    testProxy.mockResolvedValue({ ...NATIVE_42, latency_ms: 180 });
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('from the test Mac');

    const fleetFill = meterFill(line(container, 'fleet'));
    const nativeFill = meterFill(line(container, 'this_mac'));
    expect(fleetFill).toContain('--status-ready-rgb');
    expect(nativeFill).toContain('--status-busy-rgb');
    expect(fleetFill).not.toBe(nativeFill);
  });

  it('CRITICAL the pill judges the test Mac’s number and SAYS so — a slow tunnel is never "slow from this Mac"', async () => {
    // The case the owner was looking at: fast here, slow where it runs.
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 180,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
    });
    render(<ProxiesView />);
    await testTheRow();

    const pill = await screen.findByText('slow from the test Mac');
    expect(pill.getAttribute('title')).toContain('Measured from the Mac that runs your profiles');
    // …and never the laptop's words over the test Mac's number.
    expect(screen.queryByText('slow from this Mac')).toBeNull();
    expect(screen.queryByText('healthy from this Mac')).toBeNull();
  });

  it('a control-plane fallback pill says "from the server", with why in the hover text', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 180,
      measured_from: 'control_plane',
    });
    render(<ProxiesView />);
    await testTheRow();

    const pill = await screen.findByText('slow from the server');
    expect(pill.getAttribute('title')).toContain('No test Mac was free');
    expect(screen.queryByText('slow from this Mac')).toBeNull();
  });

  it('VACUITY CONTROL — a server number with no reported machine keeps the plain "server" chip and claims no Mac', async () => {
    testAccountProxy.mockResolvedValue({ ok: true, latency_ms: 31 });
    render(<ProxiesView />);
    await testTheRow();

    expect(await screen.findByText('server')).toBeTruthy();
    expect(screen.queryByText('from the test Mac')).toBeNull();
    // The pill is modest in the same way: it borrows the server's own sentence.
    const pill = screen.getByText('healthy from the server');
    expect(pill.getAttribute('title')).toBe('Measured from Driftstack, not your computer.');
  });

  it('CRITICAL a fleet test that RAN AND FAILED is never a green row, and its reason is never thrown away', async () => {
    // ⛔ THE CASE THIS PRODUCT MEASURES FROM TWO PLACES TO CATCH: a proxy that
    // admits this laptop's IP and nobody else's is healthy here and dead on the
    // machine that will run the profile. This arm previously asserted the
    // DEFECT — `healthy from this Mac` plus a latency cell claiming the test
    // Mac "has not measured this proxy yet" — while the server's reason was
    // dropped on the floor by the `failed` branch and gated out of the render
    // by the scheme. All four halves are pinned here instead.
    const reason = 'The proxy did not answer. Check the host and port, and that it is online.';
    testAccountProxy.mockResolvedValue({ ok: false, reason, measured_from: 'fleet' });
    const { container } = render(<ProxiesView />);
    await testTheRow();

    // 1. the verdict names the machine that failed, not the one that passed
    const pill = await screen.findByText('fails on the test Mac');
    expect(pill.getAttribute('title')).toContain(reason);
    expect(screen.queryByText('healthy from this Mac')).toBeNull();
    // 2. the reason itself is on screen
    expect(screen.getByText(reason)).toBeTruthy();
    // 3. the missing side says WHY, and does not claim our instrument idle
    const gap = missing(container, 'server');
    expect(gap?.textContent).toContain('no answer');
    expect(gap?.textContent).toContain('test Mac');
    expect(gap?.getAttribute('title')).toContain(reason);
    expect(gap?.getAttribute('title')).not.toContain('has not measured this proxy yet');
    // 4. it counts as a problem, in the hero the page's safety argument rests on
    expect(screen.getByText('1 needs attention')).toBeTruthy();

    // The missing side must not wear the string that means "measured there",
    // and this Mac's own number is still shown, still labelled.
    expect(screen.queryByText('from the test Mac')).toBeNull();
    expect(line(container, 'fleet')).toBeNull();
    expect(line(container, 'this_mac')?.textContent).toContain('42ms');
  });

  it('CRITICAL a fleet ok with NO timing says "no number", not "has not measured" — it measured', async () => {
    // (i) I4's state on a SOCKS5 row: the Mac reached the proxy and reported no
    // latency. "Has not measured this proxy yet" is false about our own
    // instrument, and it was printed here.
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: null,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
    });
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('42ms');

    const gap = missing(container, 'server');
    expect(gap?.textContent).toContain('no number');
    expect(gap?.getAttribute('title')).toContain('reported no timing');
    expect(gap?.getAttribute('title')).not.toContain('has not measured this proxy yet');
  });

  it('no test Mac was FREE is a fact about the fleet, not about this proxy', async () => {
    testAccountProxy.mockResolvedValue({
      ok: false,
      not_run: 'no_node',
      reason: 'No fleet Mac was free to run this test.',
    });
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('42ms');

    const gap = missing(container, 'server');
    expect(gap?.textContent).toContain('none free');
    expect(gap?.getAttribute('title')).toContain('no test Mac was free');
    // Not a failure: the row is not accused of anything.
    expect(screen.queryByText('fails on the test Mac')).toBeNull();
  });

  it('and ONLY a side nothing ever measured says "not tested"', async () => {
    // The server did not answer at all (`unavailable`): nothing was learned, so
    // the one honest sentence is the one about never having measured.
    testAccountProxy.mockRejectedValue(new Error('offline'));
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('42ms');

    const gap = missing(container, 'server');
    expect(gap?.textContent).toContain('not tested');
    expect(gap?.getAttribute('title')).toContain('has not measured this proxy yet');
  });

  it('CRITICAL the label is dropped when the row already says why the fleet leg could not run', async () => {
    // Signed out: the fleet leg never runs, and the row's own notice already
    // says "Tested from this Mac only… from the test Mac too — that is where …
    // the fleet latency are measured". A second, permanent label on the widest
    // column of EVERY row is noise, and it names a number that customer cannot
    // obtain at all.
    settingsStub.settings = { apiKey: null, baseUrl: 'http://localhost:3000' };
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('42ms');

    expect(container.querySelector('[data-component="proxy-row-notice"]')?.textContent).toContain(
      'Tested from this Mac only',
    );
    expect(missing(container, 'server')).toBeNull();
    // …and this Mac's number is still labelled as this Mac's.
    expect(line(container, 'this_mac')?.textContent).toContain('from this Mac');
    expect(testAccountProxy).not.toHaveBeenCalled();
  });

  it('CRITICAL the Latency cell is never EMPTY — a row with no "this Mac" side still falls back', async () => {
    // ⛔ The hole: the outer gate asked `serverLatencyMs !== undefined ||
    // nativeNumber !== undefined` while BOTH inner lines were gated on
    // `hasNativeSide`. A row whose scheme is now http/VPN while the cache still
    // holds a SOCKS5-shaped verdict (an entry with no `endpoint`, i.e. written
    // before the scheme changed) therefore rendered a `<div>` with zero
    // children — no number, and not even the 'down' / em-dash fallback the
    // single-number cell always gave.
    listProxies.mockResolvedValue([{ ...savedProxy, scheme: 'http', port: 8080 }]);
    cacheFixture = { p1: { result: NATIVE_42, at: Date.UTC(2026, 8, 10) } };
    const { container } = render(<ProxiesView />);
    await screen.findByText('london-socks');

    // No side is claimed (an http row has no native handshake to name)…
    expect(container.querySelector('[data-latency-vantage]')).toBeNull();
    expect(container.querySelector('[data-latency-missing]')).toBeNull();
    // …and the cell still says something rather than nothing.
    expect(screen.getByText('down')).toBeTruthy();
  });

  it('VACUITY CONTROL — an untested row names no side at all (the missing-side label is not always printed)', async () => {
    render(<ProxiesView />);
    await screen.findByRole('button', { name: 'Test' });

    expect(document.querySelector('[data-latency-vantage]')).toBeNull();
    expect(document.querySelector('[data-latency-missing]')).toBeNull();
    expect(screen.queryByText(/no number from/)).toBeNull();
    // 'untested' is the word on the health pill AND on the capabilities chip
    // before a first probe; either is enough to say nothing has been measured.
    expect(screen.getAllByText('untested').length).toBeGreaterThan(0);
  });
});
