// Bounded latest-state work queue for authenticated harness relays.
//
// FleetControlConnection receives frames synchronously, while ownership checks
// and persistence are asynchronous. A plain per-session promise map preserves
// ordering but lets a compromised node create unlimited concurrent DB work with
// unique fake session ids and unlimited queued work by repeating one id. This
// primitive keeps that receive path fire-and-forget while bounding both axes.
//
// LATEST-STATE IS THE DEFAULT, NOT THE ONLY SEMANTICS. Collapsing a queued frame
// to its successor is lossless only for a feed whose frame carries the session's
// whole CURRENT state. An APPEND feed (session-network-log-relay) carries
// DIFFERENT rows per frame, so the superseded frame's rows are the only copy
// that ever existed and a 3-frame burst silently loses the middle one. Such a
// caller supplies `coalesce` to fold the two queued frames into one instead;
// every other caller omits it and keeps the replace behaviour unchanged.

import { HARNESS_HEARTBEAT_MAX_CONCURRENT } from '../schemas/harness-control-protocol.js';

// A real worker cannot own more sessions than it may declare in one heartbeat.
export const BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS = HARNESS_HEARTBEAT_MAX_CONCURRENT;
// Eight concurrent ownership/persistence operations per authenticated node
// leave headroom for legitimate bursts without allowing one node to monopolize
// the database pool.
export const BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT = 8;

interface NodeRelayState<T> {
  /** The one not-yet-started frame per session: the newest by default, or the
   *  `coalesce`d fold of the queued frame and its successors. */
  pending: Map<string, T>;
  inFlight: Set<string>;
  overflowReported: boolean;
}

interface BoundedNodeLatestRelayOptions<T> {
  getSessionId(frame: T): string;
  process(frame: T, reportingNodeId: string): Promise<void>;
  /**
   * OPT-IN append-feed merge. OMITTED (the default, and what every latest-state
   * caller uses) keeps the established behaviour: a frame arriving while an
   * older one is still QUEUED replaces it.
   *
   * Supplied, it is called with the OLDER frame first and its result becomes the
   * queued frame — so an append feed loses no rows to a burst. It is called ONLY
   * when a frame is already QUEUED; a frame merely IN FLIGHT is not superseded
   * (its successor simply becomes the first queued frame), so there is nothing
   * to merge in that case.
   *
   * ⛔ CONTRACT — THE MERGE MUST BE BOUNDED IN COST, NOT MERELY IN COUNT, and
   * the caller owns that bound because only the caller knows what a frame costs.
   * One queued frame per session IS this primitive's per-session memory bound;
   * an unbounded concatenation would hand a repeating node exactly the unbounded
   * queued work this file exists to deny. A bound expressed only in ROWS does
   * not close that: N rows each drawn from a separate max-size wire frame is
   * still unbounded bytes in one slot. The caller must also COUNT and LOG
   * whatever its bound discards: a silently-truncated append feed is
   * indistinguishable from a quiet session, which is the failure this option
   * exists to end.
   *
   * It should not throw — see `discardedQueued` on `onError` for what a throw
   * costs and what the caller is handed to report when one happens.
   */
  coalesce?(pending: T, incoming: T): T;
  /**
   * Reports a failure that cost this caller work. `frame` is the frame in hand.
   *
   * `discardedQueued` is present ONLY on the coalesce-failure path, and carries
   * the QUEUED frame the failed fold threw away — the rows a successful fold
   * would have merged into the survivor. ⛔ Without it, a degraded fold destroys
   * the caller's whole queued window with nothing to count: the caller cannot
   * report a drop it was never told about, and that is the exact failure
   * `coalesce` exists to end, reached through `coalesce` itself. A folding
   * caller MUST count these rows in the same register as its other drops.
   */
  onError(args: {
    discardedQueued?: T;
    error: unknown;
    frame: T;
    reportingNodeId: string;
    sessionId: string;
  }): void;
  onOverflow(args: {
    frame: T;
    reportingNodeId: string;
    sessionBudget: number;
    sessionId: string;
  }): void;
}

function activeSessionCount<T>(state: NodeRelayState<T>): number {
  let count = state.inFlight.size;
  for (const sessionId of state.pending.keys()) {
    if (!state.inFlight.has(sessionId)) count += 1;
  }
  return count;
}

/**
 * Build a per-reporting-node queue for a latest-state relay. Repeats for an
 * in-flight session retain exactly one newest successor; repeats still pending
 * simply replace it — or, when the caller supplies `coalesce`, fold into it, so
 * an append feed keeps the rows a replace would discard. Distinct-session
 * overflow is shed before asynchronous work starts, and the caller receives one
 * overflow callback per saturated state lifetime so the mitigation cannot become
 * log amplification.
 */
export function makeBoundedNodeLatestRelay<T>(
  options: BoundedNodeLatestRelayOptions<T>,
): (frame: T, reportingNodeId: string) => void {
  const nodeStates = new Map<string, NodeRelayState<T>>();

  /**
   * The frame to queue when this session already has one queued. Latest-state
   * (return the successor) unless the caller opted into a merge.
   */
  const foldQueued = (queued: T, frame: T, reportingNodeId: string, sessionId: string): T => {
    if (options.coalesce === undefined) return frame;
    try {
      return options.coalesce(queued, frame);
    } catch (error) {
      // A merge throws only when its own bookkeeping does. That must not break
      // the synchronous receive loop, so fall back to the default latest-state
      // behaviour. For the ROWS that is no worse than a relay without
      // `coalesce`; for the REPORTING it is worse, because a folding caller has
      // stopped expecting silent collapse — so hand back the frame this fallback
      // is about to destroy, and the caller can count what it lost.
      try {
        options.onError({ discardedQueued: queued, error, frame, reportingNodeId, sessionId });
      } catch {
        // Observability is best-effort; never re-throw into the receive path.
      }
      return frame;
    }
  };

  const pump = (reportingNodeId: string, state: NodeRelayState<T>): void => {
    while (state.inFlight.size < BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT) {
      let next: [string, T] | undefined;
      for (const entry of state.pending.entries()) {
        if (!state.inFlight.has(entry[0])) {
          next = entry;
          break;
        }
      }
      if (next === undefined) break;

      const [sessionId, frame] = next;
      state.pending.delete(sessionId);
      state.inFlight.add(sessionId);
      // Preserve the established immediate-start contract while normalizing a
      // future/non-async processor's synchronous throw into the same rejected
      // promise path as an asynchronous failure.
      let processing: Promise<void>;
      try {
        processing = Promise.resolve(options.process(frame, reportingNodeId));
      } catch (error) {
        processing = Promise.reject(
          error instanceof Error
            ? error
            : new Error('Bounded relay processor threw a non-Error value.', { cause: error }),
        );
      }
      void processing
        .catch((error: unknown) => {
          try {
            options.onError({ error, frame, reportingNodeId, sessionId });
          } catch {
            // Observability is deliberately best-effort. A throwing logger or
            // callback must not reject this detached chain and strand its slot.
          }
        })
        .finally(() => {
          state.inFlight.delete(sessionId);
          pump(reportingNodeId, state);
          if (state.inFlight.size === 0 && state.pending.size === 0) {
            if (nodeStates.get(reportingNodeId) === state) nodeStates.delete(reportingNodeId);
          }
        });
    }
  };

  return (frame: T, reportingNodeId: string): void => {
    const sessionId = options.getSessionId(frame);
    let state = nodeStates.get(reportingNodeId);
    if (state === undefined) {
      state = { pending: new Map(), inFlight: new Set(), overflowReported: false };
      nodeStates.set(reportingNodeId, state);
    }

    // Same-session work stays bounded to one in-flight operation plus ONE queued
    // frame, without allowing an older result to win. What becomes that queued
    // frame is the feed's choice: the successor alone (latest-state, the
    // default), or the caller's bounded fold of both (an append feed, whose
    // superseded rows exist nowhere else).
    if (state.pending.has(sessionId) || state.inFlight.has(sessionId)) {
      const queued = state.pending.get(sessionId);
      state.pending.set(
        sessionId,
        queued === undefined ? frame : foldQueued(queued, frame, reportingNodeId, sessionId),
      );
      pump(reportingNodeId, state);
      return;
    }

    if (activeSessionCount(state) >= BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS) {
      if (!state.overflowReported) {
        state.overflowReported = true;
        try {
          options.onOverflow({
            frame,
            reportingNodeId,
            sessionBudget: BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS,
            sessionId,
          });
        } catch {
          // Shedding is authoritative even if its one saturated-state observer
          // fails; never turn log/metrics failure into a receive-path throw.
        }
      }
      return;
    }

    state.pending.set(sessionId, frame);
    pump(reportingNodeId, state);
  };
}
