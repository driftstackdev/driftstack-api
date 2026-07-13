// File-control (A3 W2856) — unit tests for the file-DOWNLOAD correlator + the
// FleetControlConnection download list/fetch request/reply path (the sibling of the
// upload tests). One correlator handles BOTH ops: the reply frame `type`
// discriminates which outcome to settle. Pins: a listDownloads/fetchDownload goes
// out as JSON; the matching downloadsList/downloadData (by requestId) resolves
// list/data; an `error` result resolves `error`; no reply resolves `timeout`; an
// unknown requestId is a no-op; a result whose sessionId mismatches the pending
// request is DROPPED (cross-session spoof guard); a send-throw / failAll / close
// resolve `error` (never reject, no timer leak).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DownloadRequestCorrelator,
  DOWNLOAD_REQUEST_TIMEOUT_MS,
  type DownloadTransport,
} from '../../src/services/download-request-correlator.js';
import { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import { FLEET_INBOUND_LARGE_FRAME_THRESHOLD_BYTES } from '../../src/services/fleet-inbound-frame-gate.js';
import type {
  ListDownloadsRequest,
  FetchDownloadRequest,
} from '../../src/schemas/harness-control-protocol.js';

function listReq(requestId: string, sessionId = 'agt_x'): ListDownloadsRequest {
  return { type: 'listDownloads', requestId, sessionId };
}

function fetchReq(requestId: string, sessionId = 'agt_x'): FetchDownloadRequest {
  return { type: 'fetchDownload', requestId, sessionId, name: 'report.pdf' };
}

function listResultFrame(
  requestId: string,
  opts: { files?: unknown[]; error?: string; sessionId?: string },
): unknown {
  return {
    type: 'downloadsList',
    requestId,
    sessionId: opts.sessionId ?? 'agt_x',
    ...(opts.files !== undefined ? { files: opts.files } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

function dataResultFrame(
  requestId: string,
  opts: { name?: string; mime?: string; dataB64?: string; error?: string; sessionId?: string },
): unknown {
  return {
    type: 'downloadData',
    requestId,
    sessionId: opts.sessionId ?? 'agt_x',
    name: opts.name ?? 'report.pdf',
    ...(opts.mime !== undefined ? { mime: opts.mime } : {}),
    ...(opts.dataB64 !== undefined ? { dataB64: opts.dataB64 } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

const FILES = [{ name: 'report.pdf', size: 5, mime: 'application/pdf' }];

describe('DownloadRequestCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the list request + resolves list on the matching downloadsList', async () => {
    const sent: ListDownloadsRequest[] = [];
    const transport: DownloadTransport = { sendList: (r) => sent.push(r), sendFetch: () => {} };
    const c = new DownloadRequestCorrelator(transport);
    const p = c.requestList(listReq('rq_1'));
    expect(sent).toEqual([{ type: 'listDownloads', requestId: 'rq_1', sessionId: 'agt_x' }]);
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(listResultFrame('rq_1', { files: FILES }));
    expect(await p).toEqual({ status: 'list', files: FILES });
    expect(c.inFlight()).toBe(0);
  });

  it('sends the fetch request + resolves data on the matching downloadData', async () => {
    const sent: FetchDownloadRequest[] = [];
    const transport: DownloadTransport = { sendList: () => {}, sendFetch: (r) => sent.push(r) };
    const c = new DownloadRequestCorrelator(transport);
    const p = c.requestFetch(fetchReq('rq_1'));
    expect(sent).toHaveLength(1);
    c.onResultFrame(
      dataResultFrame('rq_1', { name: 'report.pdf', mime: 'application/pdf', dataB64: 'aGVsbG8=' }),
    );
    expect(await p).toEqual({
      status: 'data',
      name: 'report.pdf',
      mime: 'application/pdf',
      dataB64: 'aGVsbG8=',
    });
  });

  it('resolves error when a list result carries an error', async () => {
    const c = new DownloadRequestCorrelator({ sendList: () => {}, sendFetch: () => {} });
    const p = c.requestList(listReq('rq_1'));
    c.onResultFrame(listResultFrame('rq_1', { error: 'no such session' }));
    expect(await p).toEqual({ status: 'error', message: 'no such session' });
  });

  it('times out after DOWNLOAD_REQUEST_TIMEOUT_MS when no result arrives', async () => {
    const c = new DownloadRequestCorrelator({ sendList: () => {}, sendFetch: () => {} });
    const p = c.requestList(listReq('rq_1'));
    vi.advanceTimersByTime(DOWNLOAD_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
    expect(c.inFlight()).toBe(0);
  });

  it('a result for an UNKNOWN requestId is a no-op (does not settle the pending one)', async () => {
    const c = new DownloadRequestCorrelator({ sendList: () => {}, sendFetch: () => {} });
    const p = c.requestList(listReq('rq_1'));
    c.onResultFrame(listResultFrame('rq_OTHER', { files: [] }));
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(listResultFrame('rq_1', { files: [] }));
    expect(await p).toEqual({ status: 'list', files: [] });
  });

  it('DROPS a downloadsList whose sessionId mismatches the pending request (cross-session spoof guard)', async () => {
    const warn = vi.fn();
    const c = new DownloadRequestCorrelator({ sendList: () => {}, sendFetch: () => {} }, {
      warn,
    } as never);
    const p = c.requestList(listReq('rq_1', 'agt_A'));
    // Correct requestId but WRONG sessionId (a misrouted/echoed frame for agt_B) →
    // must NOT settle agt_A's pending request with another session's file list.
    c.onResultFrame(listResultFrame('rq_1', { files: FILES, sessionId: 'agt_B' }));
    expect(c.inFlight()).toBe(1); // still pending — not settled by the spoofed frame
    expect(warn).toHaveBeenCalledTimes(1);
    // The legitimate result (correct sessionId) still settles it.
    c.onResultFrame(listResultFrame('rq_1', { files: FILES, sessionId: 'agt_A' }));
    expect(await p).toEqual({ status: 'list', files: FILES });
    expect(c.inFlight()).toBe(0);
  });

  it('DROPS a downloadData whose sessionId mismatches the pending request (cross-session spoof guard)', async () => {
    const warn = vi.fn();
    const c = new DownloadRequestCorrelator({ sendList: () => {}, sendFetch: () => {} }, {
      warn,
    } as never);
    const p = c.requestFetch(fetchReq('rq_1', 'agt_A'));
    // Correct requestId but WRONG sessionId → must NOT settle agt_A with another
    // session's file BYTES.
    c.onResultFrame(dataResultFrame('rq_1', { dataB64: 'bGVhaw==', sessionId: 'agt_B' }));
    expect(c.inFlight()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    c.onResultFrame(dataResultFrame('rq_1', { dataB64: 'aGVsbG8=', sessionId: 'agt_A' }));
    expect(await p).toEqual({
      status: 'data',
      name: 'report.pdf',
      mime: undefined,
      dataB64: 'aGVsbG8=',
    });
  });

  it('a mismatched-sessionId result drops, leaving the pending request to TIME OUT', async () => {
    const c = new DownloadRequestCorrelator({ sendList: () => {}, sendFetch: () => {} });
    const p = c.requestList(listReq('rq_1', 'agt_A'));
    c.onResultFrame(listResultFrame('rq_1', { files: FILES, sessionId: 'agt_B' }));
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(DOWNLOAD_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('a synchronous transport-send throw resolves error (never rejects, no timer leak)', async () => {
    const c = new DownloadRequestCorrelator({
      sendList: () => {
        throw new Error('socket not open');
      },
      sendFetch: () => {},
    });
    const out = await c.requestList(listReq('rq_1'));
    expect(out.status).toBe('error');
    expect((out as { message: string }).message).toMatch(/socket not open/);
    expect(c.inFlight()).toBe(0);
  });

  it('failAll resolves every in-flight request with error', async () => {
    const c = new DownloadRequestCorrelator({ sendList: () => {}, sendFetch: () => {} });
    const p1 = c.requestList(listReq('rq_1'));
    const p2 = c.requestFetch(fetchReq('rq_2'));
    c.failAll('connection dropped');
    expect(await p1).toEqual({ status: 'error', message: 'connection dropped' });
    expect(await p2).toEqual({ status: 'error', message: 'connection dropped' });
    expect(c.inFlight()).toBe(0);
  });

  it('grants exactly one oversized-result claim to the exact pending fetch only', async () => {
    const c = new DownloadRequestCorrelator({ sendList: () => {}, sendFetch: () => {} });
    const list = c.requestList(listReq('rq_list', 'agt_A'));
    const fetch = c.requestFetch(fetchReq('rq_fetch', 'agt_A'));

    expect(c.claimLargeFetchResult('rq_list', 'agt_A')).toBe(false);
    expect(c.claimLargeFetchResult('rq_fetch', 'agt_B')).toBe(false);
    expect(c.claimLargeFetchResult('rq_unknown', 'agt_A')).toBe(false);
    expect(c.claimLargeFetchResult('rq_fetch', 'agt_A')).toBe(true);
    expect(c.claimLargeFetchResult('rq_fetch', 'agt_A')).toBe(false);

    c.failAll('done');
    await expect(list).resolves.toEqual({ status: 'error', message: 'done' });
    await expect(fetch).resolves.toEqual({ status: 'error', message: 'done' });
  });
});

describe('FleetControlConnection downloads (A3 W2856)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('requestDownloadList sends a serialized listDownloads + resolves on the matching downloadsList', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const p = conn.requestDownloadList('rq_1', 'agt_x');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'listDownloads',
      requestId: 'rq_1',
      sessionId: 'agt_x',
    });
    conn.handleInbound(
      JSON.stringify({
        type: 'downloadsList',
        requestId: 'rq_1',
        sessionId: 'agt_x',
        files: FILES,
      }),
    );
    expect(await p).toEqual({ status: 'list', files: FILES });
  });

  it('DROPS a downloadData whose sessionId mismatches the pending request via handleInbound', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.requestDownloadFetch('rq_1', 'agt_A', 'report.pdf');
    // A misrouted/echoed frame for a DIFFERENT session must not settle this request.
    conn.handleInbound(
      JSON.stringify({
        type: 'downloadData',
        requestId: 'rq_1',
        sessionId: 'agt_B',
        name: 'report.pdf',
        dataB64: 'bGVhaw==',
      }),
    );
    // Still in-flight → resolves via timeout, never with the spoofed bytes.
    vi.advanceTimersByTime(DOWNLOAD_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'timeout' });
  });

  it('close() fails an in-flight download (resolves immediately, not at timeout)', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.requestDownloadList('rq_1', 'agt_x');
    conn.close('socket closed');
    expect(await p).toEqual({ status: 'error', message: 'socket closed' });
  });

  it('parses one exact correlated large download and rejects unsolicited/replayed large frames', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const dataB64Length = 4 * Math.ceil((FLEET_INBOUND_LARGE_FRAME_THRESHOLD_BYTES + 1024) / 4);
    const raw = Buffer.from(
      JSON.stringify({
        type: 'downloadData',
        requestId: 'rq_large',
        sessionId: 'agt_A',
        name: 'large.bin',
        dataB64: 'A'.repeat(dataB64Length),
      }),
    );
    expect(raw.byteLength).toBeGreaterThan(FLEET_INBOUND_LARGE_FRAME_THRESHOLD_BYTES);

    expect(conn.handleInboundBytes(raw)).toBe('uncorrelated-large-frame');
    const pending = conn.requestDownloadFetch('rq_large', 'agt_A', 'large.bin');
    expect(conn.handleInboundBytes(raw)).toBe('accepted');
    await expect(pending).resolves.toMatchObject({
      status: 'data',
      name: 'large.bin',
    });
    expect(conn.handleInboundBytes(raw)).toBe('uncorrelated-large-frame');
  });
});
