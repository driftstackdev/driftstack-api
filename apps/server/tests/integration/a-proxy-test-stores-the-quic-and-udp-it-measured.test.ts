// A proxy Test's QUIC and UDP readings are STORED ON THE ROW (migration 0124).
//
// Before this, a fleet-vantage `POST /v1/account/me/proxies/:id/test` measured
// whether QUIC relays through the proxy and whether it carries UDP, answered the
// caller, and left the row untouched. The reading lived only in the local cache of
// whichever desktop pressed Test, and — the part that matters — "measured: no" was
// indistinguishable from "never measured". Nothing can safely fill in MISSING
// readings on its own while that is true: it would re-probe a proxy that genuinely
// does not relay QUIC on every pass, forever.
//
// So the properties this file holds are about the THREE states staying three:
//
//   P1  a measured TRUE is stored as true, with the time it was measured;
//   P2  a measured FALSE is stored as FALSE — not null, not absent. This is the
//       arm the whole change exists for;
//   P3  a leg that was NOT measured (skipped, `null`, a VPN row's asserted
//       literal, a verdict on a proxy that does not work, a frame that reached no
//       verdict) writes NOTHING — it neither invents a false nor erases a reading
//       an earlier Test stored;
//   P4  a reading does not outlive the address or the credential it was taken
//       through, and is not written onto a row that moved while the test ran;
//   P5  the list, the single-row reply and the test reply all carry the four
//       fields, null when never measured;
//   P6  storing is best-effort: a persistence failure changes nothing about the
//       Test's own answer;
//   P7  a reading is dated when it was MEASURED, not when it was written — the OS
//       observation sits between the two on a SOCKS5 row, and it takes seconds;
//   P8  a reply carries the readings of the row AS IT STANDS, so it always agrees
//       with the list. The row this handler read BEFORE the test is stale in
//       exactly these columns once a PUT lands mid-test, so whenever the test
//       stored nothing — write declined, no leg measured, proxy not usable, a
//       control-plane test — the reply RE-READS the row. A repointed row answers
//       null; a row whose password was merely resubmitted answers the reading it
//       kept. The old copy is served only when the row cannot be read at all.
//
// The identity fence itself — that it lives IN the write, and what Postgres does
// with it under a concurrent edit — is pinned against a real database in
// `a-probe-reading-is-only-written-onto-the-identity-it-was-measured-through`.
//
// VACUITY CONTROLS. Every "writes nothing" arm is paired with an arm in which the
// same route, the same node and the same row DO write — otherwise a route that
// never persisted anything would pass all of P3. And P1/P2 use opposite
// polarities on the two legs so a writer that stored one constant for both, or
// crossed the legs, cannot pass either.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import type { AccountProxyRow } from '../../src/db/account-proxies-repo.js';
import { storedProbeReadings } from '../../src/routes/account-me.js';
import { probeCapabilityUpdates } from '../../src/services/proxy-reading-persist.js';

let fx: TestAppFixture;
afterEach(async () => {
  vi.restoreAllMocks();
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

/** The control-plane probe stub: the fleet arms never reach it, the cp arm does. */
const cpProbeStub = (): never =>
  ({
    probe: () => Promise.resolve({ ok: true }),
    observeOs: () => Promise.resolve({ observed: false, reason: 'no SYN recorded' }),
  }) as unknown as never;

const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

/** An earlier Test's readings, dated well before any `new Date()` in this file. */
const EARLIER = new Date('2026-09-01T08:00:00.000Z');

/**
 * A node that answers a probeEgress with a frame whose legs the caller chooses.
 * The base is a healthy proxy — a verdict, reachable, authenticated, routing, with
 * an exit — so an arm differs from its twin ONLY in the fields under test.
 * `beforeReply` runs between the dispatch and the answer: it is the window in
 * which a customer's PUT can land while the node is still measuring.
 */
function registerNode(
  nodeId: string,
  legs: Record<string, unknown>,
  beforeReply: () => Promise<void> = () => Promise.resolve(),
): void {
  const conn: FleetControlConnection = fx.fleetControlRegistry.register(nodeId, (data) => {
    const f = JSON.parse(data) as { type: string; requestId: string };
    if (f.type !== 'probeEgress') return;
    void beforeReply().then(() => {
      conn.handleInbound(
        JSON.stringify({
          type: 'probeEgressResult',
          requestId: f.requestId,
          node_id: nodeId,
          ok: true,
          reachable: true,
          auth_ok: true,
          can_route: true,
          latency_ms: 42,
          h2_ok: true,
          exit_ip: '198.51.100.44',
          quic_detail: null,
          error: null,
          ...legs,
        }),
      );
    });
  });
}

async function makeSocks5Proxy(
  host: string,
  credentials: { username?: string; password?: string } = {},
): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload: { label: 'p', host, port: 1080, ...credentials },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

async function makeWireGuardProxy(): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload: {
      label: 'wg',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      wireguard: {
        private_key: WG_PRIV,
        peer_public_key: WG_PUB,
        endpoint: 'vpn.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
      },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

async function runTest(id: string, vantage: 'fleet' | 'cp'): Promise<Record<string, unknown>> {
  const res = await fx.app.inject({
    method: 'POST',
    url: `/v1/account/me/proxies/${id}/test?vantage=${vantage}`,
    headers: auth(fx),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Record<string, unknown>>();
}

async function storedRow(id: string): Promise<AccountProxyRow> {
  const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
  if (row === null) throw new Error('the proxy row vanished');
  return row;
}

async function listedProxy(id: string): Promise<Record<string, unknown>> {
  const res = await fx.app.inject({
    method: 'GET',
    url: '/v1/account/me/proxies',
    headers: auth(fx),
  });
  expect(res.statusCode, res.body).toBe(200);
  const found = res.json<{ data: Array<Record<string, unknown>> }>().data.find((p) => p.id === id);
  if (found === undefined) throw new Error('the proxy is not on the list');
  return found;
}

/** Put an earlier Test's readings on the row, exactly as the route would have. */
const seedEarlierReadings = (id: string, quic: boolean, udp: boolean) =>
  fx.accountProxiesRepo.update({
    id,
    accountId: fx.accountId,
    updates: { quicProbe: quic, quicProbeAt: EARLIER, udpProbe: udp, udpProbeAt: EARLIER },
  });

const putProxy = (id: string, payload: Record<string, unknown>) =>
  fx.app.inject({
    method: 'PUT',
    url: `/v1/account/me/proxies/${id}`,
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload,
  });

describe('a fleet-vantage Test stores the QUIC and UDP legs it MEASURED', () => {
  it('P1+P2 CRITICAL a measured TRUE is stored as true and a measured FALSE is stored as FALSE — never null — each with the time it was measured, and the list serves both. Opposite polarities on the two legs, so a writer that crossed them or stored one constant fails. MUTATION: make `probeCapabilityUpdates` skip a `false` leg (`=== true` instead of `!== undefined`) and the udp assertions red.', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerNode('mac-0124-001', {
      quic_ok: true,
      quic_detail: null,
      udp_associate: false,
      udp_detail: 'the proxy refused the udp relay request',
    });
    const id = await makeSocks5Proxy('socks-0124-001.example.com');
    // Never measured: null on the row and on the list, before any Test.
    expect((await storedRow(id)).quicProbe).toBeNull();
    expect((await storedRow(id)).udpProbe).toBeNull();
    const before = await listedProxy(id);
    expect(before.quic_probe).toBeNull();
    expect(before.quic_probe_at).toBeNull();
    expect(before.udp_probe).toBeNull();
    expect(before.udp_probe_at).toBeNull();

    const startedAt = Date.now();
    const body = await runTest(id, 'fleet');
    const finishedAt = Date.now();
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.measured_from).toBe('fleet');
    // The reply's own legs — what the customer was just shown…
    expect(body.quic_ok).toBe(true);
    expect(body.udp_associate).toBe(false);

    // …and the row holds exactly that.
    const row = await storedRow(id);
    expect(row.quicProbe).toBe(true);
    expect(row.udpProbe, 'a measured negative is FALSE, not null').toBe(false);
    for (const at of [row.quicProbeAt, row.udpProbeAt]) {
      expect(at).toBeInstanceOf(Date);
      expect(at!.getTime()).toBeGreaterThanOrEqual(startedAt);
      expect(at!.getTime()).toBeLessThanOrEqual(finishedAt);
    }
    // ⛔ Not the live-session column. A Test's relay check is not a session's
    // negotiated protocol and must never be written as one.
    expect(row.quicMeasured).toBeNull();
    expect(row.quicMeasuredAt).toBeNull();

    // P5 — the list carries the stored readings, ISO-dated.
    const listed = await listedProxy(id);
    expect(listed.quic_probe).toBe(true);
    expect(listed.quic_probe_at).toBe(row.quicProbeAt!.toISOString());
    expect(listed.udp_probe).toBe(false);
    expect(listed.udp_probe_at).toBe(row.udpProbeAt!.toISOString());
    expect(listed.quic_measured).toBeNull();

    // P5 — and the test reply carries the row AS IT NOW STANDS, not the nulls it
    // read before measuring.
    expect(body.quic_probe).toBe(true);
    expect(body.quic_probe_at).toBe(row.quicProbeAt!.toISOString());
    expect(body.udp_probe).toBe(false);
    expect(body.udp_probe_at).toBe(row.udpProbeAt!.toISOString());
  });

  it('P2 the mirror polarity — QUIC measured FALSE, UDP measured TRUE — and a later Test OVERWRITES an earlier reading with a newer date', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerNode('mac-0124-002', {
      quic_ok: false,
      quic_detail: 'the quic handshake timed out through the proxy',
      udp_associate: true,
    });
    const id = await makeSocks5Proxy('socks-0124-002.example.com');
    // The provider used to relay QUIC and no longer does: the stored `true` must
    // give way to the measured `false`, or the row would say "relays" forever.
    await seedEarlierReadings(id, true, false);

    const body = await runTest(id, 'fleet');
    expect(body.ok, JSON.stringify(body)).toBe(true);

    const row = await storedRow(id);
    expect(row.quicProbe, 'a measured negative is FALSE, not null').toBe(false);
    expect(row.udpProbe).toBe(true);
    expect(row.quicProbeAt!.getTime()).toBeGreaterThan(EARLIER.getTime());
    expect(row.udpProbeAt!.getTime()).toBeGreaterThan(EARLIER.getTime());
    expect((await listedProxy(id)).quic_probe).toBe(false);
  });

  it('P3 CRITICAL a SKIPPED leg writes nothing: it does not invent a false on a never-measured row, and it does not erase what an earlier Test stored — while the leg that WAS measured in the same frame is written (the legs are independent, and that write is this arm’s vacuity control). MUTATION: persist `r.quic_ok` directly instead of the reading `capabilityReadingsForReply` decided, and the skipped `false` lands on the row.', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    // Both non-measurement spellings at once: QUIC as today's node says it (a
    // `false` beside "skipped:"), and the measured UDP leg beside it.
    registerNode('mac-0124-003', {
      quic_ok: false,
      quic_detail: 'skipped: udp relay unavailable',
      udp_associate: true,
    });
    const fresh = await makeSocks5Proxy('socks-0124-003.example.com');
    const seeded = await makeSocks5Proxy('socks-0124-004.example.com');
    await seedEarlierReadings(seeded, true, false);
    const update = vi.spyOn(fx.accountProxiesRepo, 'update');
    const store = vi.spyOn(fx.accountProxiesRepo, 'storeProbeReadingsIfSameIdentity');

    const freshBody = await runTest(fresh, 'fleet');
    expect(freshBody.ok, JSON.stringify(freshBody)).toBe(true);
    expect('quic_ok' in freshBody, 'a skipped leg is not a reading on the reply').toBe(false);
    const freshRow = await storedRow(fresh);
    expect(freshRow.quicProbe, 'a skipped leg must not become a stored false').toBeNull();
    expect(freshRow.quicProbeAt).toBeNull();
    // VACUITY CONTROL — the route DID persist from this very frame.
    expect(freshRow.udpProbe).toBe(true);
    expect(freshRow.udpProbeAt).toBeInstanceOf(Date);
    // The reply keeps the three states: a stored null stays null beside the
    // freshly stored leg.
    expect(freshBody.quic_probe).toBeNull();
    expect(freshBody.quic_probe_at).toBeNull();
    expect(freshBody.udp_probe).toBe(true);

    const seededBody = await runTest(seeded, 'fleet');
    expect(seededBody.ok, JSON.stringify(seededBody)).toBe(true);
    const seededRow = await storedRow(seeded);
    expect(seededRow.quicProbe, 'the earlier reading survives a skipped leg').toBe(true);
    expect(seededRow.quicProbeAt).toEqual(EARLIER);
    expect(seededRow.udpProbe).toBe(true);
    expect(seededRow.udpProbeAt!.getTime()).toBeGreaterThan(EARLIER.getTime());
    // The reply carries the EARLIER quic reading at its own date, never re-dated.
    expect(seededBody.quic_probe).toBe(true);
    expect(seededBody.quic_probe_at).toBe(EARLIER.toISOString());

    // No write anywhere in this arm so much as NAMED the quic columns — "write
    // nothing" is an absent key, not a key set to the value it already had.
    for (const call of update.mock.calls) {
      expect('quicProbe' in call[0].updates).toBe(false);
      expect('quicProbeAt' in call[0].updates).toBe(false);
    }
    // The readings go through their own write, and it ran once per Test — so the
    // loop below is not vacuously true over an empty list.
    expect(store).toHaveBeenCalledTimes(2);
    for (const call of store.mock.calls) {
      expect(Object.keys(call[0].readings).sort()).toEqual(['udpProbe', 'udpProbeAt']);
    }
  });

  it('P3 the contracted three-state `null` and a VPN row’s ASSERTED literal write nothing either — the same node’s frame on a SOCKS5 row does (vacuity control)', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    // Today's VPN frame: `udp_associate: true` is a literal about the tunnel's
    // nature with no `udp_detail` behind it, and the QUIC leg is an explicit null.
    registerNode('mac-0124-005', {
      udp_associate: true,
      quic_ok: null,
      quic_detail: 'skipped: quic leg not probed on the vpn path',
    });
    const vpn = await makeWireGuardProxy();
    const vpnBody = await runTest(vpn, 'fleet');
    expect(vpnBody.ok, JSON.stringify(vpnBody)).toBe(true);
    expect(vpnBody.measured_from).toBe('fleet');
    const vpnRow = await storedRow(vpn);
    expect(vpnRow.udpProbe, 'an asserted literal is not a stored reading').toBeNull();
    expect(vpnRow.udpProbeAt).toBeNull();
    expect(vpnRow.quicProbe).toBeNull();
    expect(vpnRow.quicProbeAt).toBeNull();

    // VACUITY CONTROL — the identical frame on a SOCKS5 row, where the boolean
    // IS a probe: stored. One node per fixture (the registry dispatches to
    // whichever is free), so this re-uses the node above on purpose.
    const socks = await makeSocks5Proxy('socks-0124-005.example.com');
    expect((await runTest(socks, 'fleet')).ok).toBe(true);
    const socksRow = await storedRow(socks);
    expect(socksRow.udpProbe).toBe(true);
    expect(socksRow.quicProbe).toBeNull();
  });

  it('P3 a verdict on a proxy that does NOT WORK stores nothing: its `false` legs had nothing to run over, and a stored negative stops anyone looking again', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    // The credential was refused. The node still fills in every boolean.
    registerNode('mac-0124-006', {
      auth_ok: false,
      can_route: false,
      exit_ip: null,
      udp_associate: false,
      quic_ok: false,
      quic_detail: null,
    });
    const id = await makeSocks5Proxy('socks-0124-006.example.com');
    await seedEarlierReadings(id, true, true);

    const body = await runTest(id, 'fleet');
    expect(body.ok, JSON.stringify(body)).toBe(false);
    expect(body.measured_from).toBe('fleet');

    const row = await storedRow(id);
    expect(row.quicProbe, 'an unusable proxy’s false is not a reading of its QUIC').toBe(true);
    expect(row.udpProbe).toBe(true);
    expect(row.quicProbeAt).toEqual(EARLIER);
    expect(row.udpProbeAt).toEqual(EARLIER);
  });

  it('P3 a frame that reached NO verdict (could_not_run) stores nothing — every boolean on it is a default. For a SOCKS5 row the control plane answers instead, and it measures neither leg', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerNode('mac-0124-007', {
      ok: false,
      reachable: false,
      auth_ok: false,
      can_route: false,
      exit_ip: null,
      latency_ms: null,
      udp_associate: false,
      quic_ok: false,
      quic_detail: null,
      error: 'node_busy',
    });
    const id = await makeSocks5Proxy('socks-0124-007.example.com');
    const body = await runTest(id, 'fleet');
    // The node ran nothing, so this reply is the control plane's own check — the
    // label says so, and it carries no capability leg of its own.
    expect(body.measured_from, JSON.stringify(body)).toBe('control_plane');
    expect('quic_ok' in body).toBe(false);
    expect('udp_associate' in body).toBe(false);
    const row = await storedRow(id);
    expect(row.quicProbe, 'a default false is not a measurement').toBeNull();
    expect(row.udpProbe, 'a default false is not a measurement').toBeNull();
    expect(body.quic_probe).toBeNull();
    expect(body.udp_probe).toBeNull();
  });

  it('P6 CRITICAL storing is best-effort: when the write throws, the Test’s answer is unchanged — still the NODE’s measurement, still `fleet`, legs intact — and the reply reports the row as it really stands (nothing stored). MUTATION: remove the try/catch in `persistProbeReadingsIfMeasured` and the throw is caught by the fleet branch’s own handler, which relabels the reply `control_plane`.', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerNode('mac-0124-008', { quic_ok: true, udp_associate: true });
    const id = await makeSocks5Proxy('socks-0124-008.example.com');
    // Only the probe-readings write fails; the exit write beside it goes through
    // `update`, which is untouched, so this arm cannot pass because EVERY write
    // was broken.
    const store = vi
      .spyOn(fx.accountProxiesRepo, 'storeProbeReadingsIfSameIdentity')
      .mockRejectedValue(new Error('database unavailable'));

    const body = await runTest(id, 'fleet');
    expect(store, 'the failing write was attempted').toHaveBeenCalledTimes(1);
    expect((await storedRow(id)).exitObserved?.ip, 'the exit write beside it landed').toBe(
      '198.51.100.44',
    );
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.measured_from).toBe('fleet');
    expect(body.node_id).toBe('mac-0124-008');
    expect(body.quic_ok).toBe(true);
    expect(body.udp_associate).toBe(true);
    // Nothing was stored, and the reply does not pretend otherwise.
    expect(body.quic_probe).toBeNull();
    expect(body.udp_probe).toBeNull();
    const row = await storedRow(id);
    expect(row.quicProbe).toBeNull();
    expect(row.udpProbe).toBeNull();
  });

  it('P4 CRITICAL a row that was REPOINTED while the node was measuring does not receive the reading — it describes the previous address. VACUITY CONTROL: an edit that moves nothing (a relabel) in the same window does not block the write.', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    let edit: Record<string, unknown> = { host: 'moved-0124.example.com' };
    let target = '';
    registerNode('mac-0124-009', { quic_ok: false, udp_associate: false }, async () => {
      const res = await putProxy(target, edit);
      expect(res.statusCode, res.body).toBe(200);
    });

    target = await makeSocks5Proxy('socks-0124-009.example.com');
    const movedBody = await runTest(target, 'fleet');
    // The Test still answers with what the node measured…
    expect(movedBody.ok, JSON.stringify(movedBody)).toBe(true);
    expect(movedBody.quic_ok).toBe(false);
    // …but the row now points somewhere else, and says nothing about QUIC there.
    const movedRow = await storedRow(target);
    expect(movedRow.host).toBe('moved-0124.example.com');
    expect(movedRow.quicProbe).toBeNull();
    expect(movedRow.udpProbe).toBeNull();
    expect(movedBody.quic_probe).toBeNull();

    edit = { label: 'renamed while testing' };
    target = await makeSocks5Proxy('socks-0124-010.example.com');
    expect((await runTest(target, 'fleet')).ok).toBe(true);
    const relabelledRow = await storedRow(target);
    expect(relabelledRow.label).toBe('renamed while testing');
    expect(relabelledRow.quicProbe).toBe(false);
    expect(relabelledRow.udpProbe).toBe(false);
  });

  it('P8 CRITICAL a reply never carries the PREVIOUS address’s reading. The row held an earlier Test’s readings when this Test began; the customer repointed it while the node was measuring, which cleared them. The handler’s own copy of the row was read BEFORE that and still holds them — serving it would tell the customer their NEW address does not relay QUIC, dated weeks ago, in the reply to the very Test they are watching. The reply says never tested, exactly as the list does. MUTATION: serve `storedProbeReadings(row)` in place of `probeReadingsAsTheRowStands()` in the fleet reply and the four reply assertions red with the seeded `false` / EARLIER.', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    let target = '';
    registerNode('mac-0124-012', { quic_ok: true, udp_associate: true }, async () => {
      const res = await putProxy(target, { host: 'moved-0124-012.example.com' });
      expect(res.statusCode, res.body).toBe(200);
    });
    target = await makeSocks5Proxy('socks-0124-012.example.com');
    // Opposite polarity to what the node is about to measure, so neither the old
    // reading nor the new one can be mistaken for the other in the reply.
    await seedEarlierReadings(target, false, false);
    // VACUITY CONTROL — the snapshot the handler will read really holds them.
    const seeded = await listedProxy(target);
    expect(seeded.quic_probe).toBe(false);
    expect(seeded.quic_probe_at).toBe(EARLIER.toISOString());

    const body = await runTest(target, 'fleet');
    expect(body.ok, JSON.stringify(body)).toBe(true);
    // This Test's own legs are still reported — they are what the node measured…
    expect(body.quic_ok).toBe(true);
    // …but the STORED reading is the row's, and the row has moved.
    expect(body.quic_probe, 'the previous address’s reading must not be served').toBeNull();
    expect(body.quic_probe_at).toBeNull();
    expect(body.udp_probe, 'the previous address’s reading must not be served').toBeNull();
    expect(body.udp_probe_at).toBeNull();

    // The reply agrees with the row and with the list.
    const row = await storedRow(target);
    expect(row.host).toBe('moved-0124-012.example.com');
    expect(row.quicProbe).toBeNull();
    expect(row.udpProbe).toBeNull();
    const listed = await listedProxy(target);
    expect(listed.quic_probe).toBeNull();
    expect(listed.udp_probe).toBeNull();
  });

  it('P8 the same for a proxy DELETED while the node was measuring: the write finds no row, and the reply does not resurrect the reading the deleted row held', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    let target = '';
    registerNode('mac-0124-013', { quic_ok: true, udp_associate: true }, async () => {
      const res = await fx.app.inject({
        method: 'DELETE',
        url: `/v1/account/me/proxies/${target}`,
        headers: auth(fx),
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
    });
    target = await makeSocks5Proxy('socks-0124-013.example.com');
    await seedEarlierReadings(target, false, false);

    const body = await runTest(target, 'fleet');
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.measured_from).toBe('fleet');
    expect(body.quic_probe).toBeNull();
    expect(body.quic_probe_at).toBeNull();
    expect(body.udp_probe).toBeNull();
    expect(body.udp_probe_at).toBeNull();
    expect(
      await fx.accountProxiesRepo.findById({ id: target, accountId: fx.accountId }),
    ).toBeNull();
  });

  it('P8 CRITICAL a declined write is NOT proof the row was repointed. The desktop resubmits the whole proxy — same host, port, username and password — before every launch; the PUT re-wraps the password, so the stored envelope changes, the identity fence declines the write, and the readings are KEPT (nothing about the endpoint moved). A reply of null here would say "never tested" beside a list that still shows the reading. The reply re-reads the row and says what the list says. MUTATION: answer four nulls whenever the write is declined and the reply assertions red.', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    const credentials = { username: 'user-country-us', password: 'hunter2-0124-016' };
    let target = '';
    registerNode('mac-0124-016', { quic_ok: true, udp_associate: true }, async () => {
      const res = await putProxy(target, {
        label: 'p',
        host: 'socks-0124-016.example.com',
        port: 1080,
        ...credentials,
      });
      expect(res.statusCode, res.body).toBe(200);
    });
    target = await makeSocks5Proxy('socks-0124-016.example.com', credentials);
    await seedEarlierReadings(target, false, false);
    const before = await storedRow(target);

    const body = await runTest(target, 'fleet');
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.measured_from).toBe('fleet');

    // VACUITY CONTROL — the resubmission really re-wrapped the password, so this
    // arm did go through the declined write rather than an ordinary store.
    const after = await storedRow(target);
    expect(after.wrappedPassword).not.toBeNull();
    expect(after.wrappedPassword).not.toBe(before.wrappedPassword);
    // The readings were kept by the PUT and not replaced by this test…
    expect(after.quicProbe).toBe(false);
    expect(after.quicProbeAt).toEqual(EARLIER);
    expect(after.udpProbe).toBe(false);
    expect(after.udpProbeAt).toEqual(EARLIER);
    // …and the reply says exactly what the list says.
    const listed = await listedProxy(target);
    for (const key of ['quic_probe', 'quic_probe_at', 'udp_probe', 'udp_probe_at']) {
      expect(body[key], key).toEqual(listed[key]);
    }
    expect(body.quic_probe).toBe(false);
    expect(body.quic_probe_at).toBe(EARLIER.toISOString());
  });

  it('P8 CRITICAL the same holds when this Test had NOTHING TO STORE, where no write is attempted and so no fence is consulted: the node skipped both legs, or the proxy was not usable (the likeliest moment for a customer to fix the host). Repointed mid-test, each reply carries null — not the previous address’s `false`. MUTATION: serve `storedProbeReadings(row)` in place of `probeReadingsAsTheRowStands()` in the fleet reply.', async () => {
    const frames: Array<{ name: string; legs: Record<string, unknown>; ok: boolean }> = [
      {
        name: 'both legs skipped',
        legs: { quic_ok: false, quic_detail: 'skipped: no relay offered', udp_associate: null },
        ok: true,
      },
      {
        name: 'proxy not usable',
        legs: {
          auth_ok: false,
          can_route: false,
          exit_ip: null,
          udp_associate: false,
          quic_ok: false,
        },
        ok: false,
      },
    ];
    for (const [i, frame] of frames.entries()) {
      fx = await buildTestApp({
        enableFleetControlPlane: true,
        proxyConnectivityProbe: cpProbeStub(),
      });
      let target = '';
      registerNode(`mac-0124-017-${i}`, frame.legs, async () => {
        const res = await putProxy(target, { host: `moved-0124-017-${i}.example.com` });
        expect(res.statusCode, res.body).toBe(200);
      });
      target = await makeSocks5Proxy(`socks-0124-017-${i}.example.com`);
      await seedEarlierReadings(target, false, false);
      const store = vi.spyOn(fx.accountProxiesRepo, 'storeProbeReadingsIfSameIdentity');

      const body = await runTest(target, 'fleet');
      expect(body.ok, `${frame.name}: ${JSON.stringify(body)}`).toBe(frame.ok);
      expect(body.measured_from, frame.name).toBe('fleet');
      // VACUITY CONTROL — this arm is the no-write path, not a declined write.
      expect(store, frame.name).not.toHaveBeenCalled();
      expect(body.quic_probe, frame.name).toBeNull();
      expect(body.quic_probe_at, frame.name).toBeNull();
      expect(body.udp_probe, frame.name).toBeNull();
      expect(body.udp_probe_at, frame.name).toBeNull();
      expect((await storedRow(target)).host).toBe(`moved-0124-017-${i}.example.com`);
      // The last app is left for `afterEach`, which cleans up whatever `fx` holds.
      if (i < frames.length - 1) await fx.cleanup();
    }
  });

  it('P6 when the write THROWS the reply still reports the row as it stands — re-read, here the reading an earlier Test stored', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerNode('mac-0124-014', { quic_ok: true, udp_associate: true });
    const id = await makeSocks5Proxy('socks-0124-014.example.com');
    await seedEarlierReadings(id, false, false);
    vi.spyOn(fx.accountProxiesRepo, 'storeProbeReadingsIfSameIdentity').mockRejectedValue(
      new Error('database unavailable'),
    );

    const body = await runTest(id, 'fleet');
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.measured_from).toBe('fleet');
    expect(body.quic_probe).toBe(false);
    expect(body.quic_probe_at).toBe(EARLIER.toISOString());
    expect(body.udp_probe).toBe(false);
    expect(body.udp_probe_at).toBe(EARLIER.toISOString());
  });

  it('P6 when the row cannot even be RE-READ, the handler’s earlier copy is the best knowledge there is and is served — and the failure stays inside: the reply is still the NODE’s measurement, still `fleet`. MUTATION: remove the try/catch in `probeReadingsAsTheRowStands` and the throw relabels the reply `control_plane`.', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    // Reads fail only from the moment the node has been asked — the handler's
    // own first read of the row, before the test, is a real one.
    let storeIsDown = false;
    registerNode('mac-0124-018', { quic_ok: true, udp_associate: true }, () => {
      storeIsDown = true;
      return Promise.resolve();
    });
    const id = await makeSocks5Proxy('socks-0124-018.example.com');
    await seedEarlierReadings(id, false, true);
    const realFindById = fx.accountProxiesRepo.findById.bind(fx.accountProxiesRepo);
    const findById = vi
      .spyOn(fx.accountProxiesRepo, 'findById')
      .mockImplementation((args) =>
        storeIsDown ? Promise.reject(new Error('database unavailable')) : realFindById(args),
      );
    vi.spyOn(fx.accountProxiesRepo, 'storeProbeReadingsIfSameIdentity').mockRejectedValue(
      new Error('database unavailable'),
    );

    const body = await runTest(id, 'fleet');
    expect(storeIsDown).toBe(true);
    // VACUITY CONTROL — a read was attempted after the store went down.
    expect(findById.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.measured_from).toBe('fleet');
    expect(body.quic_probe).toBe(false);
    expect(body.quic_probe_at).toBe(EARLIER.toISOString());
    expect(body.udp_probe).toBe(true);
    expect(body.udp_probe_at).toBe(EARLIER.toISOString());
  });

  it('P7 CRITICAL a reading is dated when it was MEASURED. On a SOCKS5 row the OS observation runs between the node’s answer and the write and can take seconds; a date taken at the write would trail the measurement by that long, and two Tests finishing out of order would be ranked by who wrote last. The observation here is made slow on purpose, and the stored date must not postdate its START. MUTATION: date the reading `new Date()` inside `persistProbeReadingsIfMeasured` and both dates land after the observation began.', async () => {
    let observationBeganAt = 0;
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: {
        probe: () => Promise.resolve({ ok: true }),
        observeOs: async () => {
          observationBeganAt = Date.now();
          await new Promise((r) => setTimeout(r, 250));
          return { observed: false, reason: 'no SYN recorded' };
        },
      } as unknown as never,
    });
    registerNode('mac-0124-015', { quic_ok: false, udp_associate: true });
    const id = await makeSocks5Proxy('socks-0124-015.example.com');

    const startedAt = Date.now();
    const body = await runTest(id, 'fleet');
    expect(body.ok, JSON.stringify(body)).toBe(true);
    // VACUITY CONTROL — the slow observation really ran inside this Test.
    expect(observationBeganAt, 'the OS observation never ran').toBeGreaterThanOrEqual(startedAt);

    const row = await storedRow(id);
    expect(row.quicProbe).toBe(false);
    expect(row.udpProbe).toBe(true);
    for (const at of [row.quicProbeAt, row.udpProbeAt]) {
      expect(at).toBeInstanceOf(Date);
      expect(at!.getTime()).toBeGreaterThanOrEqual(startedAt);
      expect(
        at!.getTime(),
        'the reading is dated after the OS observation began — that is the write’s clock, not the measurement’s',
      ).toBeLessThanOrEqual(observationBeganAt);
    }
    // One measurement, one date — and the reply carries that same date.
    expect(row.quicProbeAt).toEqual(row.udpProbeAt);
    expect(body.quic_probe_at).toBe(row.quicProbeAt!.toISOString());
  });

  it('P5 a CONTROL-PLANE test measures neither leg: it writes nothing and carries the row’s stored readings, dated as stored', async () => {
    fx = await buildTestApp({ proxyConnectivityProbe: cpProbeStub() });
    const id = await makeSocks5Proxy('socks-0124-011.example.com');
    await seedEarlierReadings(id, false, true);
    const update = vi.spyOn(fx.accountProxiesRepo, 'update');

    const body = await runTest(id, 'cp');
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.quic_probe).toBe(false);
    expect(body.quic_probe_at).toBe(EARLIER.toISOString());
    expect(body.udp_probe).toBe(true);
    expect(body.udp_probe_at).toBe(EARLIER.toISOString());
    for (const call of update.mock.calls) {
      expect('quicProbe' in call[0].updates).toBe(false);
      expect('udpProbe' in call[0].updates).toBe(false);
    }
  });
  it('P8 a CONTROL-PLANE test re-reads too. Its OS observation can take seconds, and a customer who repoints the proxy inside it must not be answered with the previous address’s reading. MUTATION: serve `storedProbeReadings(row)` on the control-plane replies.', async () => {
    let target = '';
    fx = await buildTestApp({
      proxyConnectivityProbe: {
        probe: () => Promise.resolve({ ok: true }),
        observeOs: async () => {
          const res = await putProxy(target, { host: 'moved-0124-019.example.com' });
          expect(res.statusCode, res.body).toBe(200);
          return { observed: false, reason: 'no SYN recorded' };
        },
      } as unknown as never,
    });
    target = await makeSocks5Proxy('socks-0124-019.example.com');
    await seedEarlierReadings(target, false, true);

    const body = await runTest(target, 'cp');
    expect(body.ok, JSON.stringify(body)).toBe(true);
    // VACUITY CONTROL — the edit really landed inside this test.
    expect((await storedRow(target)).host).toBe('moved-0124-019.example.com');
    expect(body.quic_probe).toBeNull();
    expect(body.quic_probe_at).toBeNull();
    expect(body.udp_probe).toBeNull();
    expect(body.udp_probe_at).toBeNull();
  });
});

describe('a stored QUIC / UDP reading does not outlive the path it was measured through', () => {
  it('P4 CRITICAL a port change, a host change and a credential change each reset all four columns to null — in the SAME update that moves the row — and the list then serves null. A stored `false` is the worst survivor: it tells a client NOT to look again, about a machine the row no longer points at. MUTATION: drop the four keys from `sessionReadings` in `proxyReadingsInvalidatedByEdit`.', async () => {
    fx = await buildTestApp();
    const edits: Array<Record<string, unknown>> = [
      { port: 1081 },
      { host: 'gw2-0124.example.com' },
      { username: 'user-country-de' },
      { password: 'pw-two' },
    ];
    for (const [i, edit] of edits.entries()) {
      const id = await makeSocks5Proxy(`gw-0124-${i.toString()}.example.com`, {
        username: 'user-country-us',
        password: 'pw-one',
      });
      await seedEarlierReadings(id, false, true);
      const update = vi.spyOn(fx.accountProxiesRepo, 'update');

      const res = await putProxy(id, edit);
      expect(res.statusCode, res.body).toBe(200);
      expect(update, JSON.stringify(edit)).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]?.[0].updates, JSON.stringify(edit)).toMatchObject({
        quicProbe: null,
        quicProbeAt: null,
        udpProbe: null,
        udpProbeAt: null,
      });
      update.mockRestore();

      const row = await storedRow(id);
      expect(row.quicProbe, JSON.stringify(edit)).toBeNull();
      expect(row.quicProbeAt, JSON.stringify(edit)).toBeNull();
      expect(row.udpProbe, JSON.stringify(edit)).toBeNull();
      expect(row.udpProbeAt, JSON.stringify(edit)).toBeNull();
      // The single-row reply of the PUT itself carries the reset too.
      const put = res.json<Record<string, unknown>>();
      expect(put.quic_probe).toBeNull();
      expect(put.udp_probe).toBeNull();
      expect((await listedProxy(id)).quic_probe).toBeNull();
    }
  });

  it('VACUITY CONTROL a relabel, and the desktop client’s whole-row resubmission with nothing changed, reset NOTHING — a stored false stays false', async () => {
    fx = await buildTestApp();
    const id = await makeSocks5Proxy('gw-0124-keep.example.com', {
      username: 'user-country-us',
      password: 'pw-one',
    });
    await seedEarlierReadings(id, false, true);

    expect((await putProxy(id, { label: 'work laptop' })).statusCode).toBe(200);
    const resubmitted = await putProxy(id, {
      label: 'work laptop',
      scheme: 'socks5',
      host: 'gw-0124-keep.example.com',
      port: 1080,
      username: 'user-country-us',
      password: 'pw-one',
    });
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);

    const row = await storedRow(id);
    expect(row.quicProbe).toBe(false);
    expect(row.quicProbeAt).toEqual(EARLIER);
    expect(row.udpProbe).toBe(true);
    expect(row.udpProbeAt).toEqual(EARLIER);
    const put = resubmitted.json<Record<string, unknown>>();
    expect(put.quic_probe).toBe(false);
    expect(put.quic_probe_at).toBe(EARLIER.toISOString());
  });
});

describe('the pure rules behind the write and the read', () => {
  const at = new Date('2026-09-17T10:00:00.000Z');
  const neverMeasured = { quicProbeAt: null, udpProbeAt: null };

  it('probeCapabilityUpdates: a measured false is an update to FALSE; no measured leg is NO update (null, not an object of undefineds); each leg moves only with its own date', () => {
    expect(
      probeCapabilityUpdates({ measured: { quic: false, udp: true }, at, row: neverMeasured }),
    ).toEqual({ quicProbe: false, quicProbeAt: at, udpProbe: true, udpProbeAt: at });
    expect(probeCapabilityUpdates({ measured: {}, at, row: neverMeasured })).toBeNull();
    const udpOnly = probeCapabilityUpdates({ measured: { udp: false }, at, row: neverMeasured });
    expect(udpOnly).toEqual({ udpProbe: false, udpProbeAt: at });
    // Absent KEYS, not undefined values: "no update" and "update to undefined"
    // read the same in an `update()` call and only one of them is honest.
    expect(Object.keys(udpOnly ?? {}).sort()).toEqual(['udpProbe', 'udpProbeAt']);
  });

  it('probeCapabilityUpdates: with `yieldToReadingsAfter`, a leg the row already holds a NEWER reading for stands down — per leg, so the other still lands; without it nothing yields', () => {
    const probeBegan = new Date('2026-09-17T09:59:30.000Z');
    const customerTestedAt = new Date('2026-09-17T09:59:45.000Z');
    const row = { quicProbeAt: customerTestedAt, udpProbeAt: EARLIER };
    expect(
      probeCapabilityUpdates({
        measured: { quic: false, udp: false },
        at,
        row,
        yieldToReadingsAfter: probeBegan,
      }),
    ).toEqual({ udpProbe: false, udpProbeAt: at });
    expect(
      probeCapabilityUpdates({
        measured: { quic: false },
        at,
        row,
        yieldToReadingsAfter: probeBegan,
      }),
    ).toBeNull();
    // The interactive route passes no instant and is never the loser.
    expect(probeCapabilityUpdates({ measured: { quic: false }, at, row })).toEqual({
      quicProbe: false,
      quicProbeAt: at,
    });
  });

  it('storedProbeReadings: three states survive to the wire — false is served as false — and a reading that cannot be DATED is served as never measured rather than looking current', () => {
    expect(
      storedProbeReadings({ quicProbe: false, quicProbeAt: at, udpProbe: null, udpProbeAt: null }),
    ).toEqual({
      quic_probe: false,
      quic_probe_at: at.toISOString(),
      udp_probe: null,
      udp_probe_at: null,
    });
    expect(
      storedProbeReadings({ quicProbe: true, quicProbeAt: null, udpProbe: true, udpProbeAt: at }),
    ).toEqual({
      quic_probe: null,
      quic_probe_at: null,
      udp_probe: true,
      udp_probe_at: at.toISOString(),
    });
  });
});
