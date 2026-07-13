// Authenticated harness errorEvent consumer.
//
// The harness emits terminal sessionStatus first and the structured errorEvent
// second, so this relay deliberately accepts a closed session while requiring
// the atomic repository update to match the connection's authenticated node.

import type { Logger } from '../lib/logger.js';
import { redactText } from '../lib/redact-url.js';
import {
  HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH,
  HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH,
  type HarnessErrorEvent,
} from '../schemas/harness-control-protocol.js';
import type { AgentSessionErrorEvent, AgentSessionsRepo } from './agent-sessions.js';
import type { NotificationEventBus } from './notification-event-bus.js';
import { scrubNodeDiagnostics } from './scrub-node-diagnostics.js';

function customerSafeText(value: string, maxLength: number): string {
  // IPv4 scrubbing can expand a short literal into `[redacted-ip]`. Re-apply
  // the protocol bound after sanitizing so the durable/public representation
  // cannot exceed the contract that admitted the original harness frame.
  return scrubNodeDiagnostics(redactText(value)).slice(0, maxLength);
}

export function makeSessionErrorEventRelay(
  agentSessions: Pick<AgentSessionsRepo, 'recordErrorEvent'>,
  notifications: NotificationEventBus,
  logger: Logger,
): (frame: HarnessErrorEvent, reportingNodeId: string) => void {
  const chains = new Map<string, Promise<void>>();

  const process = async (frame: HarnessErrorEvent, reportingNodeId: string): Promise<void> => {
    if (frame.sessionId === undefined) return;

    const event: AgentSessionErrorEvent = {
      timestamp: frame.timestamp,
      code: frame.code,
      severity: frame.severity,
      summary: customerSafeText(frame.summary, HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH),
      detail:
        frame.detail !== undefined
          ? customerSafeText(frame.detail, HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH)
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
  };

  return (frame: HarnessErrorEvent, reportingNodeId: string): void => {
    const sessionId = frame.sessionId;
    if (sessionId === undefined) return;
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const chained = previous.then(() =>
      process(frame, reportingNodeId).catch((err: unknown) => {
        logger.error(
          { component: 'session-error-event-relay', sessionId, err },
          'failed to consume errorEvent',
        );
      }),
    );
    chains.set(sessionId, chained);
    void chained.finally(() => {
      if (chains.get(sessionId) === chained) chains.delete(sessionId);
    });
  };
}
