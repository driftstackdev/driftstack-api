// (V6 2026-09-16) ITEM 3 — a VPN row's UDP state, end to end through the client:
// the wire parse, the outcome, the cache, and the view the three surfaces read.
//
// ⛔ THE FACT THIS FILE EXISTS FOR. On the VPN path the fleet node writes
// `udp_associate: true` as a LITERAL about the tunnel's nature — nothing dialled,
// nothing that could ever come back false — and the control plane drops it
// (`capabilityReadingsForReply`, apps/server/src/routes/account-me.ts, pinned in
// apps/server/tests/integration/an-asserted-vpn-capability-is-never-a-measurement).
// So a VPN reply carries NO `udp_associate` today, and every surface must render
// that absence as "not measured", never as "no UDP".
//
// The node's contracted change makes the field three-state (true | false | null,
// with a `udp_detail` sentence). This file pins that the client ALREADY accepts
// it: a measured `false` survives the parse, the outcome, the cache and the
// derivation, and arrives at the surfaces as a NEGATIVE VERDICT that is
// distinguishable from the absence. No second client release is needed.
//
// ⛔ PRODUCTION LINES WHOSE REVERSION REDS AN ARM HERE:
//  • `...(typeof test.udp_associate === 'boolean' && !udpLegSkipped(test.udp_detail)
//     ? { udpProbe: test.udp_associate } : {})` in lib/proxy-server-test.ts
//     (`serverProbeOutcome`) — drop it and the measured verdict never leaves the
//     wire; drop only the `!udpLegSkipped` half and a skipped leg reads as a
//     measured false.
//  • the `udpProbe` clause in `saveServerProbeResult` (lib/proxy-probe-cache.ts)
//     — replace the carry branch with `: {}` and the ROLLOUT arm reds: a legacy
//     Mac's answer erases a migrated Mac's verdict.
//  • `if (c.udpProbe !== undefined) view.udpProbe[id] = c.udpProbe;` in
//     `deriveProbeViewWithEndpointRows` (lib/proxy-server-test.ts) — delete it
//     and a VPN row's verdict never reaches a surface at all, because a VPN
//     entry's placeholder `result` is never `isProxyUsable`.
//  • `udpProbe` in `serverMeasuredFields` (lib/proxy-probe-cache.ts) — delete the
//     name from that allowlist and the PRE-FLIGHT arm reds.
//  • `udpProbeAt: at` in `saveServerProbeResult` and the `isUdpVerdictFresh`
//     gates in BOTH derivations (lib/proxy-probe-cache.ts `deriveProbeViewState`,
//     lib/proxy-server-test.ts's endpoint overlay) — drop either gate and the
//     STALENESS arms below red: a measured negative, carried across every reply
//     that measured nothing, speaks in the present tense for ever beside a
//     "Tested just now" stamp that belongs to a different reply.
//  • the carry's `udpProbeAt: prior.udpProbeAt` — re-stamp it to `at` instead and
//     the CARRY-DOES-NOT-RESET-THE-CLOCK arm reds: a chain of legacy replies
//     would then refresh the verdict's date indefinitely, which is the same
//     unbounded claim with a TTL bolted on the front of it.

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

let nextResponse: () => Response = () => new Response('{}', { status: 500 });
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (): Promise<Response> => Promise.resolve(nextResponse()),
}));

import { testAccountProxy, type AccountProxyTestResult } from '../../src/lib/account-proxies';
import {
  deriveProbeViewState,
  loadProbeCache,
  saveEndpointResult,
} from '../../src/lib/proxy-probe-cache';
import {
  deriveProbeViewWithEndpointRows,
  persistServerProbe,
  serverProbeOutcome,
} from '../../src/lib/proxy-server-test';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const ID = 'p-ovpn';
/** ⛔ PIN UPDATED 2026-09-17, and it did its job on the way: it was thirty
 *  minutes, spelled out rather than imported precisely so that widening the shared
 *  constant would RED these arms instead of silently moving them — and it did.
 *
 *  `MEASURED_READING_TTL_MS` — the window for every reading the six-hourly
 *  automatic capability check re-takes, of which the UDP verdict is one. It is NOT
 *  `QUIC_VERDICT_TTL_MS` any more: that one bounds a LIVE-SESSION verdict fed by a
 *  300 s re-emit and is still thirty minutes. The UDP verdict inherited the number
 *  by imitation while being re-measured twelve times more slowly, so it spent ~92%
 *  of a healthy tunnel's life muted — the owner's complaint. Still spelled out,
 *  for the same reason as before. */
const UDP_VERDICT_TTL = 8 * 60 * 60 * 1000;
const ENDPOINT = { resolved: true, ip: '203.0.113.17', message: 'Resolved de-7 to 203.0.113.17' };

/** The reply a VPN check gets TODAY, field for field as the route builds it: the
 *  node asserted UDP and HTTP/2, the route dropped both, and the QUIC leg was
 *  declared skipped. The ONLY thing this reply says about UDP is nothing. */
const FLEET_VPN_TODAY = {
  ok: true,
  latency_ms: 61,
  measured_from: 'fleet',
  node_id: 'mac-mini-07',
  reachable: true,
  can_route: true,
  quic_detail: 'skipped: quic leg not probed on the vpn path',
  exit_ip: '198.51.100.7',
};

/** The MIGRATED node's reply: it ran the leg through the tunnel, it failed, and
 *  the sentence says so. The three-state contract, arriving. */
const FLEET_VPN_UDP_FALSE = {
  ...FLEET_VPN_TODAY,
  udp_associate: false,
  udp_detail: 'udp relay refused by the tunnel peer',
};

const FLEET_VPN_UDP_TRUE = {
  ...FLEET_VPN_TODAY,
  udp_associate: true,
  udp_detail: 'udp relayed through the tunnel',
};

async function wire(body: unknown): Promise<AccountProxyTestResult> {
  nextResponse = () => json(body);
  return testAccountProxy('http://x', 'ds_k', ID, { vantage: 'fleet' });
}

/** The full client path for one wire body: parse → outcome → cache → the derived
 *  view a surface renders. Returns the view's `udpProbe` entry for this row. */
async function throughTheClient(body: unknown, at = 5_000): Promise<boolean | undefined> {
  const outcome = serverProbeOutcome(await wire(body), at);
  await persistServerProbe(ID, outcome, { adoptExit: true });
  return deriveProbeViewWithEndpointRows(await loadProbeCache(), at).udpProbe[ID];
}

beforeEach(async () => {
  stores.clear();
  // Every VPN check runs the DNS pre-flight first; the cache entry a fleet reply
  // rides on is the one it writes.
  await saveEndpointResult(ID, ENDPOINT, 1_000);
});

describe('the wire parse admits a UDP reading and refuses a non-reading', () => {
  it("CRITICAL today's VPN reply carries no udp_associate, so nothing downstream holds one", async () => {
    const parsed = await wire(FLEET_VPN_TODAY);
    expect(parsed.ok).toBe(true);
    expect('udp_associate' in parsed, 'the route dropped the tunnel literal').toBe(false);
    const outcome = serverProbeOutcome(parsed, 5_000);
    expect(outcome.kind).toBe('ok');
    expect('udpProbe' in outcome, 'an absence must not become a boolean').toBe(false);
    expect(await throughTheClient(FLEET_VPN_TODAY)).toBeUndefined();
  });

  it('CRITICAL a MEASURED false survives the whole path as false — distinguishable from the absence', async () => {
    const parsed = await wire(FLEET_VPN_UDP_FALSE);
    expect(parsed.ok === true && parsed.udp_associate).toBe(false);
    expect(parsed.ok === true && parsed.udp_detail).toBe('udp relay refused by the tunnel peer');
    const outcome = serverProbeOutcome(parsed, 5_000);
    expect(outcome.kind === 'ok' && outcome.udpProbe).toBe(false);
    // ⛔ The discriminator the surfaces read: `false`, not `undefined`.
    expect(await throughTheClient(FLEET_VPN_UDP_FALSE)).toBe(false);
  });

  it('VACUITY CONTROL a MEASURED true arrives as true, so the arm above is not "false survives"', async () => {
    expect(await throughTheClient(FLEET_VPN_UDP_TRUE)).toBe(true);
  });

  it('a "skipped:" udp_detail is refused even beside a boolean — the belt for an older control plane', async () => {
    // An older control plane could still forward a node's `udp_associate:false`
    // beside its own "the leg never ran" sentence. A false that reaches a chip is
    // a negative verdict about a customer's tunnel that nobody measured.
    const skipped = {
      ...FLEET_VPN_TODAY,
      udp_associate: false,
      udp_detail: 'skipped: udp leg not probed on the vpn path',
    };
    const parsed = await wire(skipped);
    expect('udp_associate' in parsed, 'the parse refuses it').toBe(false);
    // …and the sentence still rides, because it is what says WHY there is none.
    expect(parsed.ok === true && parsed.udp_detail).toBe(
      'skipped: udp leg not probed on the vpn path',
    );
    expect(await throughTheClient(skipped)).toBeUndefined();
  });

  it('the SECOND belt, pinned on its own: serverProbeOutcome refuses the pair the parse would have dropped', () => {
    // ⛔ MEASURED 2026-09-16 — the arm above does NOT cover this. The rule lives in
    // two modules (lib/account-proxies parses the reply, lib/proxy-server-test
    // classifies it) and the parse runs FIRST, so a wire body can never present
    // the pair to `serverProbeOutcome`: deleting the `!udpLegSkipped(...)` half of
    // its guard left every arm above green. An unmeasured belt is not a belt.
    //
    // `serverProbeOutcome` is an exported pure function whose input type admits
    // the pair, so this is its own contract rather than an end-to-end state — the
    // parse is the first line and this is the second. Kept because the two modules
    // cannot share an export (account-proxies is hand-mocked with listed factories
    // by ten suites, where a new export is `undefined` at every call site).
    const outcome = serverProbeOutcome(
      {
        ok: true,
        latency_ms: 61,
        measured_from: 'fleet',
        node_id: 'mac-mini-07',
        udp_associate: false,
        udp_detail: 'skipped: udp leg not probed on the vpn path',
      },
      5_000,
    );
    expect(outcome.kind).toBe('ok');
    expect('udpProbe' in outcome, 'a skipped leg is not a measured false').toBe(false);
    // VACUITY CONTROL — the same call with a MEASURED sentence does produce one,
    // so this arm is not passing because the function ignores the field.
    expect(
      serverProbeOutcome(
        {
          ok: true,
          latency_ms: 61,
          measured_from: 'fleet',
          node_id: 'mac-mini-07',
          udp_associate: false,
          udp_detail: 'udp relay refused by the tunnel peer',
        },
        5_000,
      ),
    ).toMatchObject({ udpProbe: false });
  });

  it('a CONTROL-PLANE vantage never contributes a UDP reading — only a fleet Mac can measure a tunnel', async () => {
    // The fleet-only rule the vantage fields already obey. A control-plane reply
    // that carried the field would put a number from the wrong machine under a
    // chip whose whole meaning is "measured through your tunnel".
    const parsed = await wire({
      ok: true,
      latency_ms: 61,
      measured_from: 'control_plane',
      udp_associate: false,
      udp_detail: 'udp relay refused',
    });
    expect('udp_associate' in parsed).toBe(false);
  });
});

describe('the cache keeps a measurement and never lets a non-measurement retire one', () => {
  it('CRITICAL ROLLOUT a legacy Mac answering after a migrated one does NOT erase the verdict', async () => {
    // A fleet with one migrated Mac and one legacy Mac. Without the carry, every
    // re-check that happened to land on the legacy Mac would turn a measured
    // verdict back into "not measured" — the (V5) "a successful re-check turns
    // the green chip untested" defect, arriving through the new field.
    expect(await throughTheClient(FLEET_VPN_UDP_FALSE, 5_000)).toBe(false);
    expect(await throughTheClient(FLEET_VPN_TODAY, 6_000)).toBe(false);
    // …and a migrated Mac that measures the OPPOSITE does replace it. The carry
    // must not be "the first verdict wins for ever".
    expect(await throughTheClient(FLEET_VPN_UDP_TRUE, 7_000)).toBe(true);
  });

  it('CRITICAL the DNS pre-flight before the next check carries the verdict over', async () => {
    // The pre-flight runs before EVERY check. `serverMeasuredFields` is an
    // allowlist listed by name, so a field left out of it is gone by the time the
    // fleet answers — and the row would read "not measured yet" over a verdict it
    // still held a second earlier.
    expect(await throughTheClient(FLEET_VPN_UDP_FALSE, 5_000)).toBe(false);
    await saveEndpointResult(ID, ENDPOINT, 6_000);
    expect(deriveProbeViewWithEndpointRows(await loadProbeCache(), 6_000).udpProbe[ID]).toBe(false);
  });

  it('VACUITY CONTROL a pre-flight that resolves a DIFFERENT address drops it', async () => {
    // Nothing measured through the old address describes the new one — the same
    // rule every other server-measured field obeys, and the control that keeps
    // the carry above from being "it never drops".
    expect(await throughTheClient(FLEET_VPN_UDP_FALSE, 5_000)).toBe(false);
    await saveEndpointResult(ID, { ...ENDPOINT, ip: '203.0.113.99' }, 6_000);
    expect(
      deriveProbeViewWithEndpointRows(await loadProbeCache(), 6_000).udpProbe[ID],
    ).toBeUndefined();
  });

  it('CRITICAL a fleet FAILURE drops it — a tunnel that did not come up has no UDP verdict', async () => {
    expect(await throughTheClient(FLEET_VPN_UDP_TRUE, 5_000)).toBe(true);
    const failed = serverProbeOutcome(
      await wire({
        ok: false,
        reason: 'The proxy did not answer. Check the host and port, and that it is online.',
        measured_from: 'fleet',
      }),
      6_000,
    );
    expect(failed.kind).toBe('failed');
    await persistServerProbe(ID, failed, { adoptExit: true });
    expect(
      deriveProbeViewWithEndpointRows(await loadProbeCache(), 6_000).udpProbe[ID],
    ).toBeUndefined();
  });

  it('CRITICAL STALENESS a measured verdict stops being stated once it is older than its TTL', async () => {
    // ⛔ THE DEFECT THIS ARM EXISTS FOR. The carry above is right — a
    // non-measurement must not retire a measurement — and undated it also meant
    // NOTHING ever retired one. A migrated Mac measures "no UDP"; the provider
    // fixes UDP; every later Check lands on a legacy Mac, whose reply carries no
    // verdict and is carried over. The surfaces then read "⤵ UDP — No UDP through
    // this tunnel — measured from Driftstack's network" beside a "Tested just now"
    // stamp, indefinitely, about a measurement that is hours old and false. A
    // negative verdict about a customer's tunnel in the present tense is the
    // failure this item exists to prevent, arriving through the cache.
    expect(await throughTheClient(FLEET_VPN_UDP_FALSE, 5_000)).toBe(false);
    // A legacy Mac answers a minute later: the verdict stands, and is still the
    // freshest thing anyone measured.
    expect(await throughTheClient(FLEET_VPN_TODAY, 65_000)).toBe(false);
    // A window after the MEASUREMENT — not after the last reply — it stops
    // being stated. Absence is what every surface renders as "not measured yet".
    expect(
      deriveProbeViewWithEndpointRows(await loadProbeCache(), 5_000 + UDP_VERDICT_TTL).udpProbe[ID],
    ).toBeUndefined();
  });

  it('VACUITY CONTROL a verdict INSIDE the TTL is still stated, so the arm above is not "it always drops"', async () => {
    expect(await throughTheClient(FLEET_VPN_UDP_FALSE, 5_000)).toBe(false);
    expect(
      deriveProbeViewWithEndpointRows(await loadProbeCache(), 5_000 + UDP_VERDICT_TTL - 1_000)
        .udpProbe[ID],
    ).toBe(false);
  });

  it('CRITICAL a CARRY does not reset the clock — only a measurement does', async () => {
    // The TTL is worth nothing if a reply that measured nothing refreshes the
    // date: a row checked every few minutes by the sweeper would carry its first
    // verdict for the life of the install, exactly as before, with a freshness
    // test in front of it that never fires. The stamp belongs to the MEASUREMENT.
    expect(await throughTheClient(FLEET_VPN_UDP_FALSE, 5_000)).toBe(false);
    expect(await throughTheClient(FLEET_VPN_TODAY, 5_000 + UDP_VERDICT_TTL - 1_000)).toBe(false);
    expect(
      deriveProbeViewWithEndpointRows(await loadProbeCache(), 5_000 + UDP_VERDICT_TTL).udpProbe[ID],
    ).toBeUndefined();
    // …and a real re-measurement DOES restart it, which is the control that keeps
    // the rule from being "a verdict expires and can never be refreshed".
    expect(await throughTheClient(FLEET_VPN_UDP_FALSE, 5_000 + UDP_VERDICT_TTL)).toBe(false);
    expect(
      deriveProbeViewWithEndpointRows(await loadProbeCache(), 5_000 + UDP_VERDICT_TTL + 1_000)
        .udpProbe[ID],
    ).toBe(false);
  });

  it('CRITICAL a stored verdict with NO date is not stated at all — an undatable reading is not a current one', async () => {
    // The entry every install already holds: written before the stamp existed, or
    // by a writer that forgot it. Rendering it is a claim about when it was taken
    // that nobody can support, so it reads as "not measured" and self-heals on the
    // next check — the same rule `quicMeasuredAt` and the OS reading obey.
    await saveEndpointResult(ID, ENDPOINT, 1_000);
    const cache = await loadProbeCache();
    const entry = cache[ID];
    if (entry === undefined) throw new Error('the pre-flight wrote no entry');
    const undated = { ...cache, [ID]: { ...entry, udpProbe: false } };

    expect(deriveProbeViewWithEndpointRows(undated, 2_000).udpProbe[ID]).toBeUndefined();
    // VACUITY CONTROL — the SAME entry with a date is stated, so this arm is not
    // passing because the derivation ignores the field.
    expect(
      deriveProbeViewWithEndpointRows(
        { ...cache, [ID]: { ...entry, udpProbe: false, udpProbeAt: 1_500 } },
        2_000,
      ).udpProbe[ID],
    ).toBe(false);
  });

  it('CRITICAL the SOCKS5 half of the same rule: the BASE derivation ages it too', () => {
    // ⛔ TWO DERIVATIONS, TWO GATES, AND THE ARMS ABOVE EXERCISE ONLY ONE. A VPN
    // row's placeholder `result` is never `isProxyUsable`, so its verdict reaches
    // a surface exclusively through the endpoint overlay — which means a gate
    // removed from `deriveProbeViewState` leaves every arm above green while a
    // SOCKS5 row's UDP verdict goes back to being aged by nothing. The fleet
    // measures `udp_associate` on the SOCKS5 path on every test, so that row is
    // where stored verdicts actually accumulate.
    const usable = {
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 12,
      message: 'Working — CONNECT succeeded.',
    };
    const entry = { result: usable, at: 1_000, udpProbe: false, udpProbeAt: 1_000 };

    expect(deriveProbeViewState({ s1: entry }, 1_000 + UDP_VERDICT_TTL - 1).udpProbe['s1']).toBe(
      false,
    );
    expect(
      deriveProbeViewState({ s1: entry }, 1_000 + UDP_VERDICT_TTL).udpProbe['s1'],
      'a verdict past its TTL is not stated on a SOCKS5 row either',
    ).toBeUndefined();
    expect(
      deriveProbeViewState({ s1: { result: usable, at: 1_000, udpProbe: false } }, 1_100).udpProbe[
        's1'
      ],
      'and an undatable one is not stated at all',
    ).toBeUndefined();
  });

  it('a refusal that RAN NOTHING (not_run) leaves the verdict exactly where it was', async () => {
    // A live session holding the tunnel, or a busy Mac, is a wait — not a verdict
    // about UDP or anything else.
    expect(await throughTheClient(FLEET_VPN_UDP_FALSE, 5_000)).toBe(false);
    const refused = serverProbeOutcome(
      await wire({
        ok: false,
        reason: 'A live session is browsing through this VPN right now.',
        measured_from: 'control_plane',
        not_run: 'live_session',
      }),
      6_000,
    );
    expect(refused.kind).toBe('not_run');
    await persistServerProbe(ID, refused, { adoptExit: true });
    expect(deriveProbeViewWithEndpointRows(await loadProbeCache(), 6_000).udpProbe[ID]).toBe(false);
  });
});
