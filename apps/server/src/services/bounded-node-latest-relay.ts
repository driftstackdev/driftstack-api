// Bounded latest-state work queue for authenticated harness relays.
//
// FleetControlConnection receives frames synchronously, while ownership checks
// and persistence are asynchronous. A plain per-session promise map preserves
// ordering but lets a compromised node create unlimited concurrent DB work with
// unique fake session ids and unlimited queued work by repeating one id. This
// primitive keeps that receive path fire-and-forget while bounding both axes.

import { HARNESS_HEARTBEAT_MAX_CONCURRENT } from '../schemas/harness-control-protocol.js';

// A real worker cannot own more sessions than it may declare in one heartbeat.
export const BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS = HARNESS_HEARTBEAT_MAX_CONCURRENT;
// Eight concurrent ownership/persistence operations per authenticated node
// leave headroom for legitimate bursts without allowing one node to monopolize
// the database pool.
export const BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT = 8;

interface NodeRelayState<T> {
  /** Newest not-yet-started frame per session. */
  pending: Map<string, T>;
  inFlight: Set<string>;
  overflowReported: boolean;
}

interface BoundedNodeLatestRelayOptions<T> {
  getSessionId(frame: T): string;
  process(frame: T, reportingNodeId: string): Promise<void>;
  onError(args: { error: unknown; frame: T; reportingNodeId: string; sessionId: string }): void;
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
 * simply replace it. Distinct-session overflow is shed before asynchronous work
 * starts, and the caller receives one overflow callback per saturated state
 * lifetime so the mitigation cannot become log amplification.
 */
export function makeBoundedNodeLatestRelay<T>(
  options: BoundedNodeLatestRelayOptions<T>,
): (frame: T, reportingNodeId: string) => void {
  const nodeStates = new Map<string, NodeRelayState<T>>();

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

    // Latest-state semantics bound same-session work to one in-flight operation
    // plus one newest successor, without allowing an older result to win.
    if (state.pending.has(sessionId) || state.inFlight.has(sessionId)) {
      state.pending.set(sessionId, frame);
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
