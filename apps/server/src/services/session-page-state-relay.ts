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
import { isCrossNodeSpoof } from './fleet-session-ownership.js';

/** Narrow structural dep — the real agent-sessions repo satisfies this. */
interface PageStateRelaySessions {
  get(id: string): Promise<{ nodeId: string | null } | null>;
}

/**
 * Build the gated `onPageState` consumer wired into FleetControlRegistry. Looks
 * up the session's owning node and drops a frame from a non-owning node; an
 * unknown session (no row — e.g. a late frame after close) is stored as before
 * (no real session to spoof into a reader's view, so the threat model — only an
 * owned, live session can be hijacked — does not apply).
 */
export function makeSessionPageStateRelay(
  sessions: PageStateRelaySessions,
  store: SessionPageStateStore,
  logger: Logger,
): (frame: PageStateFrame, reportingNodeId: string) => void {
  return (frame: PageStateFrame, reportingNodeId: string): void => {
    void sessions
      .get(frame.sessionId)
      .then((session) => {
        if (session !== null && isCrossNodeSpoof(session.nodeId, reportingNodeId)) {
          logger.warn(
            {
              component: 'session-page-state-relay',
              sessionId: frame.sessionId,
              ownerNodeId: session.nodeId,
              reportingNodeId,
            },
            'dropped pageState from a non-owning node (cross-node spoof guard)',
          );
          return;
        }
        store.set(frame);
      })
      .catch((err: unknown) => {
        logger.error(
          { component: 'session-page-state-relay', sessionId: frame.sessionId, err },
          'failed to gate/store pageState',
        );
      });
  };
}
