// Node-scoped egress-probe correlator (T-1). The transport-agnostic CORE of the
// fleet-vantage proxy test: it issues a `probeEgress` over a fleet node's LIVE
// control WSS and awaits the matching `probeEgressResult`, correlated by
// `requestId`. A direct mirror of SetCookiesRequestCorrelator — one-shot
// request/reply keyed by requestId — with one deliberate difference: this op is
// NODE-SCOPED (it measures an exit WITHOUT a live session), so there is no
// `sessionId` and therefore no cross-session spoof guard here. Provenance is
// checked one layer up: the registry asserts the result's `node_id` equals the
// node it dispatched to.
//
// Each FleetControlConnection owns one of these (alongside its dispatch + cookies
// + set-cookies + set-egress + navigate-history + upload + download + trim
// correlators). The registry calls `request(...)` and awaits a uniform
// ProbeEgressOutcome — the call NEVER rejects, so the caller maps each case:
//   ok      → the node measured the exit (reachable or not — an unreachable proxy
//             is a RESULT, carried in `result`, not an error)
//   error   → the node could not run the probe, or the send failed
//   timeout → the node didn't reply in time
// (the route/registry handles "no connected node" before ever calling here).

import type { Logger } from '../lib/logger.js';
import {
  ProbeEgressResultSchema,
  type ProbeEgressFrame,
  type ProbeEgressResult,
} from '../schemas/harness-control-protocol.js';

/** The connection's socket send adapts to this (JSON-stringify → ws.send). */
export interface ProbeEgressTransport {
  /** Fire-and-forget send of a probeEgress; the result returns via onResultFrame. */
  send(request: ProbeEgressFrame): void;
}

/** A node-side egress probe dials the proxy, routes to the target, and measures
 *  H2/QUIC — several round-trips through a possibly-slow exit. Generous but
 *  bounded so a silent or wedged node can't hang the awaiting request forever. */
export const PROBE_EGRESS_REQUEST_TIMEOUT_MS = 15_000;

/** Uniform outcome — never rejects, so the caller maps each case to a response. */
export type ProbeEgressOutcome =
  | { status: 'ok'; result: ProbeEgressResult }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

interface PendingProbeEgress {
  resolve: (outcome: ProbeEgressOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ProbeEgressRequestCorrelator {
  private readonly pending = new Map<string, PendingProbeEgress>();

  constructor(
    private readonly transport: ProbeEgressTransport,
    private readonly logger: Logger | null = null,
  ) {}

  /** Send a probeEgress and resolve when its probeEgressResult arrives or the
   *  timeout elapses. Never rejects. */
  request(
    req: ProbeEgressFrame,
    timeoutMs = PROBE_EGRESS_REQUEST_TIMEOUT_MS,
  ): Promise<ProbeEgressOutcome> {
    return new Promise<ProbeEgressOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(req.requestId, { status: 'timeout' });
      }, timeoutMs);
      this.pending.set(req.requestId, { resolve, timer });
      try {
        this.transport.send(req);
      } catch (err) {
        // socket.send throws synchronously when the WS isn't OPEN (a request
        // racing a remote close). Settle a uniform failure rather than letting
        // this Promise reject — the caller contract is that request() never
        // rejects — and so the timer + pending entry don't leak (settle clears them).
        this.settle(req.requestId, {
          status: 'error',
          message: `probe-egress request send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /** Feed an inbound frame expected to be a probeEgressResult. Non-probeEgressResult
   *  frames are ignored; an unknown requestId is a no-op (already settled). */
  onResultFrame(frame: unknown): void {
    const parsed = ProbeEgressResultSchema.safeParse(frame);
    if (!parsed.success) return; // not a probeEgressResult — caller routes other types
    const result = parsed.data;
    // Foreign-request guard: an unknown/stale requestId is a no-op. Unlike the
    // session correlators there is no sessionId to cross-check — the connection
    // is per-node and the registry re-checks `node_id` provenance on the ok path.
    if (result.error !== null) {
      // The node could not RUN the probe (not a measured "unreachable" — that is a
      // result with error:null). Surface it as an error outcome. Logged once per
      // occurrence: a node that cannot run the probe is the signal an operator
      // wants, and it is far rarer than a routine reachable/unreachable verdict.
      this.logger?.warn(
        { component: 'probe-egress-request-correlator', requestId: result.requestId },
        'probeEgressResult carried an error: the node could not run the probe',
      );
      this.settle(result.requestId, { status: 'error', message: result.error });
      return;
    }
    // A measurement — reachable or not. `ok:false` with `reachable:false` is a
    // valid verdict about a dead proxy, NOT an error, so it resolves ok and the
    // caller reads the fields. Carrying the whole frame lets the registry assert
    // `node_id` provenance and the route return the node-measured shape.
    this.settle(result.requestId, { status: 'ok', result });
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

  private settle(requestId: string, outcome: ProbeEgressOutcome): void {
    const p = this.pending.get(requestId);
    if (p === undefined) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(outcome);
  }
}
