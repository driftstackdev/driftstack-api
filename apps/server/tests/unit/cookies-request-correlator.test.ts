// Founder #48 — unit tests for the cookies PULL correlator + the
// FleetControlConnection cookies request/reply path. Pins: a cookiesRequest goes
// out as JSON; the matching cookiesResult (by requestId) resolves `ok` with the
// jar; an `error` result resolves `error`; no reply resolves `timeout`; an
// unknown requestId is a no-op; a send-throw / failAll / close resolve `error`
// (never reject, no timer leak).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CookiesRequestCorrelator,
  COOKIES_REQUEST_TIMEOUT_MS,
  type CookiesTransport,
} from '../../src/services/cookies-request-correlator.js';
import { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import type { CookiesRequest } from '../../src/schemas/harness-control-protocol.js';

function req(requestId: string, sessionId = 'agt_x'): CookiesRequest {
  return { type: 'cookiesRequest', requestId, sessionId };
}

function resultFrame(
  requestId: string,
  opts: { cookies?: unknown[]; error?: string; sessionId?: string },
): unknown {
  return {
    type: 'cookiesResult',
    requestId,
    sessionId: opts.sessionId ?? 'agt_x',
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

describe('CookiesRequestCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the request via the transport + resolves ok on the matching cookiesResult', async () => {
    const sent: CookiesRequest[] = [];
    const transport: CookiesTransport = { send: (r) => sent.push(r) };
    const c = new CookiesRequestCorrelator(transport);
    const p = c.request(req('rq_1'));
    expect(sent).toEqual([{ type: 'cookiesRequest', requestId: 'rq_1', sessionId: 'agt_x' }]);
    expect(c.inFlight()).toBe(1);
    const cookies = [
      { domain: '.example.com', name: 'sid', value: 'abc', httpOnly: true, sameSite: 'Lax' },
    ];
    c.onResultFrame(resultFrame('rq_1', { cookies }));
    expect(await p).toEqual({ status: 'ok', cookies });
    expect(c.inFlight()).toBe(0);
  });

  it('resolves ok with [] when the result has no cookies array (empty jar / forward-compat)', async () => {
    const c = new CookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', {}));
    expect(await p).toEqual({ status: 'ok', cookies: [] });
  });

  it('resolves error when the result carries an error', async () => {
    const c = new CookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', { error: 'no such session' }));
    expect(await p).toEqual({ status: 'error', message: 'no such session' });
  });

  it('times out after COOKIES_REQUEST_TIMEOUT_MS when no result arrives', async () => {
    const c = new CookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    vi.advanceTimersByTime(COOKIES_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
    expect(c.inFlight()).toBe(0);
  });

  it('a result for an UNKNOWN requestId is a no-op (does not settle the pending one)', async () => {
    const c = new CookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_OTHER', { cookies: [] }));
    expect(c.inFlight()).toBe(1); // still pending
    c.onResultFrame(resultFrame('rq_1', { cookies: [] }));
    expect(await p).toEqual({ status: 'ok', cookies: [] });
  });

  it('DROPS a result whose sessionId mismatches the pending request (cross-session spoof guard)', async () => {
    const warn = vi.fn();
    const c = new CookiesRequestCorrelator({ send: () => {} }, { warn } as never);
    const p = c.request(req('rq_1', 'agt_A'));
    // Correct requestId but WRONG sessionId (a misrouted/echoed frame for agt_B) →
    // must NOT settle agt_A's pending request; it stays in-flight.
    c.onResultFrame(
      resultFrame('rq_1', {
        cookies: [{ domain: '.x.com', name: 'leak', value: '1' }],
        sessionId: 'agt_B',
      }),
    );
    expect(c.inFlight()).toBe(1); // still pending — not settled by the spoofed frame
    expect(warn).toHaveBeenCalledTimes(1);
    // The legitimate result (correct sessionId) still settles it.
    const cookies = [{ domain: '.x.com', name: 'a', value: '1' }];
    c.onResultFrame(resultFrame('rq_1', { cookies, sessionId: 'agt_A' }));
    expect(await p).toEqual({ status: 'ok', cookies });
    expect(c.inFlight()).toBe(0);
  });

  it('a mismatched-sessionId result drops, leaving the pending request to TIME OUT', async () => {
    const c = new CookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1', 'agt_A'));
    c.onResultFrame(resultFrame('rq_1', { cookies: [], sessionId: 'agt_B' }));
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(COOKIES_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('ignores a non-cookiesResult frame (stays pending → eventually times out)', async () => {
    const c = new CookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame({ type: 'intentResult', intentId: 'x' });
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(COOKIES_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('a synchronous transport-send throw resolves error (never rejects, no timer leak)', async () => {
    const c = new CookiesRequestCorrelator({
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
    const c = new CookiesRequestCorrelator({ send: () => {} });
    const p1 = c.request(req('rq_1'));
    const p2 = c.request(req('rq_2'));
    c.failAll('connection dropped');
    expect(await p1).toEqual({ status: 'error', message: 'connection dropped' });
    expect(await p2).toEqual({ status: 'error', message: 'connection dropped' });
    expect(c.inFlight()).toBe(0);
  });
});

describe('FleetControlConnection cookies pull (founder #48)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('requestCookies sends a serialized cookiesRequest + resolves on the matching cookiesResult via handleInbound', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const p = conn.requestCookies('rq_1', 'agt_x');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'cookiesRequest',
      requestId: 'rq_1',
      sessionId: 'agt_x',
    });
    const cookies = [{ domain: '.x.com', name: 'a', value: '1' }];
    conn.handleInbound(
      JSON.stringify({ type: 'cookiesResult', requestId: 'rq_1', sessionId: 'agt_x', cookies }),
    );
    expect(await p).toEqual({ status: 'ok', cookies });
  });

  it('close() fails an in-flight cookies pull (resolves immediately, not at timeout)', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.requestCookies('rq_1', 'agt_x');
    conn.close('socket closed');
    expect(await p).toEqual({ status: 'error', message: 'socket closed' });
  });

  it('a cookiesResult for an unknown requestId is accepted + ignored (no crash)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'cookiesResult',
          requestId: 'rq_unknown',
          sessionId: 'agt_x',
          cookies: [],
        }),
      ),
    ).not.toThrow();
  });
});
