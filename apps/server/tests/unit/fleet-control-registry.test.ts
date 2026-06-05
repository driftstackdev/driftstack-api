// Increment-2 — unit tests for FleetControlConnection + FleetControlRegistry:
// the /v1/fleet/events route's connection-mgmt + inbound-frame-routing core.
// Pins: dispatch frames go out as JSON; the flat HarnessOutbound `{type,…}`
// frames route to the correlator (intentResult → resolve; errored sessionStatus
// → fast-fail); junk frames are ignored (no crash); reconnect replaces + fails
// the prior connection.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FleetControlConnection,
  FleetControlRegistry,
} from '../../src/services/fleet-control-registry.js';
import { encodeWireData } from '../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

function dispatch(intentId: string, sessionId = 'ses_x'): IntentDispatch {
  return {
    type: 'intentDispatch',
    sessionId,
    intentId,
    intentName: 'navigate',
    inputParams: encodeWireData({ url: 'https://x' }),
  };
}

function intentResultFrame(intentId: string, sessionId = 'ses_x'): string {
  return JSON.stringify({
    type: 'intentResult',
    sessionId,
    intentId,
    success: true,
    durationMs: 5,
    outputData: encodeWireData({ url: 'https://x' }),
  });
}

describe('FleetControlConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serialises outbound dispatches to JSON via the socket send', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const p = conn.correlator.dispatch(dispatch('int_1'));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'intentDispatch', intentId: 'int_1' });
    // resolve so no timer lingers
    conn.handleInbound(intentResultFrame('int_1'));
    expect((await p).success).toBe(true);
  });

  it('routes an inbound intentResult frame → resolves the matching dispatch', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.correlator.dispatch(dispatch('int_1'));
    conn.handleInbound(intentResultFrame('int_1'));
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.outputData).toEqual({ url: 'https://x' });
  });

  it('routes an errored sessionStatus (intent_dispatch_no_session) → fast-fails the in-flight dispatch', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.correlator.dispatch(dispatch('int_1', 'ses_x'));
    conn.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'ses_x',
        status: 'errored',
        timestamp: '2026-06-05T00:00:00Z',
        detail: 'intent_dispatch_no_session: navigate',
      }),
    );
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('intent_session_not_established');
  });

  it('ignores malformed JSON / unknown type / non-errored sessionStatus / heartbeat (no crash, dispatch stays pending)', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.correlator.dispatch(dispatch('int_1'));
    expect(() => conn.handleInbound('{not json')).not.toThrow();
    expect(() => conn.handleInbound(JSON.stringify({ type: 'teleport', foo: 1 }))).not.toThrow();
    expect(() => conn.handleInbound(JSON.stringify({ type: 'heartbeat', ts: 1 }))).not.toThrow();
    conn.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'ses_x',
        status: 'running',
        timestamp: 't',
      }),
    );
    expect(conn.correlator.inFlight()).toBe(1); // still pending — none of the above settled it
    conn.handleInbound(intentResultFrame('int_1')); // now resolve
    expect((await p).success).toBe(true);
  });

  it('close() fails every in-flight dispatch', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.correlator.dispatch(dispatch('int_1'));
    conn.close('socket closed');
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.errorMessage).toBe('socket closed');
  });
});

describe('FleetControlRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('register / get / unregister by nodeId', () => {
    const reg = new FleetControlRegistry();
    const conn = reg.register('node-1', () => {});
    expect(reg.get('node-1')).toBe(conn);
    expect(reg.size()).toBe(1);
    reg.unregister('node-1', 'closed');
    expect(reg.get('node-1')).toBeUndefined();
    expect(reg.size()).toBe(0);
  });

  it('reconnect by the same nodeId replaces the prior connection + fails its in-flight dispatches', async () => {
    const reg = new FleetControlRegistry();
    const first = reg.register('node-1', () => {});
    const p = first.correlator.dispatch(dispatch('int_1'));
    const second = reg.register('node-1', () => {}); // reconnect
    expect(reg.size()).toBe(1);
    expect(reg.get('node-1')).toBe(second);
    const r = await p; // the prior connection's dispatch was failed by the replace
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/replaced by a new connection/);
  });

  it('unregister is idempotent (double-close is a no-op)', () => {
    const reg = new FleetControlRegistry();
    reg.register('node-1', () => {});
    reg.unregister('node-1', 'closed');
    expect(() => reg.unregister('node-1', 'closed again')).not.toThrow();
    expect(reg.size()).toBe(0);
  });
});
