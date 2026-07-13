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
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';

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

  return makeBoundedNodeLatestRelay({
    getSessionId: (frame) => frame.sessionId,
    process,
    onError: ({ error, sessionId }) => {
      logger.error(
        { component: 'session-page-state-relay', sessionId, err: error },
        'failed to gate/store pageState',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        {
          component: 'session-page-state-relay',
          reportingNodeId,
          sessionBudget,
          sessionId,
        },
        'dropped pageState because the reporting node exceeded its relay session budget',
      );
    },
  });
}
