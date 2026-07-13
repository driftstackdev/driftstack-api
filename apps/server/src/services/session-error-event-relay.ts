// Authenticated harness errorEvent consumer.
//
// The harness emits terminal sessionStatus first and the structured errorEvent
// second, so this relay deliberately accepts a closed session while requiring
// the atomic repository update to match the connection's authenticated node.

import type { Logger } from '../lib/logger.js';
import { redactText } from '../lib/redact-url.js';
import {
  HARNESS_HEARTBEAT_MAX_CONCURRENT,
  HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH,
  HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH,
  type HarnessErrorEvent,
} from '../schemas/harness-control-protocol.js';
import type { AgentSessionErrorEvent, AgentSessionsRepo } from './agent-sessions.js';
import type { NotificationEventBus } from './notification-event-bus.js';
import { scrubNodeDiagnostics } from './scrub-node-diagnostics.js';

// A real worker cannot own more than the heartbeat protocol's declared 512
// concurrent sessions. Keep the relay's distinct active/queued session budget
// at that same ceiling so an authenticated but compromised node cannot turn
// unique fake session ids into an unbounded promise map and DB work queue.
export const ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE = HARNESS_HEARTBEAT_MAX_CONCURRENT;
// Ownership checks and persistence are local-DB work. Eight concurrent writes
// per reporting node leave ample headroom for a real terminal-session burst
// without letting one node monopolize the pool.
export const ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE = 8;

interface NodeRelayState {
  /** One latest pending event per session. A key may also be in-flight. */
  pending: Map<string, HarnessErrorEvent>;
  inFlight: Set<string>;
  overflowLogged: boolean;
}

function activeSessionCount(state: NodeRelayState): number {
  let count = state.inFlight.size;
  for (const sessionId of state.pending.keys()) {
    if (!state.inFlight.has(sessionId)) count += 1;
  }
  return count;
}

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
  const nodeStates = new Map<string, NodeRelayState>();

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

  const pump = (reportingNodeId: string, state: NodeRelayState): void => {
    while (state.inFlight.size < ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE) {
      // A repeated event for an in-flight session remains pending until that
      // write finishes; select the first other eligible session when present.
      let next: [string, HarnessErrorEvent] | undefined;
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
      void process(frame, reportingNodeId)
        .catch((err: unknown) => {
          logger.error(
            { component: 'session-error-event-relay', sessionId, err },
            'failed to consume errorEvent',
          );
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

  return (frame: HarnessErrorEvent, reportingNodeId: string): void => {
    const sessionId = frame.sessionId;
    if (sessionId === undefined) return;
    let state = nodeStates.get(reportingNodeId);
    if (state === undefined) {
      state = { pending: new Map(), inFlight: new Set(), overflowLogged: false };
      nodeStates.set(reportingNodeId, state);
    }

    // Repeats coalesce to the newest not-yet-started diagnostic. The durable
    // contract is explicitly latest-error state; retaining every intermediate
    // repeat would reintroduce an attacker-controlled unbounded queue.
    if (state.pending.has(sessionId) || state.inFlight.has(sessionId)) {
      state.pending.set(sessionId, frame);
      pump(reportingNodeId, state);
      return;
    }

    if (activeSessionCount(state) >= ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE) {
      // One warning per saturated node-state lifetime. Logging every shed frame
      // would merely exchange DB amplification for log amplification.
      if (!state.overflowLogged) {
        state.overflowLogged = true;
        logger.warn(
          {
            component: 'session-error-event-relay',
            sessionId,
            reportingNodeId,
            sessionBudget: ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE,
          },
          'dropped errorEvent because the reporting node exceeded its relay session budget',
        );
      }
      return;
    }
    state.pending.set(sessionId, frame);
    pump(reportingNodeId, state);
  };
}
