// Profile-TRIM correlator (doc-150 §8.3 — storage cleanup / eviction). The
// transport-agnostic CORE of POST /v1/profiles/:id/trim: it issues a `trimProfile`
// over a HEALTHY node's LIVE control WSS and awaits the matching `trimResult`,
// correlated by `requestId`. A direct mirror of NavigateHistoryRequestCorrelator,
// with two differences: (1) trim is OUT-OF-SESSION, so the cross-spoof guard keys on
// `profileId` (not sessionId — a profile at rest has no live session); (2) the ok
// outcome carries the re-sealed `newSizeBytes` + `bytesReclaimed` the route persists.
//
// Each FleetControlConnection owns one of these (alongside its dispatch + cookies +
// set-cookies + navigate-history + upload + download correlators). The route calls
// `request(...)` and awaits a uniform TrimProfileOutcome — the call NEVER rejects, so
// the route maps each case to a response:
//   ok      → 200 { size_bytes, bytes_reclaimed }   (trim applied + persisted)
//   error   → 200 { status:'error', reason }          (node reported a failure)
//   timeout → 200 { status:'timeout' }                (node didn't reply in time)
// (the route handles "no healthy node / not wired / nothing to trim" before ever
// calling here).
//
// ⛔ STALE (2026-08-26): the `trimProfile` handler has landed and a live node DOES
// emit `trimResult` — schema'd here, dispatched by `fleet-control-registry.ts`.
// Marked rather than deleted: a "never emitted" claim is a deployment fact written
// from a source file, and that wording hid two production defects tonight by making
// a live path read as dead. Original text:
// "Ships gated-inert until A3's harness `trimProfile` handler lands: until then a live
// node never emits `trimResult`, so a wired request resolves `timeout`.

import type { Logger } from '../lib/logger.js';
import {
  TrimProfileResultSchema,
  type TrimProfileRequest,
  type TrimProfileScope,
} from '../schemas/harness-control-protocol.js';

/** The connection's socket send adapts to this (JSON-stringify → ws.send). */
export interface TrimProfileTransport {
  /** Fire-and-forget send of a trimProfile; the result returns via onResultFrame. */
  send(request: TrimProfileRequest): void;
}

/** A trim is a blob→blob transform on the node (open, map-filter, re-seal, PUT) —
 *  it touches R2 twice (GET + PUT) for a blob up to the 256 MiB harness backstop, so
 *  it gets a more generous bound than the 10s in-session reads. Still hard-bounded so
 *  a silent (pre-A3) or wedged node can't hang the POST indefinitely. */
export const TRIM_PROFILE_REQUEST_TIMEOUT_MS = 60_000;

/** Uniform outcome — never rejects, so the route maps each case to a status. */
export type TrimProfileOutcome =
  | {
      status: 'ok';
      newSizeBytes: number;
      bytesReclaimed: number;
      /**
       * W3122 — the scope the node reported applying, or `undefined` from a node
       * predating the field. The route MUST compare this against what it asked
       * for: an old node accepts an unknown `scope`, ignores it, runs a cache
       * trim and replies ok, so without this an `ok` is not evidence the
       * requested op happened.
       */
      appliedScope?: TrimProfileScope;
    }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

interface PendingTrim {
  resolve: (outcome: TrimProfileOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  profileId: string;
}

export class TrimProfileRequestCorrelator {
  private readonly pending = new Map<string, PendingTrim>();

  constructor(
    private readonly transport: TrimProfileTransport,
    private readonly logger: Logger | null = null,
  ) {}

  /** Send a trimProfile and resolve when its trimResult arrives or the timeout
   *  elapses. Never rejects. */
  request(
    req: TrimProfileRequest,
    timeoutMs = TRIM_PROFILE_REQUEST_TIMEOUT_MS,
  ): Promise<TrimProfileOutcome> {
    return new Promise<TrimProfileOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(req.requestId, { status: 'timeout' });
      }, timeoutMs);
      this.pending.set(req.requestId, { resolve, timer, profileId: req.profile_id });
      try {
        this.transport.send(req);
      } catch (err) {
        // socket.send throws synchronously when the WS isn't OPEN (a request
        // racing a remote close). Settle a uniform failure rather than letting
        // this Promise reject — the route contract is that request() never rejects
        // — and so the timer + pending entry don't leak (settle clears them).
        this.settle(req.requestId, {
          status: 'error',
          message: `trim request send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /** Feed an inbound frame expected to be a trimResult. Non-trimResult frames are
   *  ignored; an unknown requestId is a no-op (already settled). */
  onResultFrame(frame: unknown): void {
    const parsed = TrimProfileResultSchema.safeParse(frame);
    if (!parsed.success) return; // not a trimResult — caller routes other types
    const { requestId, profileId, ok, newSizeBytes, bytesReclaimed, error, scope } = parsed.data;
    // Cross-account spoof guard (audit M1 extended to the correlated reply path):
    // one FleetControlConnection is per-NODE and a node serves many accounts'
    // profiles. Settling by requestId ALONE would let a misrouted/echoed result
    // frame settle another account's pending trim with a foreign size. If the
    // pending entry's profileId disagrees with the frame's, DROP it — leave the
    // pending entry so the legitimate result or the timeout still resolves it.
    const pending = this.pending.get(requestId);
    if (pending !== undefined && profileId !== pending.profileId) {
      this.logger?.warn(
        {
          component: 'trim-profile-request-correlator',
          requestId,
          frameProfileId: profileId,
          pendingProfileId: pending.profileId,
        },
        'dropping trimResult: profileId mismatch (cross-account spoof signal)',
      );
      return;
    }
    if (error !== undefined) {
      this.settle(requestId, { status: 'error', message: error });
      return;
    }
    if (ok !== true || newSizeBytes === undefined) {
      // Success-shaped but not ok:true, or missing the re-sealed size (forward-compat
      // / malformed) → treat as error so the route never persists an unconfirmed size.
      this.settle(requestId, {
        status: 'error',
        message: 'trim result did not confirm ok with a new size',
      });
      return;
    }
    // A node that confirms ok but omits bytesReclaimed → default 0 (no overage freed),
    // so the "freed N MB" UI degrades to "freed 0 B" rather than NaN.
    this.settle(requestId, {
      status: 'ok',
      newSizeBytes,
      bytesReclaimed: bytesReclaimed ?? 0,
      // Passed through UNJUDGED. Whether an absent echo is acceptable depends on
      // whether the caller asked for a scope at all, which only the route knows.
      ...(scope !== undefined ? { appliedScope: scope } : {}),
    });
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

  private settle(requestId: string, outcome: TrimProfileOutcome): void {
    const p = this.pending.get(requestId);
    if (p === undefined) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(outcome);
  }
}
