// History-NAVIGATION correlator (sim browser back/forward — A3 W2870). The
// transport-agnostic CORE of POST /v1/agent-sessions/:id/history: it issues a
// `navigateHistory` over the node's LIVE control WSS and awaits the matching
// `navigateHistoryResult`, correlated by `requestId`. A direct mirror of
// SetCookiesRequestCorrelator — one-shot request/reply keyed by requestId.
//
// Each FleetControlConnection owns one of these (alongside its dispatch + cookies
// + set-cookies + upload + download correlators). The route calls `request(...)` and
// awaits a uniform NavigateHistoryOutcome — the call NEVER rejects, so the route maps
// each case to a response:
//   ok      → 200 { status:'ok' }                     (step applied)
//   error   → 200 { status:'error', reason }           (node reported a failure)
//   timeout → 200 { status:'timeout' }                 (node didn't reply in time)
// (the route handles "no live connection / not wired" before ever calling here).
//
// ⛔ STALE (2026-08-26): the `navigateHistory` handler has landed and a live node
// DOES emit `navigateHistoryResult` — schema'd here, dispatched by
// `fleet-control-registry.ts`. Marked rather than deleted: a "never emitted"
// claim is a deployment fact written from a source file, and that wording hid two
// production defects tonight by making a live path read as dead. Original text:
// "Ships gated-inert until A3's harness `navigateHistory` WD-extension lands: until then
// a live node never emits `navigateHistoryResult`, so a wired request resolves `timeout`
// — which the GUI renders as the "ships with the next device update" state.

import type { Logger } from '../lib/logger.js';
import {
  NavigateHistoryResultSchema,
  type NavigateHistoryRequest,
} from '../schemas/harness-control-protocol.js';

/** The connection's socket send adapts to this (JSON-stringify → ws.send). */
export interface NavigateHistoryTransport {
  /** Fire-and-forget send of a navigateHistory; the result returns via onResultFrame. */
  send(request: NavigateHistoryRequest): void;
}

/** A history step is a one-shot back-forward-list move — generous but bounded so a
 *  silent (pre-A3) or wedged node can't hang the POST indefinitely. Matches the
 *  set-cookies bound (a history step is comparably cheap). */
export const NAVIGATE_HISTORY_REQUEST_TIMEOUT_MS = 10_000;

/** Uniform outcome — never rejects, so the route maps each case to a status. */
export type NavigateHistoryOutcome =
  | { status: 'ok' }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

interface PendingNavigateHistory {
  resolve: (outcome: NavigateHistoryOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
}

export class NavigateHistoryRequestCorrelator {
  private readonly pending = new Map<string, PendingNavigateHistory>();

  constructor(
    private readonly transport: NavigateHistoryTransport,
    private readonly logger: Logger | null = null,
  ) {}

  /** Send a navigateHistory and resolve when its navigateHistoryResult arrives or the
   *  timeout elapses. Never rejects. */
  request(
    req: NavigateHistoryRequest,
    timeoutMs = NAVIGATE_HISTORY_REQUEST_TIMEOUT_MS,
  ): Promise<NavigateHistoryOutcome> {
    return new Promise<NavigateHistoryOutcome>((resolve) => {
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
          message: `navigate-history request send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /** Feed an inbound frame expected to be a navigateHistoryResult. Non-navigateHistory
   *  Result frames are ignored; an unknown requestId is a no-op (already settled). */
  onResultFrame(frame: unknown): void {
    const parsed = NavigateHistoryResultSchema.safeParse(frame);
    if (!parsed.success) return; // not a navigateHistoryResult — caller routes other types
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
          component: 'navigate-history-request-correlator',
          requestId,
          frameSessionId: sessionId,
          pendingSessionId: pending.sessionId,
        },
        'dropping navigateHistoryResult: sessionId mismatch (cross-session spoof signal)',
      );
      return;
    }
    if (error !== undefined) {
      this.settle(requestId, { status: 'error', message: error });
      return;
    }
    if (ok !== true) {
      // Success-shaped but not ok:true (forward-compat / malformed) → treat as error
      // so the route never returns status:'ok' on an unconfirmed step.
      this.settle(requestId, {
        status: 'error',
        message: 'navigate-history result did not confirm ok',
      });
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

  private settle(requestId: string, outcome: NavigateHistoryOutcome): void {
    const p = this.pending.get(requestId);
    if (p === undefined) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(outcome);
  }
}
