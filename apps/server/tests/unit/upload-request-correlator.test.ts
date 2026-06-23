// File-control (A3 W2851) — unit tests for the file-UPLOAD correlator + the
// FleetControlConnection upload request/reply path. Pins: an uploadFile goes out as
// JSON; the matching uploadResult (by requestId) resolves `ok` with the opaque
// handle; an `error` result (or a success-shaped result missing the handle) resolves
// `error`; no reply resolves `timeout`; an unknown requestId is a no-op; a
// send-throw / failAll / close resolve `error` (never reject, no timer leak).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UploadRequestCorrelator,
  UPLOAD_REQUEST_TIMEOUT_MS,
  type UploadTransport,
} from '../../src/services/upload-request-correlator.js';
import { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import type { UploadFileRequest } from '../../src/schemas/harness-control-protocol.js';

function req(requestId: string, sessionId = 'agt_x'): UploadFileRequest {
  return {
    type: 'uploadFile',
    requestId,
    sessionId,
    name: 'doc.pdf',
    mime: 'application/pdf',
    dataB64: 'aGVsbG8=', // "hello"
  };
}

function resultFrame(
  requestId: string,
  opts: { handle?: unknown; error?: string; sessionId?: string },
): unknown {
  return {
    type: 'uploadResult',
    requestId,
    sessionId: opts.sessionId ?? 'agt_x',
    ...(opts.handle !== undefined ? { handle: opts.handle } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

const HANDLE = { id: 'up_abc123', name: 'doc.pdf', mime: 'application/pdf', size: 5 };

describe('UploadRequestCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the request via the transport + resolves ok on the matching uploadResult', async () => {
    const sent: UploadFileRequest[] = [];
    const transport: UploadTransport = { send: (r) => sent.push(r) };
    const c = new UploadRequestCorrelator(transport);
    const p = c.request(req('rq_1'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'uploadFile', requestId: 'rq_1', sessionId: 'agt_x' });
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame('rq_1', { handle: HANDLE }));
    expect(await p).toEqual({ status: 'ok', handle: HANDLE });
    expect(c.inFlight()).toBe(0);
  });

  it('resolves error when the result carries an error', async () => {
    const c = new UploadRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', { error: 'file too large (>64MiB)' }));
    expect(await p).toEqual({ status: 'error', message: 'file too large (>64MiB)' });
  });

  it('resolves error when a success-shaped result is missing the handle (never ok with null handle)', async () => {
    const c = new UploadRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_1', {}));
    expect(await p).toEqual({ status: 'error', message: 'upload result missing handle' });
  });

  it('times out after UPLOAD_REQUEST_TIMEOUT_MS when no result arrives', async () => {
    const c = new UploadRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    vi.advanceTimersByTime(UPLOAD_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
    expect(c.inFlight()).toBe(0);
  });

  it('a result for an UNKNOWN requestId is a no-op (does not settle the pending one)', async () => {
    const c = new UploadRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame(resultFrame('rq_OTHER', { handle: HANDLE }));
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame('rq_1', { handle: HANDLE }));
    expect(await p).toEqual({ status: 'ok', handle: HANDLE });
  });

  it('ignores a non-uploadResult frame (stays pending → eventually times out)', async () => {
    const c = new UploadRequestCorrelator({ send: () => {} });
    const p = c.request(req('rq_1'));
    c.onResultFrame({ type: 'cookiesResult', requestId: 'rq_1', sessionId: 'agt_x' });
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(UPLOAD_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('a synchronous transport-send throw resolves error (never rejects, no timer leak)', async () => {
    const c = new UploadRequestCorrelator({
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
    const c = new UploadRequestCorrelator({ send: () => {} });
    const p1 = c.request(req('rq_1'));
    const p2 = c.request(req('rq_2'));
    c.failAll('connection dropped');
    expect(await p1).toEqual({ status: 'error', message: 'connection dropped' });
    expect(await p2).toEqual({ status: 'error', message: 'connection dropped' });
    expect(c.inFlight()).toBe(0);
  });
});

describe('FleetControlConnection file upload (A3 W2851)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('requestUpload sends a serialized uploadFile + resolves on the matching uploadResult via handleInbound', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const p = conn.requestUpload('rq_1', 'agt_x', 'doc.pdf', 'application/pdf', 'aGVsbG8=');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'uploadFile',
      requestId: 'rq_1',
      sessionId: 'agt_x',
      name: 'doc.pdf',
      mime: 'application/pdf',
      dataB64: 'aGVsbG8=',
    });
    conn.handleInbound(
      JSON.stringify({
        type: 'uploadResult',
        requestId: 'rq_1',
        sessionId: 'agt_x',
        handle: HANDLE,
      }),
    );
    expect(await p).toEqual({ status: 'ok', handle: HANDLE });
  });

  it('close() fails an in-flight upload (resolves immediately, not at timeout)', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.requestUpload('rq_1', 'agt_x', 'doc.pdf', 'application/pdf', 'aGVsbG8=');
    conn.close('socket closed');
    expect(await p).toEqual({ status: 'error', message: 'socket closed' });
  });

  it('an uploadResult for an unknown requestId is accepted + ignored (no crash)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'uploadResult',
          requestId: 'rq_unknown',
          sessionId: 'agt_x',
          handle: HANDLE,
        }),
      ),
    ).not.toThrow();
  });
});
