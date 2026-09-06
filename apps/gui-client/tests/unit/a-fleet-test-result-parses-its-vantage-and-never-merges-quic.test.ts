// T-1: "Proxy measurements, latency, ping all this should be measured from the
// Mac that will run the profile, not from local." The server can now measure
// from a fleet Mac (`?vantage=fleet`) and says WHERE the number came from —
// `measured_from: 'fleet'` (+ `node_id`) or, when no node was free, the
// control-plane probe labelled `measured_from: 'control_plane'`. A vantage=cp
// request (no option) is today's request and today's response, unchanged.
//
// MEASURED mechanism, two hops. The WIRE (testAccountProxy): the vantage is a
// CLOSED set — a value outside it is DROPPED, so a number can never be shown
// under a label it did not earn; the fleet-only fields (node_id, quic_ok →
// quic_probe, …) are kept only beside a 'fleet' vantage and only in their own
// type. The CACHE (proxy-probe-cache): the vantage and the relay verdict ride
// the server record, survive a native re-test with it, and are REPLACED by the
// next server result (a control-plane fallback after a fleet run must not keep
// wearing the fleet label).
//
// The binding rule under test: `quic_ok` is the fleet Mac's STANDALONE QUIC
// handshake through the proxy — it proves the PROXY relays QUIC. `quic_measured`
// is a live browser session's observed HTTP/3. They are two signals; the parser
// keeps both, labelled, and NEVER derives one from the other — a proxy that
// relays QUIC while the session saw h2-only is a finding, not a contradiction to
// smooth over.
//
// One property per assertion. VACUITY CONTROLS: a valid boolean `quic_ok`
// survives (so the "non-boolean is dropped" arm is not passing on a parser that
// drops everything), and a native-only entry has none of the new fields (so the
// "preserved" arm is not re-reading a value every entry carries).

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
const requestedUrls: string[] = [];
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (url: string) => {
    requestedUrls.push(url);
    return Promise.resolve(nextResponse());
  },
}));

import { testAccountProxy } from '../../src/lib/account-proxies';
import {
  deriveProbeViewState,
  loadProbeCache,
  saveProbeResult,
  saveServerProbeResult,
} from '../../src/lib/proxy-probe-cache';
import { cleanProxyVantage, cleanServerVantage, vantageLabel } from '../../src/lib/proxy-vantage';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** The exact body the server returns for a fleet-measured test. */
const FLEET_BODY = {
  ok: true,
  latency_ms: 31,
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  h2_ok: true,
  quic_ok: true,
  quic_detail: 'h3 handshake ok',
  exit_ip: '203.0.113.9',
  node_id: 'mac-mini-07',
  measured_from: 'fleet',
};

const OK = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};
const DOWN = { ...OK, reachable: false, can_route: false, connect_reply: 0xff, message: 'down' };

beforeEach(() => {
  stores.clear();
  requestedUrls.length = 0;
});

describe('the request', () => {
  it("asks for the fleet vantage on the URL when { vantage: 'fleet' } is passed", async () => {
    nextResponse = () => json(FLEET_BODY);
    await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(requestedUrls[0]).toBe(
      'https://api.example/v1/account/me/proxies/srv1/test?vantage=fleet',
    );
  });

  it("sends exactly today's URL (no query) when no vantage is passed", async () => {
    nextResponse = () => json({ ok: true, latency_ms: 7 });
    await testAccountProxy('https://api.example', 'ds_x', 'srv1');
    expect(requestedUrls[0]).toBe('https://api.example/v1/account/me/proxies/srv1/test');
  });
});

describe('the wire — a fleet result carries its vantage', () => {
  it("reads measured_from 'fleet'", async () => {
    nextResponse = () => json(FLEET_BODY);
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ ok: true, measured_from: 'fleet' });
  });

  it('names the node that measured it', async () => {
    nextResponse = () => json(FLEET_BODY);
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ node_id: 'mac-mini-07' });
  });

  it('carries the standalone QUIC-relay verdict as quic_probe', async () => {
    nextResponse = () => json(FLEET_BODY);
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ quic_probe: true });
  });

  it('carries the fleet latency as the server latency', async () => {
    nextResponse = () => json(FLEET_BODY);
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ latency_ms: 31 });
  });

  it('keeps the other fleet fields only in their own type', async () => {
    nextResponse = () => json(FLEET_BODY);
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({
      exit_ip: '203.0.113.9',
      quic_detail: 'h3 handshake ok',
      reachable: true,
      udp_associate: true,
      h2_ok: true,
    });
  });

  it('drops a fleet field that arrives in the wrong type, keeping its siblings', async () => {
    nextResponse = () => json({ ...FLEET_BODY, exit_ip: 42, udp_associate: 'yes' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).not.toHaveProperty('exit_ip');
    expect(r).not.toHaveProperty('udp_associate');
    expect(r).toMatchObject({ node_id: 'mac-mini-07', quic_probe: true });
  });
});

describe('the wire — the honest fallback and the closed set', () => {
  it("reads a control-plane fallback as measured_from 'control_plane'", async () => {
    nextResponse = () => json({ ok: true, latency_ms: 88, measured_from: 'control_plane' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ ok: true, latency_ms: 88, measured_from: 'control_plane' });
  });

  it('never attaches a node id or a relay verdict to a control-plane number', async () => {
    // The relay chip's caption names a fleet Mac; a value that did not come from
    // one must not reach it, whatever a future server puts on the fallback body.
    nextResponse = () =>
      json({
        ok: true,
        latency_ms: 88,
        measured_from: 'control_plane',
        node_id: 'x',
        quic_ok: true,
      });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).not.toHaveProperty('node_id');
    expect(r).not.toHaveProperty('quic_probe');
  });

  it("parses a cp response (no measured_from) to EXACTLY today's shape — no new keys", async () => {
    nextResponse = () =>
      json({
        ok: true,
        latency_ms: 7,
        quic_measured: 'h3',
        quic_measured_at: '2026-09-03T00:00:00Z',
      });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1');
    expect(r).toEqual({
      ok: true,
      latency_ms: 7,
      quic_measured: 'h3',
      quic_measured_at: '2026-09-03T00:00:00Z',
    });
  });

  it("DROPS a measured_from outside the closed set ('laptop') rather than labelling with it", async () => {
    // The mutation this arm exists for: accepting any string would let a newer
    // server (or a proxy MITM-ing the response) put a number under a label the
    // client cannot vouch for.
    nextResponse = () => json({ ...FLEET_BODY, measured_from: 'laptop' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).not.toHaveProperty('measured_from');
  });

  it('a dropped vantage takes the fleet-only fields with it', async () => {
    nextResponse = () => json({ ...FLEET_BODY, measured_from: 'laptop' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).not.toHaveProperty('node_id');
    expect(r).not.toHaveProperty('quic_probe');
  });

  it('still surfaces the latency when the vantage was dropped', async () => {
    nextResponse = () => json({ ...FLEET_BODY, measured_from: 'laptop' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ ok: true, latency_ms: 31 });
  });

  it("omits quic_probe when quic_ok is the STRING 'true'", async () => {
    nextResponse = () => json({ ...FLEET_BODY, quic_ok: 'true' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).not.toHaveProperty('quic_probe');
  });

  it('omits quic_probe when quic_ok is a number', async () => {
    nextResponse = () => json({ ...FLEET_BODY, quic_ok: 1 });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).not.toHaveProperty('quic_probe');
  });

  it('VACUITY CONTROL — a valid boolean false survives as quic_probe:false', async () => {
    // Proves the two arms above are not passing on a parser that drops every
    // quic_ok: the measured negative is kept, as a boolean, and is not truthy.
    nextResponse = () => json({ ...FLEET_BODY, quic_ok: false });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toHaveProperty('quic_probe', false);
  });

  it('CRITICAL a fleet result that is ok with NO timing parses — it used to throw `malformed`', async () => {
    // ⛔ The node reached the proxy and produced no number. The spec's fleet member
    // has ALWAYS typed latency_ms nullable, but the parser required a number, fell
    // through every branch, and threw. The only caller wraps this in
    // `.catch(() => null)` — so the customer's re-test did nothing at all: no
    // fingerprint, no vantage, no error, and the PREVIOUS numbers stayed on the
    // card looking freshly measured. A silent no-op is the worst of both.
    nextResponse = () => json({ ...FLEET_BODY, latency_ms: null });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ ok: true, latency_ms: null, measured_from: 'fleet' });
    // The rest of the node's measurement survives: the missing number costs the
    // number, not the result.
    expect(r).toMatchObject({ node_id: 'mac-mini-07', quic_probe: true });
  });

  it('CRITICAL a null latency WITHOUT the fleet vantage is still malformed', async () => {
    // The cp member types latency_ms as a required integer, so a null there is a
    // broken response. Accepting it everywhere would turn that into a silent ok
    // with no number — trading a loud failure for the quiet one just fixed.
    nextResponse = () => json({ ok: true, latency_ms: null });
    await expect(testAccountProxy('https://api.example', 'ds_x', 'srv1')).rejects.toThrow(
      /malformed/,
    );
  });

  it("labels a fleet 'ok:false' (no prose on the node's frame) rather than calling it malformed", async () => {
    nextResponse = () =>
      json({ ...FLEET_BODY, ok: false, reachable: false, latency_ms: null, quic_ok: false });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ ok: false, measured_from: 'fleet' });
    expect(r.ok === false ? r.reason : '').toMatch(/could not connect/);
  });
});

describe('the two QUIC signals are never merged', () => {
  it('a fleet result with quic_ok:true and NO quic_measured leaves quic_measured ABSENT', async () => {
    // The relay probe proves the proxy relays QUIC; it says nothing about what a
    // live session saw. Inferring 'h3' from it would paint a green session chip
    // from a measurement that never ran a session.
    nextResponse = () => json(FLEET_BODY);
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).not.toHaveProperty('quic_measured');
  });

  it('a fleet result with quic_ok:true and quic_measured h2-only keeps BOTH, disagreeing', async () => {
    nextResponse = () => json({ ...FLEET_BODY, quic_measured: 'h2-only' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ quic_probe: true, quic_measured: 'h2-only' });
  });

  it('a fleet result with quic_ok:false and quic_measured h3 keeps BOTH, disagreeing', async () => {
    nextResponse = () => json({ ...FLEET_BODY, quic_ok: false, quic_measured: 'h3' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1', { vantage: 'fleet' });
    expect(r).toMatchObject({ quic_probe: false, quic_measured: 'h3' });
  });
});

describe('the closed set helper', () => {
  it("keeps 'fleet' and 'control_plane'", () => {
    expect(cleanProxyVantage('fleet')).toBe('fleet');
    expect(cleanProxyVantage('control_plane')).toBe('control_plane');
  });

  it('drops any other value', () => {
    expect(cleanProxyVantage('laptop')).toBeUndefined();
    expect(cleanProxyVantage('cp')).toBeUndefined();
    expect(cleanProxyVantage(1)).toBeUndefined();
    expect(cleanProxyVantage(null)).toBeUndefined();
  });

  it("keeps a node id only beside 'fleet'", () => {
    expect(cleanServerVantage('fleet', 'mac-mini-07')).toEqual({
      measuredFrom: 'fleet',
      nodeId: 'mac-mini-07',
    });
    expect(cleanServerVantage('control_plane', 'mac-mini-07')).toEqual({
      measuredFrom: 'control_plane',
    });
  });

  it("labels 'fleet' as from a fleet Mac and names the node in the hover text", () => {
    const l = vantageLabel({ measuredFrom: 'fleet', nodeId: 'mac-mini-07' });
    expect(l.label).toBe('from a fleet Mac');
    expect(l.title).toContain('mac-mini-07');
    expect(l.title).toContain('Mac that runs your profiles');
  });

  it("labels 'control_plane' as from the server and says why in the hover text", () => {
    const l = vantageLabel({ measuredFrom: 'control_plane' });
    expect(l.label).toBe('from the server');
    expect(l.title).toContain('No fleet Mac was free');
  });
});

describe('the cache', () => {
  it('stores the vantage, the node and the relay verdict beside the server latency', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 31, measuredFrom: 'fleet', nodeId: 'mac-mini-07', quicProbe: true },
      2,
    );
    const c = (await loadProbeCache()).p1;
    expect(c?.measuredFrom).toBe('fleet');
    expect(c?.nodeId).toBe('mac-mini-07');
    expect(c?.quicProbe).toBe(true);
  });

  it('PRESERVES all three across a native capability re-test', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 31, measuredFrom: 'fleet', nodeId: 'mac-mini-07', quicProbe: true },
      2,
    );
    await saveProbeResult('p1', { ...OK, latency_ms: 80 }, 3);
    const c = (await loadProbeCache()).p1;
    expect(c?.result.latency_ms).toBe(80); // the native number did update
    expect(c?.measuredFrom).toBe('fleet'); // …the vantage survived
    expect(c?.nodeId).toBe('mac-mini-07'); // …and its node
    expect(c?.quicProbe).toBe(true); // …and the relay verdict
  });

  it('VACUITY CONTROL — a native-only entry has none of the three', async () => {
    await saveProbeResult('p2', OK, 1);
    const c = (await loadProbeCache()).p2;
    expect(c).not.toHaveProperty('measuredFrom');
    expect(c).not.toHaveProperty('nodeId');
    expect(c).not.toHaveProperty('quicProbe');
  });

  it('a control-plane fallback REPLACES a prior fleet label — the fallback is never silent', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 31, measuredFrom: 'fleet', nodeId: 'mac-mini-07', quicProbe: true },
      2,
    );
    await saveServerProbeResult('p1', { latencyMs: 90, measuredFrom: 'control_plane' }, 3);
    const c = (await loadProbeCache()).p1;
    expect(c?.serverLatencyMs).toBe(90);
    expect(c?.measuredFrom).toBe('control_plane');
    expect(c).not.toHaveProperty('nodeId'); // no Mac measured this number
    expect(c).not.toHaveProperty('quicProbe'); // no fleet relay verdict either
  });

  it('a server result without a vantage leaves the number unlabelled, not fleet-labelled', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult('p1', { latencyMs: 31, measuredFrom: 'fleet', nodeId: 'n' }, 2);
    await saveServerProbeResult('p1', { latencyMs: 50 }, 3);
    const c = (await loadProbeCache()).p1;
    expect(c?.serverLatencyMs).toBe(50);
    expect(c).not.toHaveProperty('measuredFrom');
  });

  it('never merges the relay verdict into the measured session QUIC', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult('p1', { latencyMs: 31, measuredFrom: 'fleet', quicProbe: true }, 2);
    const c = (await loadProbeCache()).p1;
    expect(c).not.toHaveProperty('quicMeasured');
  });

  it('drops a stored vantage outside the closed set, keeping the rest of the entry', async () => {
    stores.set(
      'proxy-probe-cache.json',
      new Map([
        [
          'probes',
          {
            p1: {
              result: OK,
              at: 1,
              serverLatencyMs: 12,
              measuredFrom: 'laptop',
              nodeId: 'n',
              quicProbe: 'true',
            },
          },
        ],
      ]),
    );
    const c = (await loadProbeCache()).p1;
    expect(c?.serverLatencyMs).toBe(12); // a valid sibling survives
    expect(c).not.toHaveProperty('measuredFrom');
    expect(c).not.toHaveProperty('nodeId');
    expect(c).not.toHaveProperty('quicProbe'); // a string is not a measurement
  });

  it('exposes the vantage and the relay verdict to the views only while the proxy is usable', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 31, measuredFrom: 'fleet', nodeId: 'mac-mini-07', quicProbe: true },
      2,
    );
    let view = deriveProbeViewState(await loadProbeCache());
    expect(view.serverVantage.p1).toEqual({ measuredFrom: 'fleet', nodeId: 'mac-mini-07' });
    expect(view.quicProbe.p1).toBe(true);
    await saveProbeResult('p1', DOWN, 3);
    view = deriveProbeViewState(await loadProbeCache());
    expect(view.serverVantage).toEqual({});
    expect(view.quicProbe).toEqual({});
  });
});
