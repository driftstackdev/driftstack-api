// Page-state store-writer with the audit-M1 cross-node ownership gate.
//
// Unlike the challenge / profile-save-failed relays (which look up the session to
// resolve the owning ACCOUNT for a webhook), the pageState consumer only writes
// to an in-memory store. But it must STILL verify the reporting node owns the
// session before overwriting its live overlay — otherwise a buggy/rogue node
// could fake another customer's loading-bar / error state (the customer reads
// their OWN session's page-state, so a spoofed write reaches them). This factory
// wraps SessionPageStateStore.set with that gate; the store itself stays a pure
// map (read by GET /v1/agent-sessions/:id/page-state). It replaces the previous
// direct `(frame) => store.set(frame)` wiring in bootstrap.
//
// Returns a synchronous void handler (handleInbound is sync); the session lookup
// is fire-and-forget off the receive loop, matching the relays' shape. A failed
// lookup is logged, never thrown.

import type { PageStateFrame } from '../schemas/harness-control-protocol.js';
import type { SessionPageStateStore } from './session-page-state-store.js';
import type { Logger } from '../lib/logger.js';

/** Narrow structural dep — the real agent-sessions repo satisfies this. */
interface PageStateRelaySessions {
  get(id: string): Promise<{ nodeId: string | null } | null>;
}

/**
 * Build the gated `onPageState` consumer wired into FleetControlRegistry. Looks
 * up the session's owning node and stores only an exact owner match. Unknown
 * sessions and NULL-node sessions fail closed: neither can have a legitimate
 * fleet producer, and retaining their attacker-controlled strings only creates
 * memory/DB pressure without a customer-visible use case.
 */
export function makeSessionPageStateRelay(
  sessions: PageStateRelaySessions,
  store: SessionPageStateStore,
  logger: Logger,
): (frame: PageStateFrame, reportingNodeId: string) => void {
  // Per-session write ORDERING. Each frame's ownership check is an independent
  // async sessions.get(), and handleInbound fires frames synchronously without
  // awaiting — so for two frames on the SAME session (e.g. loading → loaded on a
  // fast navigate) the second lookup can resolve BEFORE the first under DB
  // latency variance, and the older frame's store.set then clobbers the newer
  // one (the GUI is left showing a stale 'loading' bar until the next ~2s frame
  // self-corrects). Chain each session's processing so frame N's store.set
  // completes before frame N+1 is even looked up. The map is bounded: an entry
  // exists only while a session has an in-flight chain, and self-deletes when
  // the chain drains (the `=== chained` identity check ensures a newer frame
  // that extended the chain isn't dropped by an older link's cleanup).
  const chains = new Map<string, Promise<void>>();

  const process = async (frame: PageStateFrame, reportingNodeId: string): Promise<void> => {
    const session = await sessions.get(frame.sessionId);
    if (session === null || session.nodeId !== reportingNodeId) {
      logger.warn(
        {
          component: 'session-page-state-relay',
          sessionId: frame.sessionId,
          ownerNodeId: session?.nodeId ?? null,
          reportingNodeId,
        },
        'dropped pageState without an exact session-owner node match',
      );
      return;
    }
    store.set(frame);
  };

  return (frame: PageStateFrame, reportingNodeId: string): void => {
    const sessionId = frame.sessionId;
    const prev = chains.get(sessionId) ?? Promise.resolve();
    // Swallow+log a per-frame failure so it never breaks the chain for the next
    // frame (the successor awaits `chained`, which must always resolve).
    const chained = prev.then(() =>
      process(frame, reportingNodeId).catch((err: unknown) => {
        logger.error(
          { component: 'session-page-state-relay', sessionId, err },
          'failed to gate/store pageState',
        );
      }),
    );
    chains.set(sessionId, chained);
    void chained.finally(() => {
      if (chains.get(sessionId) === chained) chains.delete(sessionId);
    });
  };
}
