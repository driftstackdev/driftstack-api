// Authenticated harness errorEvent consumer.
//
// The harness emits terminal sessionStatus first and the structured errorEvent
// second, so this relay deliberately accepts a closed session while requiring
// the atomic repository update to match the connection's authenticated node.

import type { Logger } from '../lib/logger.js';
import {
  HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH,
  HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH,
  type HarnessErrorEvent,
} from '../schemas/harness-control-protocol.js';
import type { AgentSessionErrorEvent, AgentSessionsRepo } from './agent-sessions.js';
import {
  BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT,
  BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS,
  makeBoundedNodeLatestRelay,
} from './bounded-node-latest-relay.js';
import type { NotificationEventBus } from './notification-event-bus.js';
import { customerSafeNodeDiagnostic } from './scrub-node-diagnostics.js';

// A real worker cannot own more than the heartbeat protocol's declared 512
// concurrent sessions. Keep the relay's distinct active/queued session budget
// at that same ceiling so an authenticated but compromised node cannot turn
// unique fake session ids into an unbounded promise map and DB work queue.
export const ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE = BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS;
// Ownership checks and persistence are local-DB work. Eight concurrent writes
// per reporting node leave ample headroom for a real terminal-session burst
// without letting one node monopolize the pool.
export const ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE = BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT;

type SessionScopedHarnessErrorEvent = HarnessErrorEvent & { sessionId: string };

export function makeSessionErrorEventRelay(
  agentSessions: Pick<AgentSessionsRepo, 'recordErrorEvent'>,
  notifications: NotificationEventBus,
  logger: Logger,
): (frame: HarnessErrorEvent, reportingNodeId: string) => void {
  const receiveSessionScoped = makeBoundedNodeLatestRelay<SessionScopedHarnessErrorEvent>({
    getSessionId: (frame) => frame.sessionId,
    process: async (frame, reportingNodeId) => {
      const event: AgentSessionErrorEvent = {
        timestamp: frame.timestamp,
        code: frame.code,
        severity: frame.severity,
        summary: customerSafeNodeDiagnostic(frame.summary, HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH),
        detail:
          frame.detail !== undefined
            ? customerSafeNodeDiagnostic(frame.detail, HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH)
            : null,
        customerActionable: frame.customerActionable,
        retryable: frame.retryable,
      };
      const session = await agentSessions.recordErrorEvent(frame.sessionId, reportingNodeId, event);
      if (session === null) {
        logger.warn(
          {
            component: 'session-error-event-relay',
            sessionId: frame.sessionId,
            reportingNodeId,
            code: frame.code,
          },
          'dropped errorEvent without an exact session-owner node match',
        );
        return;
      }

      notifications.publish({
        kind: 'session.errored',
        accountId: session.accountId,
        sessionId: session.id,
        errorClass: event.code,
        at: event.timestamp,
      });
    },
    onError: ({ error, sessionId }) => {
      logger.error(
        { component: 'session-error-event-relay', sessionId, err: error },
        'failed to consume errorEvent',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        {
          component: 'session-error-event-relay',
          sessionId,
          reportingNodeId,
          sessionBudget,
        },
        'dropped errorEvent because the reporting node exceeded its relay session budget',
      );
    },
  });

  return (frame: HarnessErrorEvent, reportingNodeId: string): void => {
    if (frame.sessionId === undefined) return;
    receiveSessionScoped(frame as SessionScopedHarnessErrorEvent, reportingNodeId);
  };
}
