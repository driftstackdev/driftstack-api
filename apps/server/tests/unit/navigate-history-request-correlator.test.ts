// Sim back/forward (A3 W2870) — unit tests for the navigate-history correlator + the
// FleetControlConnection navigate-history request/reply path (the sibling of the
// set-cookies tests). Pins: a navigateHistory goes out as JSON carrying the direction;
// the matching navigateHistoryResult (by requestId) resolves `ok` on ok:true; an
// `error` result (or a success-shaped result without ok:true) resolves `error`; no
// reply resolves `timeout`; an unknown requestId is a no-op; a send-throw / failAll /
// close resolve `error` (never reject, no timer leak).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NavigateHistoryRequestCorrelator,
  NAVIGATE_HISTORY_REQUEST_TIMEOUT_MS,
  type NavigateHistoryTransport,
} from '../../src/services/navigate-history-request-correlator.js';
import { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import type { NavigateHistoryRequest } from '../../src/schemas/harness-control-protocol.js';

function req(
  requestId: string,
  direction: 'back' | 'forward' = 'back',
  sessionId = 'agt_x',
): NavigateHistoryRequest {
  return { type: 'navigateHistory', requestId, sessionId, direction };
}

function resultFrame(
  requestId: string,
  opts: { ok?: boolean; error?: string; sessionId?: string },
): unknown {
  return {
    type: 'navigateHistoryResult',
    requestId,
    sessionId: opts.sessionId ?? 'agt_x',
    ...(opts.ok !== undefined ? { ok: opts.ok } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

describe('NavigateHistoryRequestCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the request via the transport + resolves ok on a matching navigateHistoryResult ok:true', async () => {
    const sent: NavigateHistoryRequest[] = [];
    const transport: NavigateHistoryTransport = { send: (r) => sent.push(r) };
    const c = new NavigateHistoryRequestCorrelator(transport);
    const p = c.request(req('rq_1', 'forward'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'navigateHistory',
      requestId: 'rq_1',
      sessionId: 'agt_x',
      direction: 'forward',
    });
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame('rq_1', { ok: true }));
    expect(await p).toEqual({ status: 'ok' });
    expect(c.inFlight()).toBe(0);
  });

  it('resolves error when the result carries an error', async () => {
    const c = new NavigateHistoryRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', { error: 'no entry in that direction' }));
    expect(await p).toEqual({ status: 'error', message: 'no entry in that direction' });
  });

  it('resolves error when a success-shaped result is not ok:true (never ok on an unconfirmed step)', async () => {
    const c = new NavigateHistoryRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', {}));
    expect(await p).toEqual({
      status: 'error',
      message: 'navigate-history result did not confirm ok',
    });
  });

  it('times out after NAVIGATE_HISTORY_REQUEST_TIMEOUT_MS when no result arrives', async () => {
    const c = new NavigateHistoryRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    vi.advanceTimersByTime(NAVIGATE_HISTORY_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
    expect(c.inFlight()).toBe(0);
  });

  it('a result for an UNKNOWN requestId is a no-op (does not settle the pending one)', async () => {
    const c = new NavigateHistoryRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_OTHER', { ok: true }));
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame('rq_1', { ok: true }));
    expect(await p).toEqual({ status: 'ok' });
  });

  it('DROPS a result whose sessionId mismatches the pending request (cross-session spoof guard)', async () => {
    const warn = vi.fn();
    const c = new NavigateHistoryRequestCorrelator({ send: () => {} }, { warn } as never);
    const p = c.request(req('rq_1', 'back', 'agt_A'));
    // Correct requestId but WRONG sessionId (a misrouted/echoed frame for agt_B) →
    // must NOT settle agt_A's pending step.
    c.onResultFrame(resultFrame('rq_1', { ok: true, sessionId: 'agt_B' }));
    expect(c.inFlight()).toBe(1); // still pending — not settled by the spoofed frame
    expect(warn).toHaveBeenCalledTimes(1);
    // The legitimate result (correct sessionId) still settles it.
    c.onResultFrame(resultFrame('rq_1', { ok: true, sessionId: 'agt_A' }));
    expect(await p).toEqual({ status: 'ok' });
    expect(c.inFlight()).toBe(0);
  });

  it('a mismatched-sessionId result drops, leaving the pending request to TIME OUT', async () => {
    const c = new NavigateHistoryRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1', 'back', 'agt_A'));
    c.onResultFrame(resultFrame('rq_1', { ok: true, sessionId: 'agt_B' }));
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(NAVIGATE_HISTORY_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('ignores a non-navigateHistoryResult frame (stays pending → eventually times out)', async () => {
    const c = new NavigateHistoryRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame({ type: 'setCookiesResult', requestId: 'rq_1', sessionId: 'agt_x' });
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(NAVIGATE_HISTORY_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('a synchronous transport-send throw resolves error (never rejects, no timer leak)', async () => {
    const c = new NavigateHistoryRequestCorrelator({
      send: () => {
        throw new Error('socket not open');
      },
    });
    const out = await c.request(req('rq_1'));
    expect(out.status).toBe('error');
    expect((out as { message: string }).message).toMatch(/socket not open/);
    expect(c.inFlight()).toBe(0);
  });

  it('failAll resolves every in-flight request with error', async () => {
    const c = new NavigateHistoryRequestCorrelator({ send: () => {} });
    const p1 = c.request(req('rq_1'));
    const p2 = c.request(req('rq_2'));
    c.failAll('connection dropped');
    expect(await p1).toEqual({ status: 'error', message: 'connection dropped' });
    expect(await p2).toEqual({ status: 'error', message: 'connection dropped' });
    expect(c.inFlight()).toBe(0);
  });
});

describe('FleetControlConnection navigate-history (sim back/forward)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('navigateHistory sends a serialized navigateHistory + resolves on the matching navigateHistoryResult via handleInbound', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const p = conn.navigateHistory('rq_1', 'agt_x', 'back');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'navigateHistory',
      requestId: 'rq_1',
      sessionId: 'agt_x',
      direction: 'back',
    });
    conn.handleInbound(
      JSON.stringify({
        type: 'navigateHistoryResult',
        requestId: 'rq_1',
        sessionId: 'agt_x',
        ok: true,
      }),
    );
    expect(await p).toEqual({ status: 'ok' });
  });

  it('navigateHistory forwards an optional tabId as the 5th positional arg (after timeoutMs) — omitted when not given', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    // timeoutMs explicitly undefined here, mirroring how the route calls it when
    // the caller wants the default timeout but still needs to reach past it to tabId.
    const p = conn.navigateHistory('rq_1', 'agt_x', 'back', undefined, 'tab_7');
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'navigateHistory',
      requestId: 'rq_1',
      sessionId: 'agt_x',
      direction: 'back',
      tabId: 'tab_7',
    });
    conn.handleInbound(
      JSON.stringify({
        type: 'navigateHistoryResult',
        requestId: 'rq_1',
        sessionId: 'agt_x',
        ok: true,
      }),
    );
    expect(await p).toEqual({ status: 'ok' });
  });

  it('an existing positional timeoutMs caller (no tabId) is unaffected — the 4th arg still means timeoutMs, not tabId', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.navigateHistory('rq_1', 'agt_x', 'back', 1);
    vi.advanceTimersByTime(1);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('close() fails an in-flight navigate-history (resolves immediately, not at timeout)', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.navigateHistory('rq_1', 'agt_x', 'forward');
    conn.close('socket closed');
    expect(await p).toEqual({ status: 'error', message: 'socket closed' });
  });

  it('a navigateHistoryResult for an unknown requestId is accepted + ignored (no crash)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'navigateHistoryResult',
          requestId: 'rq_unknown',
          sessionId: 'agt_x',
          ok: true,
        }),
      ),
    ).not.toThrow();
  });
});
