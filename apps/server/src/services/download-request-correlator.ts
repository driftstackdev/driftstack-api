// File-DOWNLOAD correlator (A3 W2856 — the founder's "control files" download).
// The transport-agnostic CORE of GET /v1/agent-sessions/:id/downloads (list) and
// GET /v1/agent-sessions/:id/downloads/:name (fetch): it issues a `listDownloads`
// or `fetchDownload` over the node's LIVE control WSS and awaits the matching
// `downloadsList` / `downloadData`, correlated by `requestId`. A direct mirror of
// UploadRequestCorrelator — one-shot request/reply keyed by requestId.
//
// One DownloadRequestCorrelator handles BOTH operations: every `requestId` is
// exactly one of list-or-fetch, and the reply frame's `type` discriminates which
// outcome to settle. The call NEVER rejects, so the route maps each case to a
// response (ok-list / ok-data / error / timeout). The route handles "no live
// connection / not wired" before ever calling here.

import type { Logger } from '../lib/logger.js';
import {
  DownloadsListResultSchema,
  DownloadDataResultSchema,
  type ListDownloadsRequest,
  type FetchDownloadRequest,
  type DownloadEntry,
} from '../schemas/harness-control-protocol.js';

/** The connection's socket send adapts to this (JSON-stringify → ws.send). */
export interface DownloadTransport {
  /** Fire-and-forget send of a listDownloads; the result returns via onResultFrame. */
  sendList(request: ListDownloadsRequest): void;
  /** Fire-and-forget send of a fetchDownload; the result returns via onResultFrame. */
  sendFetch(request: FetchDownloadRequest): void;
}

/** A jailed-file read (FETCH) can carry up to 64 MiB over the WSS — a generous
 *  bound, but still capped so a silent/wedged node can't hang the GET indefinitely. */
export const DOWNLOAD_REQUEST_TIMEOUT_MS = 30_000;

/** The LIST op returns only file METADATA (name/size/mime), never the 64 MiB body,
 *  so it has no reason to wait the full fetch budget. audit wb1w3015f #5: the list
 *  is what the GUI POLLS every ~2s, so a 30s hold on a merely-slow device stretched
 *  the "waiting for the device…" window to a full 30s per timed-out tick. A 10s cap
 *  (matching the cookies poll) tightens that to a third while still tolerating a
 *  slow-but-live node — a metadata reply that takes >10s means the node is wedged. */
export const DOWNLOAD_LIST_REQUEST_TIMEOUT_MS = 10_000;

/** Uniform outcome — never rejects, so the route maps each case to a status. */
export type DownloadOutcome =
  | { status: 'list'; files: DownloadEntry[] }
  | { status: 'data'; name: string; mime: string | undefined; dataB64: string }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

interface PendingDownload {
  resolve: (outcome: DownloadOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  // The session this request was issued for — stored so onResultFrame can drop a
  // result frame whose sessionId disagrees (cross-session spoof guard). The list +
  // data result schemas both carry sessionId, so a single field covers both ops.
  sessionId: string;
  kind: 'list' | 'fetch';
  /** An oversized fetch reply gets one pre-parse admission attempt. */
  largeResultClaimed: boolean;
}

export class DownloadRequestCorrelator {
  private readonly pending = new Map<string, PendingDownload>();

  constructor(
    private readonly transport: DownloadTransport,
    private readonly logger: Logger | null = null,
  ) {}

  /** Send a listDownloads and resolve when its downloadsList arrives or it times
   *  out. Never rejects. */
  requestList(
    req: ListDownloadsRequest,
    timeoutMs = DOWNLOAD_REQUEST_TIMEOUT_MS,
  ): Promise<DownloadOutcome> {
    return this.dispatch(req.requestId, req.sessionId, 'list', timeoutMs, () =>
      this.transport.sendList(req),
    );
  }

  /** Send a fetchDownload and resolve when its downloadData arrives or it times
   *  out. Never rejects. */
  requestFetch(
    req: FetchDownloadRequest,
    timeoutMs = DOWNLOAD_REQUEST_TIMEOUT_MS,
  ): Promise<DownloadOutcome> {
    return this.dispatch(req.requestId, req.sessionId, 'fetch', timeoutMs, () =>
      this.transport.sendFetch(req),
    );
  }

  private dispatch(
    requestId: string,
    sessionId: string,
    kind: 'list' | 'fetch',
    timeoutMs: number,
    send: () => void,
  ): Promise<DownloadOutcome> {
    return new Promise<DownloadOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(requestId, { status: 'timeout' });
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve,
        timer,
        sessionId,
        kind,
        largeResultClaimed: false,
      });
      try {
        send();
      } catch (err) {
        // socket.send throws synchronously when the WS isn't OPEN (a request racing
        // a remote close). Settle a uniform failure rather than reject — the route
        // contract is that request* never rejects — and settle clears the timer +
        // pending entry so they don't leak.
        this.settle(requestId, {
          status: 'error',
          message: `download request send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /** Feed an inbound frame expected to be a downloadsList OR downloadData. The
   *  `type` literal gates each parse, so a frame matches at most one. Unknown
   *  requestId / neither type → no-op (already settled, or routed elsewhere). */
  onResultFrame(frame: unknown): void {
    const list = DownloadsListResultSchema.safeParse(frame);
    if (list.success) {
      const { requestId, sessionId, files, error } = list.data;
      if (this.isCrossSessionSpoof(requestId, sessionId, 'downloadsList')) return;
      if (error !== undefined) this.settle(requestId, { status: 'error', message: error });
      else this.settle(requestId, { status: 'list', files: files ?? [] });
      return;
    }
    const data = DownloadDataResultSchema.safeParse(frame);
    if (data.success) {
      const { requestId, sessionId, name, mime, dataB64, error } = data.data;
      if (this.isCrossSessionSpoof(requestId, sessionId, 'downloadData')) return;
      if (error !== undefined) {
        this.settle(requestId, { status: 'error', message: error });
        return;
      }
      if (dataB64 === undefined) {
        // Success-shaped but no bytes (forward-compat / malformed) → error so the
        // route never returns ok-data with no payload.
        this.settle(requestId, { status: 'error', message: 'download result missing data' });
        return;
      }
      this.settle(requestId, { status: 'data', name, mime, dataB64 });
      return;
    }
    // Neither downloadsList nor downloadData — caller routes other frame types.
  }

  /** Fail every in-flight request (the control connection dropped). */
  failAll(message: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { status: 'error', message });
    }
  }

  /** Number of in-flight requests (test/inspection helper). */
  inFlight(): number {
    return this.pending.size;
  }

  /**
   * Consume the one oversized-result admission attached to an exact pending
   * fetch. This runs against a bounded lexical header before the WebSocket body
   * becomes a UTF-8 string. A malformed first result cannot be replayed at near
   * the transport cap while the same request waits for its timeout.
   */
  claimLargeFetchResult(requestId: string, sessionId: string): boolean {
    const pending = this.pending.get(requestId);
    if (
      pending === undefined ||
      pending.kind !== 'fetch' ||
      pending.sessionId !== sessionId ||
      pending.largeResultClaimed
    ) {
      return false;
    }
    pending.largeResultClaimed = true;
    return true;
  }

  /**
   * Cross-session spoof guard (audit M1 extended to the correlated reply path):
   * one DownloadRequestCorrelator is owned per-NODE and a node serves many
   * accounts' sessions. Settling by requestId ALONE would let a misrouted/echoed
   * result frame settle another account's pending request with this file's bytes.
   * True (→ DROP, leave the pending entry so the legitimate result or the timeout
   * still resolves it) when the pending entry exists AND its sessionId disagrees
   * with the frame's. Logs one warn on a confirmed mismatch.
   */
  private isCrossSessionSpoof(requestId: string, sessionId: string, frameType: string): boolean {
    const pending = this.pending.get(requestId);
    if (pending === undefined || sessionId === pending.sessionId) return false;
    this.logger?.warn(
      {
        component: 'download-request-correlator',
        frameType,
        requestId,
        frameSessionId: sessionId,
        pendingSessionId: pending.sessionId,
      },
      'dropping download result: sessionId mismatch (cross-session spoof signal)',
    );
    return true;
  }

  private settle(requestId: string, outcome: DownloadOutcome): void {
    const p = this.pending.get(requestId);
    if (p === undefined) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(outcome);
  }
}
