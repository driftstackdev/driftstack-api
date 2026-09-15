// (V-219) A card's "Tested" time and the date of the EXIT ADDRESS beside it are
// two different facts, and the card had only one of them on screen.
//
// ⛔ HOW THEY COME APART. The exit probe and the capability probe are separate
// calls, and the cache keeps them apart for good reasons:
//   * `saveProbeResult` deliberately PRESERVES the exit across a capability
//     re-test — losing the customer's location every time we check reachability
//     would be worse than keeping it;
//   * the background sweeper (proxy-probe-sweeper) re-probes CAPABILITY ONLY,
//     five rows every fifteen minutes, and never touches the exit.
// So the tested stamp moves on its own. A row can read "Tested just now" over an
// address measured hours or days earlier, and on a rotating residential exit that
// is a different machine in a different city.
//
// ⛔⛔ AND THE CODE ALREADY AGREES IT IS TOO OLD. `isExitIdentityFresh` — 30
// minutes, the same window as the QUIC verdict and the OS reading — gates the
// LAUNCH path in ProfilesView: past it we re-probe rather than route through the
// remembered address. We declined to TRUST a reading we went on SHOWING as
// current. That asymmetry, not a customer report, is what makes this a defect.
//
// The fix is to say WHEN, not to hide the address: the owner asked for location
// to be shown ("i dont see OS currently at profile grid either… better to show
// everything"), and an address that carries its own date beats a blank row. The
// compact tile has no room, so the DETAILS SHEET — the surface a customer opens
// to get the whole story — carries it, with no threshold: a window here would
// hide the answer on the one screen opened to get it.
//
// ⛔ The third state is the one worth the file. An entry written before `exitAt`
// existed cannot be dated, and a surface that stays SILENT about that is read as
// saying the address is current — so an undatable exit says so out loud.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import {
  deriveProbeViewState,
  loadProbeCache,
  saveEndpointResult,
  saveExitResult,
  saveProbeResult,
  saveServerProbeResult,
} from '../../src/lib/proxy-probe-cache';
import { deriveProbeViewWithEndpointRows } from '../../src/lib/proxy-server-test';

const NAME = 'zurich banking';
const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function props(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
  return {
    name: NAME,
    monogram: 'ZB',
    hue: 190,
    deviceLabel: 'iPhone 17',
    running: false,
    selected: false,
    lastUsedIso: null,
    folder: '',
    tags: [],
    hasProxy: true,
    proxyExplicit: true,
    proxyName: 'Residential CH #3',
    proxyAddress: 'gate.example.com:1080',
    flag: '🇨🇭',
    countryCode: 'CH',
    exitIp: '185.22.1.9',
    locationLabel: 'Zürich, Zurich',
    latencyMs: 42,
    latencyFillPct: 30,
    latencyGood: true,
    probed: true,
    capabilities: {
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 42,
      message: 'ok',
    },
    // The row was checked for reachability ONE MINUTE ago — the stamp the card
    // shows, and the one a reader takes for the whole row's date.
    checkedAtIso: new Date(NOW - 60_000).toISOString(),
    busy: false,
    launching: false,
    anyBusy: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    nowMs: NOW,
    onToggleSelect: vi.fn(),
    onPrimary: vi.fn(),
    onWatch: vi.fn(),
    onTest: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
}

const openSheet = (over: Partial<ProfilePhoneCardProps> = {}): HTMLElement => {
  const { container } = render(<ProfilePhoneCard {...props(over)} />);
  fireEvent.click(screen.getByLabelText(`Details for ${NAME}`));
  const sheet = container.querySelector<HTMLElement>('[data-component="card-details-sheet"]');
  if (sheet === null) throw new Error('the details sheet did not open');
  return sheet;
};

const seenAt = (sheet: HTMLElement): HTMLElement | null =>
  sheet.querySelector<HTMLElement>('[data-component="exit-seen-at"]');

describe('the exit address carries its own date, which the tested stamp is not', () => {
  it('CRITICAL an exit measured hours before the last reachability check says so — the two stamps are a day apart and only one of them was on screen', () => {
    const sheet = openSheet({ exitSeenAtMs: NOW - 3 * DAY });
    const el = seenAt(sheet);
    expect(el, 'the sheet carries the exit date').not.toBeNull();
    expect(el?.getAttribute('data-exit-age')).toBe('dated');
    expect(el?.textContent ?? '').toMatch(/^seen \d+ d ago$/);
    // And it names the confusion rather than leaving the reader to infer it.
    expect(el?.getAttribute('title') ?? '').toMatch(/Tested time above/i);
    expect(el?.getAttribute('title') ?? '').toMatch(/without re-reading the exit/i);
    // VACUITY — the row's own "Tested" stamp really is recent, so the arm is
    // about the two dates DISAGREEING and not about an old card.
    const checked = within(sheet).getByText(new Date(NOW - 60_000).toLocaleString(), {
      exact: false,
    });
    expect(checked).toBeTruthy();
  });

  it('CRITICAL an UNDATABLE exit says so out loud — silence here reads as "current", and an entry written before the stamp existed has no date to give', () => {
    const el = seenAt(openSheet({ exitSeenAtMs: undefined }));
    expect(el?.getAttribute('data-exit-age')).toBe('undated');
    expect(el?.textContent ?? '').toMatch(/unknown time/i);
    // It must not imply a Test would be pointless — the next one IS datable.
    expect(el?.getAttribute('title') ?? '').toMatch(/Press Test/i);
  });

  it('a FRESH exit is still dated — the sheet is the "tell me everything" surface, so it answers the question it was opened for rather than hiding the answer behind a window', () => {
    const el = seenAt(openSheet({ exitSeenAtMs: NOW - 120_000 }));
    expect(el?.getAttribute('data-exit-age')).toBe('dated');
    expect(el?.textContent ?? '').toMatch(/^seen 2 min ago$/);
  });

  it('VACUITY CONTROL — a row with NO exit has no exit date. The line is about an address that exists; minting one beside "no exit IP" would be inventing a measurement.', () => {
    const el = seenAt(
      openSheet({ exitIp: null, countryCode: null, locationLabel: null, exitSeenAtMs: NOW }),
    );
    expect(el).toBeNull();
  });

  it('VACUITY CONTROL — the compact TILE says nothing about the date at either width. It has eight fixed rows and the address is what the owner asked to see there; the date belongs where there is room for it.', () => {
    const { container } = render(<ProfilePhoneCard {...props({ exitSeenAtMs: NOW - 3 * DAY })} />);
    expect(container.querySelector('[data-component="exit-seen-at"]')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/seen \d+ d ago/);
  });
});

// ⛔ The card can only say WHEN if the derivation hands it the stamp, and the
// stamp has to survive BOTH derivations — the base one and the overlay that
// re-adds for a VPN row what the base drops. A rule added to one of those and
// not the other is true of SOCKS5 rows and false of VPN rows with nothing
// saying so, which is exactly how the OS reading's TTL shipped half-done on the
// same day. These arms are the reason the card's arms are not decoration.
const OK = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};
/** `saveExitResult(proxyId, exitIp, exitCountry, geo, at)` — positional, and the
 *  stamp is the LAST argument. Called through this helper so an arm cannot pass
 *  the date into the geo slot and quietly measure nothing. */
const saveExit = (id: string, at: number): Promise<unknown> =>
  saveExitResult(id, '185.22.1.9', 'CH', { city: 'Zürich', region: 'Zurich' }, at);

// ⛔ THE SAME BORROWED FRESHNESS, on the number the card PREFERS. A native
// capability re-test CARRIES the fleet latency forward — deliberately, because a
// reachability check measured no fleet latency and erasing one would be worse —
// and re-stamps the Checked date beside it. The background sweeper runs native
// probes every fifteen minutes. So a row shows a fleet number measured hours ago
// under a date refreshed minutes ago, and only one of those two facts was on
// screen.
//
// `serverProbeAt` has dated it all along, and `serverProbeStamps` already
// surfaces that date — but only for ENDPOINT rows, which is exactly why the
// SOCKS5 case went unnoticed: the code looked like it handled this.
describe('the fleet latency states its own date when it differs from the check', () => {
  const server = (over: Partial<ProfilePhoneCardProps> = {}): HTMLElement =>
    openSheet({ latencyFromServer: true, ...over });
  const measuredAt = (sheet: HTMLElement): HTMLElement | null =>
    sheet.querySelector<HTMLElement>('[data-component="server-measured-at"]');

  it('CRITICAL a fleet number measured before the last check says when — the two dates are hours apart and the card showed only the newer one', () => {
    const el = measuredAt(server({ serverMeasuredAtMs: NOW - 3 * HOUR }));
    expect(el, 'the sheet carries the fleet measurement date').not.toBeNull();
    expect(el?.textContent ?? '').toMatch(/^server latency measured \d+ h ago$/);
    expect(el?.getAttribute('title') ?? '').toMatch(/keeps that number/i);
  });

  it('CRITICAL VACUITY CONTROL — EQUAL DATES SAY NOTHING. One check produced both, so repeating the date would be noise on every freshly-tested row, and a rule that printed it there would look identical on the arm above.', () => {
    const at = Date.parse(props().checkedAtIso as string);
    expect(measuredAt(server({ serverMeasuredAtMs: at }))).toBeNull();
  });

  it("VACUITY CONTROL — a card whose latency is NOT the fleet's says nothing. The line explains a number that is not on this card otherwise, and printing it beside a native latency would date the wrong measurement.", () => {
    const el = measuredAt(
      openSheet({ latencyFromServer: false, serverMeasuredAtMs: NOW - 3 * HOUR }),
    );
    expect(el).toBeNull();
  });

  it('VACUITY CONTROL — an undatable fleet number says nothing rather than guessing. Unlike the exit, this one has no "unknown time" state: the number is advisory and a line admitting we cannot date it would cost more attention than it is worth.', () => {
    expect(measuredAt(server({ serverMeasuredAtMs: undefined }))).toBeNull();
  });
});

describe('the derivation carries the exit date to both proxy surfaces', () => {
  beforeEach(() => {
    stores.clear();
  });

  it('CRITICAL the base derivation keys the exit stamp beside the address — without it every card falls back to "unknown time" and the fix is cosmetic', async () => {
    await saveProbeResult('p1', OK, 1_000);
    await saveExit('p1', 2_000);
    const view = deriveProbeViewState(await loadProbeCache(), 3_000);
    expect(view.exitResults.p1, 'the address itself still renders').not.toBeNull();
    expect(view.exitSeenAt.p1, 'and it is dated').toBe(2_000);
  });

  it('CRITICAL a VPN row gets it too — the overlay runs AFTER the base drops every server field for an endpoint row, so an address it re-adds without its stamp is one the sheet can only call current', async () => {
    await saveEndpointResult('vpn1', { resolved: true, ip: '203.0.113.17', message: 'ok' }, 1_000);
    await saveExit('vpn1', 2_000);
    const cache = await loadProbeCache();
    // The base derivation surfaces NOTHING for this row by design — without this
    // control the arm below could pass on a row that renders no exit at all.
    expect(deriveProbeViewState(cache, 3_000).exitSeenAt.vpn1).toBeUndefined();
    const overlaid = deriveProbeViewWithEndpointRows(cache, 3_000);
    expect(overlaid.exitResults.vpn1, 'the overlay surfaces the address').not.toBeNull();
    expect(overlaid.exitSeenAt.vpn1, 'and its date with it').toBe(2_000);
  });

  it("CRITICAL the fleet latency's date is keyed by BOTH derivations — the base one for a SOCKS5 row and the overlay for a VPN row, or the rule is true of one kind of row and silently false of the other", async () => {
    await saveProbeResult('s1', OK, 1_000);
    await saveServerProbeResult('s1', { latencyMs: 61, measuredFrom: 'fleet' }, 2_000);
    expect(deriveProbeViewState(await loadProbeCache(), 3_000).serverMeasuredAt.s1).toBe(2_000);

    await saveEndpointResult('vpn2', { resolved: true, ip: '203.0.113.17', message: 'ok' }, 1_000);
    await saveServerProbeResult('vpn2', { latencyMs: 61, measuredFrom: 'fleet' }, 2_000);
    const cache = await loadProbeCache();
    // The base derivation surfaces nothing for a VPN row — without this control
    // the overlay arm could pass on a row that renders no latency at all.
    expect(deriveProbeViewState(cache, 3_000).serverMeasuredAt.vpn2).toBeUndefined();
    const overlaid = deriveProbeViewWithEndpointRows(cache, 3_000);
    expect(overlaid.serverLatency.vpn2, 'the overlay surfaces the number').toBe(61);
    expect(overlaid.serverMeasuredAt.vpn2, 'and its date with it').toBe(2_000);
  });

  it('VACUITY CONTROL — a row with an exit but no usable verdict surfaces neither the address nor a date. A stamp keyed beside a dropped address would date a measurement the surface is not showing.', async () => {
    await saveProbeResult('p2', OK, 1_000);
    await saveExit('p2', 2_000);
    await saveProbeResult(
      'p2',
      { ...OK, reachable: false, can_route: false, message: 'down' },
      3_000,
    );
    const view = deriveProbeViewState(await loadProbeCache(), 4_000);
    expect(view.exitResults.p2).toBeUndefined();
    expect(view.exitSeenAt.p2).toBeUndefined();
  });
});
