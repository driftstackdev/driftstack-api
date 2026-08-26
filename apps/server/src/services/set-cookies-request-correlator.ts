// Cookie-IMPORT correlator (the write-twin of CookiesRequestCorrelator). The
// transport-agnostic CORE of POST /v1/agent-sessions/:id/cookies/set: it issues a
// `setCookies` over the node's LIVE control WSS and awaits the matching
// `setCookiesResult`, correlated by `requestId`. A direct mirror of
// UploadRequestCorrelator — one-shot request/reply keyed by requestId.
//
// Each FleetControlConnection owns one of these (alongside its dispatch + cookies
// + upload + download correlators). The route calls `request(...)` and awaits a
// uniform SetCookiesOutcome — the call NEVER rejects, so the route maps each case
// to a response:
//   ok      → 200 { status:'ok' }                     (full write)
//   error   → 200 { status:'error', reason }           (node reported a failure)
//   timeout → 200 { status:'timeout' }                 (node didn't reply in time)
// (the route handles "no live connection / not wired" before ever calling here).
//
// ⛔ STALE (2026-08-26): this said the harness `setCookies` WD-extension had not
// landed and that a live node NEVER emits `setCookiesResult`, so a wired request
// resolves `timeout`. It has landed and the node emits the result; the frame is
// schema'd here and dispatched by `fleet-control-registry.ts`.
//
// ⚠️ Kept and marked rather than deleted, because this class of sentence did real
// damage tonight. A "never emitted / handler pending" claim is a DEPLOYMENT fact
// written from a source file, where neither the binary nor the env is visible —
// and two production defects survived weeks behind exactly that wording, because
// anyone checking whether the path was reachable read the comment and stopped.
// The original text, for the record:
// "Ships gated-inert until A3's harness `setCookies` WD-extension lands: until then
// a live node never emits `setCookiesResult`, so a wired request resolves `timeout`
// — which the GUI renders as the "ships with the next device update" state.

import type { Logger } from '../lib/logger.js';
import {
  SetCookiesResultSchema,
  type SetCookiesRequest,
} from '../schemas/harness-control-protocol.js';

/** The connection's socket send adapts to this (JSON-stringify → ws.send). */
export interface SetCookiesTransport {
  /** Fire-and-forget send of a setCookies; the result returns via onResultFrame. */
  send(request: SetCookiesRequest): void;
}

/** A cookie write is a one-shot jar mutation — generous but bounded so a silent
 *  (pre-A3) or wedged node can't hang the POST indefinitely. Matches the cookies
 *  PULL bound (a write is comparably cheap). */
export const SET_COOKIES_REQUEST_TIMEOUT_MS = 10_000;

/** Uniform outcome — never rejects, so the route maps each case to a status. */
export type SetCookiesOutcome =
  | { status: 'ok' }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

interface PendingSetCookies {
  resolve: (outcome: SetCookiesOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
}

export class SetCookiesRequestCorrelator {
  private readonly pending = new Map<string, PendingSetCookies>();

  constructor(
    private readonly transport: SetCookiesTransport,
    private readonly logger: Logger | null = null,
  ) {}

  /** Send a setCookies and resolve when its setCookiesResult arrives or the
   *  timeout elapses. Never rejects. */
  request(
    req: SetCookiesRequest,
    timeoutMs = SET_COOKIES_REQUEST_TIMEOUT_MS,
  ): Promise<SetCookiesOutcome> {
    return new Promise<SetCookiesOutcome>((resolve) => {
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
          message: `set-cookies request send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /** Feed an inbound frame expected to be a setCookiesResult. Non-setCookiesResult
   *  frames are ignored; an unknown requestId is a no-op (already settled). */
  onResultFrame(frame: unknown): void {
    const parsed = SetCookiesResultSchema.safeParse(frame);
    if (!parsed.success) return; // not a setCookiesResult — caller routes other types
    const { requestId, sessionId, ok, error } = parsed.data;
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
          component: 'set-cookies-request-correlator',
          requestId,
          frameSessionId: sessionId,
          pendingSessionId: pending.sessionId,
        },
        'dropping setCookiesResult: sessionId mismatch (cross-session spoof signal)',
      );
      return;
    }
    if (error !== undefined) {
      this.settle(requestId, { status: 'error', message: error });
      return;
    }
    if (ok !== true) {
      // Success-shaped but not ok:true (forward-compat / malformed) → treat as error
      // so the route never returns status:'ok' on an unconfirmed write.
      this.settle(requestId, { status: 'error', message: 'set-cookies result did not confirm ok' });
      return;
    }
    this.settle(requestId, { status: 'ok' });
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

  private settle(requestId: string, outcome: SetCookiesOutcome): void {
    const p = this.pending.get(requestId);
    if (p === undefined) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(outcome);
  }
}
