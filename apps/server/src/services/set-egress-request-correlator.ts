// Live EGRESS swap correlator (A3 P-17). The transport-agnostic CORE of moving a
// RUNNING session onto a different exit: it issues a `setEgress` over the node's
// LIVE control WSS and awaits the matching `setEgressResult`, correlated by
// `requestId`. A direct mirror of SetCookiesRequestCorrelator — one-shot
// request/reply keyed by requestId — with one difference that is the whole point
// of the frame, described under `ok_apply_point_unconfirmed` below.
//
// Each FleetControlConnection owns one of these (alongside its dispatch + cookies
// + upload + download + trim correlators). The route calls `request(...)` and
// awaits a uniform SetEgressOutcome — the call NEVER rejects, so the route maps
// each case to a response.
//
// ⛔ THIS HALF CANNOT BE VERIFIED END TO END, AND ITS TESTS ARE NOT EVIDENCE THAT
// A SWAP WORKS. The WebKit driver is an 81-line stub whose every method throws,
// and the fleet control plane is flag-gated, so `setEgress` is built against a
// dispatch path that is not live. Green tests here prove the CP speaks the frame
// correctly and nothing about what a node does with it. Written down because a
// later reader finding full coverage would otherwise reasonably conclude the
// feature ships.

import type { Logger } from '../lib/logger.js';
import {
  SetEgressResultSchema,
  type SetEgressRequest,
} from '../schemas/harness-control-protocol.js';

/** The connection's socket send adapts to this (JSON-stringify → ws.send). */
export interface SetEgressTransport {
  /** Fire-and-forget send of a setEgress; the result returns via onResultFrame. */
  send(request: SetEgressRequest): void;
}

/** A swap is a one-shot network reconfiguration. Bounded more generously than a
 *  cookie write because the node may have to establish a fresh SOCKS5 hop —
 *  including a DNS round trip through it — before it can confirm anything. */
export const SET_EGRESS_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Uniform outcome — never rejects, so the route maps each case to a status.
 *
 * ⛔ `ok_apply_point_unconfirmed` is not a courtesy status. A node predating the
 * `applyPoint` field accepts the request, DROPS the field (a synthesized Codable
 * decoder ignores unknown keys), does whatever it does by default, and replies
 * `ok`. Reporting that as a plain success would tell the caller they had bought a
 * deferred swap while the node may have reset every in-flight connection — which
 * is the one outcome the frame exists to make deliberate. The absence of an echo
 * is information, and it is the only information the CP gets about it.
 */
export type SetEgressOutcome =
  | { status: 'applied' }
  | { status: 'accepted_pending_navigation' }
  | { status: 'ok_apply_point_unconfirmed' }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

/**
 * ⚠️ OPEN CONTRACT QUESTION, deliberately not answered here.
 *
 * A session that never navigates again never applies a `next_navigation` swap —
 * and since that is the default, an idle session is the COMMON case, not the edge
 * one. The customer's mental model after calling this is "I changed the egress".
 * Either the pending state is surfaced somewhere the GUI can show it, or it
 * expires and says so; what it must not do is sit invisibly forever while the
 * caller believes it took. Choosing between those is a product decision, and
 * inventing an expiry here would settle it silently.
 */

interface PendingSetEgress {
  resolve: (outcome: SetEgressOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
}

export class SetEgressRequestCorrelator {
  private readonly pending = new Map<string, PendingSetEgress>();

  constructor(
    private readonly transport: SetEgressTransport,
    private readonly logger: Logger | null = null,
  ) {}

  /** Send a setEgress and resolve when its setEgressResult arrives or the timeout
   *  elapses. Never rejects. */
  request(
    req: SetEgressRequest,
    timeoutMs = SET_EGRESS_REQUEST_TIMEOUT_MS,
  ): Promise<SetEgressOutcome> {
    return new Promise<SetEgressOutcome>((resolve) => {
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
          message: `set-egress request send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /** Feed an inbound frame expected to be a setEgressResult. Non-setEgressResult
   *  frames are ignored; an unknown requestId is a no-op (already settled). */
  onResultFrame(frame: unknown): void {
    const parsed = SetEgressResultSchema.safeParse(frame);
    if (!parsed.success) return; // not a setEgressResult — caller routes other types
    const { requestId, sessionId, ok, error, applyPoint } = parsed.data;
    // Cross-session spoof guard, as on every other correlated reply path: one
    // FleetControlConnection is per-NODE and a node serves many accounts'
    // sessions. Settling by requestId ALONE would let a misrouted/echoed result
    // frame settle another account's pending request. If the pending entry's
    // sessionId disagrees with the frame's, DROP it — leave the pending entry so
    // the legitimate result or the timeout still resolves it.
    const pending = this.pending.get(requestId);
    if (pending !== undefined && sessionId !== pending.sessionId) {
      this.logger?.warn(
        {
          component: 'set-egress-request-correlator',
          requestId,
          frameSessionId: sessionId,
          pendingSessionId: pending.sessionId,
        },
        'dropping setEgressResult: sessionId mismatch (cross-session spoof signal)',
      );
      return;
    }
    if (error !== undefined) {
      this.settle(requestId, { status: 'error', message: error });
      return;
    }
    if (ok !== true) {
      // Success-shaped but not ok:true (forward-compat / malformed) → treat as error
      // so the route never reports a swap that was not confirmed.
      this.settle(requestId, { status: 'error', message: 'set-egress result did not confirm ok' });
      return;
    }
    if (applyPoint === undefined) {
      this.settle(requestId, { status: 'ok_apply_point_unconfirmed' });
      return;
    }
    // ACCEPTED is not APPLIED. A deferred swap has changed nothing yet, and a
    // caller polling "did my swap take?" must be able to tell that from a silent
    // failure — collapsing both into one success is what makes an unapplied swap
    // indistinguishable from a broken one.
    this.settle(
      requestId,
      applyPoint === 'immediate'
        ? { status: 'applied' }
        : { status: 'accepted_pending_navigation' },
    );
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

  private settle(requestId: string, outcome: SetEgressOutcome): void {
    const p = this.pending.get(requestId);
    if (p === undefined) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(outcome);
  }
}
