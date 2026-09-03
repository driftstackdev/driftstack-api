// T-1 node-scoped egress probe — unit tests for the probe-egress correlator, the
// FleetControlConnection probe path, and the FleetControlRegistry dispatch (the
// out-of-session sibling of the trim tests). Pins: a probeEgress goes out as JSON
// carrying the config + target; the matching probeEgressResult (by requestId)
// resolves `ok` WITH the measured result — an UNREACHABLE proxy is a result, not an
// error; a result carrying `error` resolves `error`; no reply resolves `timeout`; an
// unknown requestId is a no-op; a send-throw / failAll / close resolve `error` (never
// reject, no timer leak). Registry: picks an uncordoned node, SKIPS a cordoned one,
// and asserts the result's node_id matches the node it dispatched to (provenance).

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProbeEgressRequestCorrelator,
  PROBE_EGRESS_REQUEST_TIMEOUT_MS,
  type ProbeEgressTransport,
} from '../../src/services/probe-egress-request-correlator.js';
import {
  FleetControlConnection,
  FleetControlRegistry,
} from '../../src/services/fleet-control-registry.js';
import { serializeControlCommand } from '../../src/services/harness-control-codec.js';
import type { ProbeEgressFrame } from '../../src/schemas/harness-control-protocol.js';

// A complete socks5 inline config — the union requires the two flags a fleet
// probe actually exercises (UDP-associate for QUIC, remote DNS for the exit).
const CONFIG = { host: '203.0.113.9', port: 1080, udp_associate: true, require_remote_dns: true };
const TARGET = { host: 'api.driftstack.dev', port: 443 };

function frame(requestId: string): ProbeEgressFrame {
  return {
    type: 'probeEgress',
    requestId,
    inlineProxyConfig: 'eyJ4IjogMX0=',
    target: TARGET,
  };
}

/** A full, valid probeEgressResult. `opts` overrides the fields a given arm cares
 *  about (node_id / ok / reachable / error), the rest stay measured defaults. */
function resultFrame(
  requestId: string,
  opts: { node_id?: string; ok?: boolean; reachable?: boolean; error?: string | null } = {},
): unknown {
  return {
    type: 'probeEgressResult',
    requestId,
    node_id: opts.node_id ?? 'mac-1',
    ok: opts.ok ?? true,
    reachable: opts.reachable ?? true,
    auth_ok: true,
    udp_associate: true,
    can_route: true,
    latency_ms: 42,
    h2_ok: true,
    quic_ok: true,
    quic_detail: null,
    exit_ip: '198.51.100.7',
    error: opts.error ?? null,
  };
}

describe('ProbeEgressRequestCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the request via the transport + resolves ok WITH the result on a matching probeEgressResult', async () => {
    const sent: ProbeEgressFrame[] = [];
    const transport: ProbeEgressTransport = { send: (r) => sent.push(r) };
    const c = new ProbeEgressRequestCorrelator(transport);
    const rq = randomUUID();
    const p = c.request(frame(rq));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'probeEgress', requestId: rq, target: TARGET });
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame(rq, { reachable: true }));
    const out = await p;
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.result.reachable).toBe(true);
    expect(c.inFlight()).toBe(0);
  });

  it('resolves ok for an UNREACHABLE proxy — a measured dead proxy is a result, not an error', async () => {
    const c = new ProbeEgressRequestCorrelator({ send: () => {} });
    const rq = randomUUID();
    const p = c.request(frame(rq));
    c.onResultFrame(resultFrame(rq, { ok: false, reachable: false, error: null }));
    const out = await p;
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.result.reachable).toBe(false);
  });

  it('resolves error when the result carries an error (the node could not run the probe)', async () => {
    const c = new ProbeEgressRequestCorrelator({ send: () => {} });
    const rq = randomUUID();
    const p = c.request(frame(rq));
    c.onResultFrame(resultFrame(rq, { error: 'no route to proxy' }));
    expect(await p).toEqual({ status: 'error', message: 'no route to proxy' });
  });

  it('times out after PROBE_EGRESS_REQUEST_TIMEOUT_MS when no result arrives', async () => {
    const c = new ProbeEgressRequestCorrelator({ send: () => {} });
    const rq = randomUUID();
    const p = c.request(frame(rq));
    vi.advanceTimersByTime(PROBE_EGRESS_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
    expect(c.inFlight()).toBe(0);
  });

  it('a result for a FOREIGN requestId is a no-op (does not resolve the wrong request)', async () => {
    const c = new ProbeEgressRequestCorrelator({ send: () => {} });
    const rq = randomUUID();
    const p = c.request(frame(rq));
    c.onResultFrame(resultFrame(randomUUID())); // some other request's reply
    expect(c.inFlight()).toBe(1); // still pending — not settled by the foreign frame
    c.onResultFrame(resultFrame(rq));
    expect((await p).status).toBe('ok');
  });

  it('ignores a malformed / non-probeEgressResult frame (stays pending → eventually times out)', async () => {
    const c = new ProbeEgressRequestCorrelator({ send: () => {} });
    const rq = randomUUID();
    const p = c.request(frame(rq));
    // right requestId, wrong type — must not settle it
    c.onResultFrame({ type: 'trimResult', requestId: rq });
    // right type but missing the required node_id — must not settle it
    c.onResultFrame({ type: 'probeEgressResult', requestId: rq, ok: true });
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(PROBE_EGRESS_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('a synchronous transport-send throw resolves error (never rejects, no timer leak)', async () => {
    const c = new ProbeEgressRequestCorrelator({
      send: () => {
        throw new Error('socket not open');
      },
    });
    const out = await c.request(frame(randomUUID()));
    expect(out.status).toBe('error');
    expect(out.status === 'error' && out.message).toMatch(/socket not open/);
    expect(c.inFlight()).toBe(0);
  });

  it('failAll resolves every in-flight request with error', async () => {
    const c = new ProbeEgressRequestCorrelator({ send: () => {} });
    const p1 = c.request(frame(randomUUID()));
    const p2 = c.request(frame(randomUUID()));
    c.failAll('connection dropped');
    expect(await p1).toEqual({ status: 'error', message: 'connection dropped' });
    expect(await p2).toEqual({ status: 'error', message: 'connection dropped' });
    expect(c.inFlight()).toBe(0);
  });
});

describe('FleetControlConnection probe-egress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('probeEgress sends a serialized probeEgress + resolves on the matching probeEgressResult via handleInbound', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const rq = randomUUID();
    const p = conn.probeEgress({ requestId: rq, inlineProxyConfig: CONFIG, target: TARGET });
    expect(sent).toHaveLength(1);
    const wire = JSON.parse(sent[0]!) as { type: string; requestId: string; target: unknown };
    expect(wire.type).toBe('probeEgress');
    expect(wire.requestId).toBe(rq);
    expect(wire.target).toEqual(TARGET);
    conn.handleInbound(JSON.stringify(resultFrame(rq, { node_id: 'node-1' })));
    const out = await p;
    expect(out.status).toBe('ok');
  });

  it('close() fails an in-flight probe-egress (resolves immediately, not at timeout)', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.probeEgress({
      requestId: randomUUID(),
      inlineProxyConfig: CONFIG,
      target: TARGET,
    });
    conn.close('socket closed');
    expect(await p).toEqual({ status: 'error', message: 'socket closed' });
  });

  it('a probeEgressResult for an unknown requestId is accepted + ignored (no crash)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(JSON.stringify(resultFrame(randomUUID(), { node_id: 'node-1' }))),
    ).not.toThrow();
  });
});

describe('FleetControlRegistry probeEgress (node-scoped dispatch)', () => {
  /** Register a node whose socket auto-replies to a probeEgress with a
   *  probeEgressResult carrying `nodeIdInResult` (defaults to the real node id). */
  function nodeThatReplies(
    registry: FleetControlRegistry,
    nodeId: string,
    nodeIdInResult?: string,
  ): FleetControlConnection {
    const conn: FleetControlConnection = registry.register(nodeId, (data) => {
      const f = JSON.parse(data) as { type: string; requestId: string };
      if (f.type === 'probeEgress') {
        conn.handleInbound(
          JSON.stringify(resultFrame(f.requestId, { node_id: nodeIdInResult ?? nodeId })),
        );
      }
    });
    return conn;
  }

  it('dispatches to a connected node and returns its ok result', async () => {
    const registry = new FleetControlRegistry();
    nodeThatReplies(registry, 'mac-1');
    const out = await registry.probeEgress({ inlineProxyConfig: CONFIG, target: TARGET });
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.result.node_id).toBe('mac-1');
  });

  it('returns unavailable when no node is connected', async () => {
    const registry = new FleetControlRegistry();
    const out = await registry.probeEgress({ inlineProxyConfig: CONFIG, target: TARGET });
    expect(out).toEqual({ status: 'unavailable' });
  });

  it('SKIPS a cordoned node — an operator-cordoned node must not receive a probe', async () => {
    const registry = new FleetControlRegistry();
    const conn = nodeThatReplies(registry, 'mac-cordoned');
    conn.sendControlCommand(serializeControlCommand({ command: 'cordon' }));
    // the only node is cordoned → nothing schedulable → unavailable
    const out = await registry.probeEgress({ inlineProxyConfig: CONFIG, target: TARGET });
    expect(out).toEqual({ status: 'unavailable' });
    // uncordon puts it back in rotation
    conn.sendControlCommand(serializeControlCommand({ command: 'uncordon' }));
    const after = await registry.probeEgress({ inlineProxyConfig: CONFIG, target: TARGET });
    expect(after.status).toBe('ok');
  });

  it('ASSERTS provenance — a result whose node_id differs from the dispatched node is an error, never trusted', async () => {
    const registry = new FleetControlRegistry();
    // the node answers with SOMEONE ELSE'S node_id (a misrouted / echoed frame)
    nodeThatReplies(registry, 'mac-1', 'mac-OTHER');
    const out = await registry.probeEgress({ inlineProxyConfig: CONFIG, target: TARGET });
    expect(out.status).toBe('error');
    expect(out.status === 'error' && out.message).toMatch(/node_id did not match/);
  });
});
