// Cookie-import — unit tests for the set-cookies correlator + the
// FleetControlConnection set-cookies request/reply path (the write-twin of the
// upload tests). Pins: a setCookies goes out as JSON carrying the jar; the matching
// setCookiesResult (by requestId) resolves `ok` on ok:true; an `error` result (or a
// success-shaped result without ok:true) resolves `error`; no reply resolves
// `timeout`; an unknown requestId is a no-op; a send-throw / failAll / close resolve
// `error` (never reject, no timer leak).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SetCookiesRequestCorrelator,
  SET_COOKIES_REQUEST_TIMEOUT_MS,
  type SetCookiesTransport,
} from '../../src/services/set-cookies-request-correlator.js';
import { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import type { SetCookiesRequest, Cookie } from '../../src/schemas/harness-control-protocol.js';

const JAR: Cookie[] = [
  {
    domain: '.example.com',
    name: 'sid',
    value: 'abc',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
  { domain: 'example.com', name: 'pref', value: 'dark' },
];

function req(requestId: string, sessionId = 'agt_x'): SetCookiesRequest {
  return { type: 'setCookies', requestId, sessionId, cookies: JAR };
}

function resultFrame(
  requestId: string,
  opts: { ok?: boolean; error?: string; sessionId?: string },
): unknown {
  return {
    type: 'setCookiesResult',
    requestId,
    sessionId: opts.sessionId ?? 'agt_x',
    ...(opts.ok !== undefined ? { ok: opts.ok } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

describe('SetCookiesRequestCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the request via the transport + resolves ok on a matching setCookiesResult ok:true', async () => {
    const sent: SetCookiesRequest[] = [];
    const transport: SetCookiesTransport = { send: (r) => sent.push(r) };
    const c = new SetCookiesRequestCorrelator(transport);
    const p = c.request(req('rq_1'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'setCookies', requestId: 'rq_1', sessionId: 'agt_x' });
    expect(sent[0]!.cookies).toEqual(JAR);
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame('rq_1', { ok: true }));
    expect(await p).toEqual({ status: 'ok' });
    expect(c.inFlight()).toBe(0);
  });

  it('resolves error when the result carries an error', async () => {
    const c = new SetCookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', { error: 'session not found' }));
    expect(await p).toEqual({ status: 'error', message: 'session not found' });
  });

  it('resolves error when a success-shaped result is not ok:true (never ok on an unconfirmed write)', async () => {
    const c = new SetCookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', {}));
    expect(await p).toEqual({ status: 'error', message: 'set-cookies result did not confirm ok' });
  });

  it('times out after SET_COOKIES_REQUEST_TIMEOUT_MS when no result arrives', async () => {
    const c = new SetCookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    vi.advanceTimersByTime(SET_COOKIES_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
    expect(c.inFlight()).toBe(0);
  });

  it('a result for an UNKNOWN requestId is a no-op (does not settle the pending one)', async () => {
    const c = new SetCookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_OTHER', { ok: true }));
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame('rq_1', { ok: true }));
    expect(await p).toEqual({ status: 'ok' });
  });

  it('ignores a non-setCookiesResult frame (stays pending → eventually times out)', async () => {
    const c = new SetCookiesRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame({ type: 'cookiesResult', requestId: 'rq_1', sessionId: 'agt_x' });
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(SET_COOKIES_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('a synchronous transport-send throw resolves error (never rejects, no timer leak)', async () => {
    const c = new SetCookiesRequestCorrelator({
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
    const c = new SetCookiesRequestCorrelator({ send: () => {} });
    const p1 = c.request(req('rq_1'));
    const p2 = c.request(req('rq_2'));
    c.failAll('connection dropped');
    expect(await p1).toEqual({ status: 'error', message: 'connection dropped' });
    expect(await p2).toEqual({ status: 'error', message: 'connection dropped' });
    expect(c.inFlight()).toBe(0);
  });
});

describe('FleetControlConnection set-cookies (cookie-import)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('setCookies sends a serialized setCookies + resolves on the matching setCookiesResult via handleInbound', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const p = conn.setCookies('rq_1', 'agt_x', JAR);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'setCookies',
      requestId: 'rq_1',
      sessionId: 'agt_x',
      cookies: JAR,
    });
    conn.handleInbound(
      JSON.stringify({
        type: 'setCookiesResult',
        requestId: 'rq_1',
        sessionId: 'agt_x',
        ok: true,
      }),
    );
    expect(await p).toEqual({ status: 'ok' });
  });

  it('close() fails an in-flight set-cookies (resolves immediately, not at timeout)', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.setCookies('rq_1', 'agt_x', JAR);
    conn.close('socket closed');
    expect(await p).toEqual({ status: 'error', message: 'socket closed' });
  });

  it('a setCookiesResult for an unknown requestId is accepted + ignored (no crash)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'setCookiesResult',
          requestId: 'rq_unknown',
          sessionId: 'agt_x',
          ok: true,
        }),
      ),
    ).not.toThrow();
  });
});
