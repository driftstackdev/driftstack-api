// Profile-trim (doc-150 §8.3) — unit tests for the trim correlator + the
// FleetControlConnection trim request/reply path (the OUT-OF-SESSION sibling of the
// navigate-history tests). Pins: a trimProfile goes out as JSON carrying the JIT
// crypto envelope; the matching trimResult (by requestId) resolves `ok` with
// newSizeBytes + bytesReclaimed on ok:true; an `error` result (or a success-shaped
// result without ok:true / without a size) resolves `error`; no reply resolves
// `timeout`; an unknown requestId is a no-op; the cross-account guard keys on
// profileId (NOT sessionId — trim is out of session); a send-throw / failAll / close
// resolve `error` (never reject, no timer leak).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TrimProfileRequestCorrelator,
  TRIM_PROFILE_REQUEST_TIMEOUT_MS,
  type TrimProfileTransport,
} from '../../src/services/trim-profile-request-correlator.js';
import { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import type { TrimProfileRequest } from '../../src/schemas/harness-control-protocol.js';

function req(requestId: string, profileId = 'prof_x'): TrimProfileRequest {
  // The wire request carries snake_case payload keys (profile_id / sealed_blob_url /
  // sealed_blob_put_url), mirroring SessionAssign.ProfileInfo; only type + requestId
  // are camelCase (the CP→node envelope convention).
  return {
    type: 'trimProfile',
    requestId,
    profile_id: profileId,
    dek: 'ZGVrLWJhc2U2NA==',
    sealed_blob_url: 'https://r2/get?sig=1',
    sealed_blob_put_url: 'https://r2/put?sig=1',
  };
}

function resultFrame(
  requestId: string,
  opts: {
    ok?: boolean;
    newSizeBytes?: number;
    bytesReclaimed?: number;
    error?: string;
    profileId?: string;
  },
): unknown {
  return {
    type: 'trimResult',
    requestId,
    profileId: opts.profileId ?? 'prof_x',
    ...(opts.ok !== undefined ? { ok: opts.ok } : {}),
    ...(opts.newSizeBytes !== undefined ? { newSizeBytes: opts.newSizeBytes } : {}),
    ...(opts.bytesReclaimed !== undefined ? { bytesReclaimed: opts.bytesReclaimed } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

describe('TrimProfileRequestCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the request via the transport + resolves ok with the new size + reclaimed bytes', async () => {
    const sent: TrimProfileRequest[] = [];
    const transport: TrimProfileTransport = { send: (r) => sent.push(r) };
    const c = new TrimProfileRequestCorrelator(transport);
    const p = c.request(req('rq_1'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'trimProfile',
      requestId: 'rq_1',
      profile_id: 'prof_x',
      sealed_blob_put_url: 'https://r2/put?sig=1',
    });
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame('rq_1', { ok: true, newSizeBytes: 4000, bytesReclaimed: 6000 }));
    expect(await p).toEqual({ status: 'ok', newSizeBytes: 4000, bytesReclaimed: 6000 });
    expect(c.inFlight()).toBe(0);
  });

  it('defaults bytesReclaimed to 0 when a confirmed ok omits it', async () => {
    const c = new TrimProfileRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', { ok: true, newSizeBytes: 4000 }));
    expect(await p).toEqual({ status: 'ok', newSizeBytes: 4000, bytesReclaimed: 0 });
  });

  it('resolves error when the result carries an error', async () => {
    const c = new TrimProfileRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', { error: 'open failed: bad dek' }));
    expect(await p).toEqual({ status: 'error', message: 'open failed: bad dek' });
  });

  it('resolves error when a success-shaped result is not ok:true (never persist an unconfirmed trim)', async () => {
    const c = new TrimProfileRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', { newSizeBytes: 4000 }));
    expect(await p).toEqual({
      status: 'error',
      message: 'trim result did not confirm ok with a new size',
    });
  });

  it('resolves error when ok:true but newSizeBytes is missing (no size to persist)', async () => {
    const c = new TrimProfileRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', { ok: true }));
    expect(await p).toEqual({
      status: 'error',
      message: 'trim result did not confirm ok with a new size',
    });
  });

  it('times out after TRIM_PROFILE_REQUEST_TIMEOUT_MS when no result arrives', async () => {
    const c = new TrimProfileRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    vi.advanceTimersByTime(TRIM_PROFILE_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
    expect(c.inFlight()).toBe(0);
  });

  it('a result for an UNKNOWN requestId is a no-op (does not settle the pending one)', async () => {
    const c = new TrimProfileRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_OTHER', { ok: true, newSizeBytes: 1 }));
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame('rq_1', { ok: true, newSizeBytes: 5 }));
    expect(await p).toEqual({ status: 'ok', newSizeBytes: 5, bytesReclaimed: 0 });
  });

  it('DROPS a result whose profileId mismatches the pending request (cross-account spoof guard)', async () => {
    const warn = vi.fn();
    const c = new TrimProfileRequestCorrelator({ send: () => {} }, { warn } as never);
    const p = c.request(req('rq_1', 'prof_A'));
    // Correct requestId but WRONG profileId (a misrouted/echoed frame for prof_B) →
    // must NOT settle prof_A's pending trim.
    c.onResultFrame(resultFrame('rq_1', { ok: true, newSizeBytes: 1, profileId: 'prof_B' }));
    expect(c.inFlight()).toBe(1); // still pending — not settled by the spoofed frame
    expect(warn).toHaveBeenCalledTimes(1);
    // The legitimate result (correct profileId) still settles it.
    c.onResultFrame(resultFrame('rq_1', { ok: true, newSizeBytes: 9, profileId: 'prof_A' }));
    expect(await p).toEqual({ status: 'ok', newSizeBytes: 9, bytesReclaimed: 0 });
    expect(c.inFlight()).toBe(0);
  });

  it('a mismatched-profileId result drops, leaving the pending request to TIME OUT', async () => {
    const c = new TrimProfileRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1', 'prof_A'));
    c.onResultFrame(resultFrame('rq_1', { ok: true, newSizeBytes: 1, profileId: 'prof_B' }));
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(TRIM_PROFILE_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('ignores a non-trimResult frame (stays pending → eventually times out)', async () => {
    const c = new TrimProfileRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame({ type: 'navigateHistoryResult', requestId: 'rq_1', sessionId: 'agt_x' });
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(TRIM_PROFILE_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('a synchronous transport-send throw resolves error (never rejects, no timer leak)', async () => {
    const c = new TrimProfileRequestCorrelator({
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
    const c = new TrimProfileRequestCorrelator({ send: () => {} });
    const p1 = c.request(req('rq_1'));
    const p2 = c.request(req('rq_2'));
    c.failAll('connection dropped');
    expect(await p1).toEqual({ status: 'error', message: 'connection dropped' });
    expect(await p2).toEqual({ status: 'error', message: 'connection dropped' });
    expect(c.inFlight()).toBe(0);
  });
});

describe('FleetControlConnection trim (out-of-session profile eviction)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('requestTrim sends a serialized trimProfile + resolves on the matching trimResult via handleInbound', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const p = conn.requestTrim({
      requestId: 'rq_1',
      profileId: 'prof_x',
      dek: 'ZGVrLWJhc2U2NA==',
      sealedBlobURL: 'https://r2/get?sig=1',
      sealedBlobPutURL: 'https://r2/put?sig=1',
    });
    expect(sent).toHaveLength(1);
    // requestTrim takes camelCase args, but the JSON that goes out on the wire carries
    // snake_case payload keys the harness's Swift Codable decoder expects.
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'trimProfile',
      requestId: 'rq_1',
      profile_id: 'prof_x',
      dek: 'ZGVrLWJhc2U2NA==',
      sealed_blob_url: 'https://r2/get?sig=1',
      sealed_blob_put_url: 'https://r2/put?sig=1',
    });
    conn.handleInbound(
      JSON.stringify({
        type: 'trimResult',
        requestId: 'rq_1',
        profileId: 'prof_x',
        ok: true,
        newSizeBytes: 4000,
        bytesReclaimed: 6000,
      }),
    );
    expect(await p).toEqual({ status: 'ok', newSizeBytes: 4000, bytesReclaimed: 6000 });
  });

  it('close() fails an in-flight trim (resolves immediately, not at timeout)', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.requestTrim({
      requestId: 'rq_1',
      profileId: 'prof_x',
      dek: 'ZGVrLWJhc2U2NA==',
      sealedBlobURL: 'https://r2/get?sig=1',
      sealedBlobPutURL: 'https://r2/put?sig=1',
    });
    conn.close('socket closed');
    expect(await p).toEqual({ status: 'error', message: 'socket closed' });
  });

  it('a trimResult for an unknown requestId is accepted + ignored (no crash)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'trimResult',
          requestId: 'rq_unknown',
          profileId: 'prof_x',
          ok: true,
          newSizeBytes: 1,
        }),
      ),
    ).not.toThrow();
  });
});
