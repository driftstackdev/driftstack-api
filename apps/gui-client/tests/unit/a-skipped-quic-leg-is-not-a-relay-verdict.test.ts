// (V5 2026-09-12, owner: "openvpn (possibly wireguard too) not showing info
// measurements of proxy check like a socks5 does after adding … nothing of IP,
// quic, udp, nothing showing") — a SUCCESSFUL re-check must not delete the QUIC
// verdict the last one measured.
//
// MEASURED off the running artifact (http://127.0.0.1:5199, the real ProxiesView
// and the real ProfilesView grid inside the real AppWindow, real wire bodies
// driven through the real button), 2026-09-12, BEFORE the fix:
//
//   check #1  fleet ok, quic_ok:true              → row: `✓ QUIC`, card: `QUIC ✓`
//   check #2  fleet ok, quic_detail "skipped: …"  → row: `QUIC untested`
//             (TUNNEL UP · 61 ms FROM THE TEST MAC · 🇩🇪 198.51.100.7 Frankfurt)
//
// …whose hover read "Not measured yet — run Check VPN: the test Mac brings the
// tunnel up and probes QUIC through it" — the button that had just run — and
// whose `data-unmeasured` said `never_tested` about a row that WAS tested, one
// check earlier. On the profile card the chip vanished from the face entirely:
// the capability row became `— OS  +1`, so the face said nothing about QUIC at
// all, neither a value nor an absence. AFTER the fix both surfaces keep `✓ QUIC`
// (screenshots: scratchpad/v5c/{before,after}/profiles-list-ok-then-skipquic-dark.png,
// after/grid-ok-then-skipquic-dark.png).
//
// THE MECHANISM, three hops, all pinned below:
//   1. the node skipped the QUIC leg and says so in `quic_detail: "skipped: …"`
//      (the documented VPN path). The route then OMITS `quic_ok` beside that
//      detail (apps/server/src/routes/account-me.ts) and the parse refuses one
//      from an older node that still sends `quic_ok:false` beside it
//      (lib/account-proxies.ts) — correct, both of them: nothing was measured;
//   2. `serverProbeOutcome` therefore has no `quicProbe`… and, before the fix,
//      no way to say WHY. It now carries `quicLegSkipped: true`;
//   3. `saveServerProbeResult` replaces the relay verdict on every server
//      result (present → stored, absent → removed). That absent → removed rule
//      is right for a Mac that RAN the leg and reached no verdict, and wrong for
//      a leg that never ran — the same distinction the (q) control-plane keep
//      already makes for the same field. `quicSkipped` carries it.
//
// ⛔ PRODUCTION LINE WHOSE REVERSION REDS THE CRITICAL ARM: in
//    `saveServerProbeResult`, `(vantage?.measuredFrom === 'control_plane' ||
//    server.quicSkipped === true) && typeof prior.quicProbe === 'boolean'`.
//    Drop the `|| server.quicSkipped === true` half and "the skipped leg KEEPS
//    the relay verdict" reds (MUTATION RUN 2026-09-12: 1 failed, 7 passed —
//    `expected undefined to be true`).
// ⛔ Widen it the other way — keep the verdict whenever a fleet reply carries no
//    `quic_ok` — and the CONTROL arm reds: a Mac that ran the leg and produced
//    none must drop the old one, or a row wears last week's green chip for ever.
//    (MUTATION RUN 2026-09-12: 1 failed, 7 passed — `expected { …(15) } to not
//    have property "quicProbe"`, received `true`.)
//
// The "skipped:" prefix is read in TWO modules (lib/account-proxies parses the
// reply, lib/proxy-server-test classifies it) rather than one shared export,
// because account-proxies is hand-mocked with listed factories by ten suites
// where a new export is `undefined` at every call site. The two readings are
// bound HERE instead, by measurement: ONE wire body goes through both, and this
// file fails if either half stops recognising it.

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
import { loadProbeCache, saveEndpointResult } from '../../src/lib/proxy-probe-cache';
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
const ENDPOINT = { resolved: true, ip: '203.0.113.17', message: 'Resolved de-7 to 203.0.113.17' };
const EXIT = {
  ip: '198.51.100.7',
  country: 'DE',
  timezone: 'Europe/Berlin',
  region: 'Hesse',
  city: 'Frankfurt',
};

/** The fleet reply a successful VPN check gets, field for field as
 *  apps/server/src/routes/account-me.ts builds it (no `udp_associate`: a VPN
 *  row's is the tunnel's nature, not a probed SOCKS5 grant). */
const FLEET_OK = {
  ok: true,
  latency_ms: 61,
  reachable: true,
  auth_ok: true,
  can_route: true,
  h2_ok: true,
  quic_ok: true,
  quic_detail: 'h3 relayed',
  exit_ip: EXIT.ip,
  exit_observed: EXIT,
  node_id: 'mac-mini-01',
  measured_from: 'fleet',
};

/** The same successful bring-up with the QUIC leg SKIPPED: the route omits
 *  `quic_ok` beside a "skipped:" detail. Everything else is a measurement. */
const { quic_ok: _omitted, ...FLEET_SKIPPED_BASE } = FLEET_OK;
const FLEET_SKIPPED = { ...FLEET_SKIPPED_BASE, quic_detail: 'skipped: quic_leg_not_run' };

/** The CONTROL: the Mac RAN the leg and reached no verdict — no `quic_ok`, and
 *  no "skipped:" detail to explain the absence. */
const { quic_detail: _dropped, ...FLEET_NO_RELAY } = FLEET_SKIPPED;

const wire = async (body: unknown): Promise<AccountProxyTestResult> => {
  nextResponse = () => json(body);
  return testAccountProxy('https://api.example', 'ds_x', 'srv-ovpn', { vantage: 'fleet' });
};

/** Drive one check the way the views do: wire → outcome → the cache writers. */
const check = async (body: unknown, at: number): Promise<void> => {
  await persistServerProbe(ID, serverProbeOutcome(await wire(body), at), { adoptExit: true });
};

/** The row as it is checked for the FIRST time: the DNS pre-flight writes the
 *  endpoint entry, then a fleet Mac measures the tunnel and the QUIC leg. */
const firstGreenCheck = async (): Promise<void> => {
  await saveEndpointResult(ID, ENDPOINT, 1_000);
  await check(FLEET_OK, 2_000);
};

beforeEach(() => {
  stores.clear();
});

describe('the wire → the outcome: a skipped leg is reported AS skipped', () => {
  it('CRITICAL — one body, both readings: the parse drops quic_probe AND the outcome says the leg was skipped', async () => {
    const parsed = await wire(FLEET_SKIPPED);
    // account-proxies: a skipped leg is not a `false` verdict…
    expect(parsed.ok && 'quic_probe' in parsed).toBe(false);
    // …and proxy-server-test reads the same string to say WHY there is none.
    const outcome = serverProbeOutcome(parsed, 2_000);
    expect(outcome.kind === 'ok' && outcome.quicLegSkipped).toBe(true);
  });

  it('CONTROL — a MEASURED failure is a verdict, not a skip: quicProbe:false, no skipped flag', async () => {
    const outcome = serverProbeOutcome(
      await wire({ ...FLEET_OK, quic_ok: false, quic_detail: 'quic handshake timed out' }),
      2_000,
    );
    expect(outcome.kind === 'ok' && outcome.quicProbe).toBe(false);
    expect(outcome.kind === 'ok' && 'quicLegSkipped' in outcome).toBe(false);
  });

  it('VACUITY CONTROL — a reply that carries no QUIC leg at all sets neither field', async () => {
    const outcome = serverProbeOutcome(await wire(FLEET_NO_RELAY), 2_000);
    expect(outcome.kind === 'ok' && 'quicProbe' in outcome).toBe(false);
    expect(outcome.kind === 'ok' && 'quicLegSkipped' in outcome).toBe(false);
  });
});

describe('the cache: what a second, SUCCESSFUL check leaves on the row', () => {
  it('CRITICAL — a skipped leg KEEPS the relay verdict, and the row still surfaces it', async () => {
    await firstGreenCheck();
    expect((await loadProbeCache())[ID]?.quicProbe).toBe(true);
    await check(FLEET_SKIPPED, 3_000);
    const cache = await loadProbeCache();
    expect(cache[ID]?.quicProbe).toBe(true);
    // The chip reads the DERIVATION, not the entry: a VPN row's fleet fields
    // reach it only through the endpoint-row overlay.
    expect(deriveProbeViewWithEndpointRows(cache, 3_100).quicProbe[ID]).toBe(true);
  });

  it('CONTROL — a fleet answer that RAN the leg and produced none drops the prior verdict', async () => {
    await firstGreenCheck();
    await check(FLEET_NO_RELAY, 3_000);
    const cache = await loadProbeCache();
    expect(cache[ID]).not.toHaveProperty('quicProbe');
    expect(deriveProbeViewWithEndpointRows(cache, 3_100).quicProbe).not.toHaveProperty(ID);
  });

  it('CONTROL — a MEASURED `false` still overwrites a green verdict: the keep swallows no measurement', async () => {
    await firstGreenCheck();
    await check({ ...FLEET_OK, quic_ok: false, quic_detail: 'quic handshake timed out' }, 3_000);
    expect((await loadProbeCache())[ID]?.quicProbe).toBe(false);
  });

  it('VACUITY CONTROL — a skipped leg on a row that never had a verdict invents none', async () => {
    await saveEndpointResult(ID, ENDPOINT, 1_000);
    await check(FLEET_SKIPPED, 2_000);
    const cache = await loadProbeCache();
    expect(cache[ID]).not.toHaveProperty('quicProbe');
    expect(deriveProbeViewWithEndpointRows(cache, 2_100).quicProbe).not.toHaveProperty(ID);
  });

  it('the rest of the skipped-leg reply is applied in full — the keep is not a short circuit', async () => {
    await firstGreenCheck();
    await check({ ...FLEET_SKIPPED, latency_ms: 74, node_id: 'mac-mini-09' }, 3_000);
    const entry = (await loadProbeCache())[ID];
    expect(entry?.serverLatencyMs).toBe(74);
    expect(entry?.nodeId).toBe('mac-mini-09');
    expect(entry?.measuredFrom).toBe('fleet');
    expect(entry?.serverProbeAt).toBe(3_000);
    expect(entry?.exitIp).toBe(EXIT.ip);
    expect(entry?.exitCity).toBe('Frankfurt');
  });
});
