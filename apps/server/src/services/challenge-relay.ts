// Challenge-handling relay (W393) — bridges a harness `challengeDetected`
// HarnessOutbound frame to the customer-facing `session.challenge_detected`
// webhook.
//
// On a session hitting a bot-check (DataDome / Arkose / PerimeterX / AWS-WAF /
// GeeTest / …), the harness ChallengeDetector emits a `challengeDetected` frame
// (routed by FleetControlConnection.handleInbound → the registry's
// onChallengeDetected consumer). This factory builds that consumer: it resolves
// the session's owning account and enqueues a `session.challenge_detected`
// webhook so subscribers can route the alert into their own ops surface (the
// harness has already auto-paused the session; the customer resolves the
// challenge then resumes via the resume endpoint).
//
// Returns a synchronous void handler (handleInbound is sync): the account
// lookup + webhook enqueue are fire-and-forget off the receive loop. Failures
// are logged, never thrown — a crashing receive loop would tear down every
// session on the node. An unknown session (no row) is dropped with a warn.

import type { ChallengeDetected } from '../schemas/harness-control-protocol.js';
import type { WebhookEventType } from './webhooks.js';
import type { Logger } from '../lib/logger.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';
import { isCrossNodeSpoof } from './fleet-session-ownership.js';
import { customerSafeNodeDiagnostic } from './scrub-node-diagnostics.js';

/** Narrow structural deps so the relay is unit-testable without standing up the
 *  full repo / WebhooksService (the real instances satisfy these). `nodeId` is the
 *  session's owning node — the audit-M1 cross-node gate; the real repo returns it. */
interface ChallengeRelaySessions {
  get(id: string): Promise<{ accountId: string; nodeId: string | null } | null>;
}
interface ChallengeRelayWebhooks {
  enqueueEvent(
    accountId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<number>;
}

/**
 * Build the `onChallengeDetected` handler wired into FleetControlRegistry. The
 * caller passes the real agent-sessions repo + WebhooksService; omitting it (no
 * fleet control plane) leaves the frame accepted + ignored.
 */
export function makeChallengeRelay(
  sessions: ChallengeRelaySessions,
  webhooks: ChallengeRelayWebhooks,
  logger: Logger,
): (frame: ChallengeDetected, reportingNodeId: string) => void {
  const process = async (frame: ChallengeDetected, reportingNodeId: string): Promise<void> => {
    const session = await sessions.get(frame.sessionId);
    if (session === null) {
      logger.warn(
        {
          component: 'challenge-relay',
          sessionId: frame.sessionId,
          challengeId: frame.challengeId,
        },
        'challengeDetected for unknown session — dropping relay',
      );
      return;
    }
    // audit M1 — only the session's OWNING node may fire its challenge
    // webhook. Drop a frame from a non-owning node (cross-node spoof).
    if (isCrossNodeSpoof(session.nodeId, reportingNodeId)) {
      logger.warn(
        {
          component: 'challenge-relay',
          sessionId: frame.sessionId,
          ownerNodeId: session.nodeId,
          reportingNodeId,
        },
        'dropped challengeDetected from a non-owning node (cross-node spoof guard)',
      );
      return;
    }
    // Scrub credentials plus the node's real egress IP from the free-form
    // challenge.detail before it reaches the customer webhook.
    const challenge =
      typeof frame.challenge.detail === 'string'
        ? { ...frame.challenge, detail: customerSafeNodeDiagnostic(frame.challenge.detail) }
        : frame.challenge;
    const endpoints = await webhooks.enqueueEvent(session.accountId, 'session.challenge_detected', {
      session_id: frame.sessionId,
      challenge_id: frame.challengeId,
      challenge,
    });
    logger.info(
      {
        component: 'challenge-relay',
        sessionId: frame.sessionId,
        challengeId: frame.challengeId,
        endpoints,
      },
      'relayed session.challenge_detected webhook',
    );
  };

  return makeBoundedNodeLatestRelay({
    getSessionId: (frame) => frame.sessionId,
    process,
    onError: ({ error, frame, sessionId }) => {
      logger.error(
        {
          component: 'challenge-relay',
          sessionId,
          challengeId: frame.challengeId,
          err: error,
        },
        'failed to relay session.challenge_detected',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        { component: 'challenge-relay', reportingNodeId, sessionBudget, sessionId },
        'dropped challengeDetected because the reporting node exceeded its relay session budget',
      );
    },
  });
}
