// T-9 — ownership-gated live networkRequests consumer.
//
// Like the pageState / capabilityReport relays, this writes only to an in-memory
// store, but it must STILL verify the reporting node owns the session before
// appending — otherwise a buggy/rogue node could inject fabricated request rows
// (with an arbitrary protocol/URL) into another customer's live Network pane
// (the customer reads their OWN session's log, so a spoofed append reaches them).
//
// It mirrors makeSessionPageStateRelay / makeSessionCapabilityReportRelay
// exactly: the ownership check + write run on the shared bounded-node-latest
// work queue (fire-and-forget off the synchronous receive loop, per-node
// bounded). Same-session frames that arrive while one is in flight collapse to
// the newest — the established latest-state semantics of that primitive; the log
// is best-effort + ephemeral (the fork re-emits as the session keeps browsing),
// so that bound is acceptable here. A failed lookup is logged, never thrown.

import type { Logger } from '../lib/logger.js';
import type {
  NetworkRequestsFrame,
  NetworkRequestEntry,
} from '../schemas/harness-control-protocol.js';
import {
  NETWORK_LOG_ENTRY_MAX_BYTES,
  NETWORK_LOG_MAX_ENTRIES_PER_FRAME,
} from '../schemas/harness-control-protocol.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';
import type { SessionNetworkLogStore } from './session-network-log-store.js';

/** Narrow structural dep — the real agent-sessions repo satisfies this. */
interface NetworkLogRelaySessions {
  get(id: string): Promise<{ nodeId: string | null; status: string } | null>;
}

/**
 * Build the gated `onNetworkRequests` consumer wired into FleetControlRegistry.
 * Looks up the session's owning node and appends only for an exact, still-live
 * owner match. Unknown sessions, NULL-node sessions, a foreign reporting node,
 * and closed sessions all fail closed: none can have a legitimate live fleet
 * producer, so retaining their attacker-controlled entries only creates memory
 * pressure without a customer-visible use.
 *
 * Each accepted frame is defensively re-bounded before it reaches the ring:
 *   - entries larger than NETWORK_LOG_ENTRY_MAX_BYTES (serialized) are dropped,
 *     so a max-length URL + max-length metadata cannot compose an oversized row;
 *   - at most NETWORK_LOG_MAX_ENTRIES_PER_FRAME entries are kept (the schema
 *     admits up to the higher HARD ceiling so an over-cap frame is TRUNCATED
 *     here rather than rejected at parse and dropped whole).
 */
export function makeSessionNetworkLogRelay(
  agentSessions: NetworkLogRelaySessions,
  store: SessionNetworkLogStore,
  logger: Logger,
): (frame: NetworkRequestsFrame, reportingNodeId: string) => void {
  const process = async (frame: NetworkRequestsFrame, reportingNodeId: string): Promise<void> => {
    const session = await agentSessions.get(frame.sessionId);
    if (session === null || session.nodeId !== reportingNodeId || session.status === 'closed') {
      logger.warn(
        {
          component: 'session-network-log-relay',
          sessionId: frame.sessionId,
          ownerNodeId: session?.nodeId ?? null,
          reportingNodeId,
          sessionStatus: session?.status ?? null,
        },
        'dropped networkRequests without an exact live session-owner node match',
      );
      return;
    }
    const kept: NetworkRequestEntry[] = frame.entries
      .filter(
        (entry) => Buffer.byteLength(JSON.stringify(entry), 'utf8') <= NETWORK_LOG_ENTRY_MAX_BYTES,
      )
      .slice(0, NETWORK_LOG_MAX_ENTRIES_PER_FRAME);
    store.append(frame.sessionId, kept);
  };

  return makeBoundedNodeLatestRelay({
    getSessionId: (frame) => frame.sessionId,
    process,
    onError: ({ error, sessionId }) => {
      logger.error(
        { component: 'session-network-log-relay', sessionId, err: error },
        'failed to gate/store networkRequests',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        {
          component: 'session-network-log-relay',
          reportingNodeId,
          sessionBudget,
          sessionId,
        },
        'dropped networkRequests because the reporting node exceeded its relay session budget',
      );
    },
  });
}
