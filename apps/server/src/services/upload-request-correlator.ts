// File-UPLOAD correlator (A3 W2851 — the founder's "control files" upload).
// The transport-agnostic CORE of POST /v1/agent-sessions/:id/files: it issues an
// `uploadFile` over the node's LIVE control WSS and awaits the matching
// `uploadResult`, correlated by `requestId`. A direct mirror of
// CookiesRequestCorrelator — one-shot request/reply keyed by requestId.
//
// Each FleetControlConnection owns one of these (alongside its dispatch + cookies
// correlators). The route calls `request(...)` and awaits a uniform UploadOutcome
// — the call NEVER rejects, so the route maps each case to a response:
//   ok      → 200 { handle, status:'ok' }
//   error   → 200 { handle:null, status:'error', reason }   (node reported a failure)
//   timeout → 200 { handle:null, status:'timeout' }         (node didn't reply in time)
// (the route handles "no live connection / not wired" before ever calling here).

import type { Logger } from '../lib/logger.js';
import {
  UploadResultSchema,
  type UploadFileRequest,
  type UploadHandle,
} from '../schemas/harness-control-protocol.js';

/** The connection's socket send adapts to this (JSON-stringify → ws.send). */
export interface UploadTransport {
  /** Fire-and-forget send of an uploadFile; the result returns via onResultFrame. */
  send(request: UploadFileRequest): void;
}

/** An upload can carry up to 64 MiB over the WSS + a jail write — a more generous
 *  bound than the cookies read, but still capped so a silent/wedged node can't hang
 *  the POST indefinitely. */
export const UPLOAD_REQUEST_TIMEOUT_MS = 30_000;

/** Uniform outcome — never rejects, so the route maps each case to a status. */
export type UploadOutcome =
  | { status: 'ok'; handle: UploadHandle }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

interface PendingUpload {
  resolve: (outcome: UploadOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
}

export class UploadRequestCorrelator {
  private readonly pending = new Map<string, PendingUpload>();

  constructor(
    private readonly transport: UploadTransport,
    private readonly logger: Logger | null = null,
  ) {}

  /** Send an uploadFile and resolve when its uploadResult arrives or the timeout
   *  elapses. Never rejects. */
  request(req: UploadFileRequest, timeoutMs = UPLOAD_REQUEST_TIMEOUT_MS): Promise<UploadOutcome> {
    return new Promise<UploadOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(req.requestId, { status: 'timeout' });
      }, timeoutMs);
      this.pending.set(req.requestId, { resolve, timer, sessionId: req.sessionId });
      try {
        this.transport.send(req);
      } catch (err) {
        // socket.send throws synchronously when the WS isn't OPEN (a request
        // racing a remote close). Settle a uniform failure rather than letting
        // this Promise reject — the route contract is that request() never rejects
        // — and so the timer + pending entry don't leak (settle clears them).
        this.settle(req.requestId, {
          status: 'error',
          message: `upload request send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /** Feed an inbound frame expected to be an uploadResult. Non-uploadResult frames
   *  are ignored; an unknown requestId is a no-op (already settled). */
  onResultFrame(frame: unknown): void {
    const parsed = UploadResultSchema.safeParse(frame);
    if (!parsed.success) return; // not an uploadResult — caller routes other types
    const { requestId, sessionId, handle, error } = parsed.data;
    // Cross-session spoof guard (audit M1 extended to the correlated reply path):
    // one FleetControlConnection is per-NODE and a node serves many accounts'
    // sessions. Settling by requestId ALONE would let a misrouted/echoed result
    // frame settle another account's pending request. If the pending entry's
    // sessionId disagrees with the frame's, DROP it — leave the pending entry so
    // the legitimate result or the timeout still resolves it.
    const pending = this.pending.get(requestId);
    if (pending !== undefined && sessionId !== pending.sessionId) {
      this.logger?.warn(
        {
          component: 'upload-request-correlator',
          requestId,
          frameSessionId: sessionId,
          pendingSessionId: pending.sessionId,
        },
        'dropping uploadResult: sessionId mismatch (cross-session spoof signal)',
      );
      return;
    }
    if (error !== undefined) {
      this.settle(requestId, { status: 'error', message: error });
      return;
    }
    if (handle === undefined) {
      // Success-shaped but no handle (forward-compat / malformed) → treat as error
      // so the route never returns status:'ok' with a null handle.
      this.settle(requestId, { status: 'error', message: 'upload result missing handle' });
      return;
    }
    this.settle(requestId, { status: 'ok', handle });
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

  private settle(requestId: string, outcome: UploadOutcome): void {
    const p = this.pending.get(requestId);
    if (p === undefined) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(outcome);
  }
}
