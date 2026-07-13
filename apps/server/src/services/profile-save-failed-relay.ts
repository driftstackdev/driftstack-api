// Profile save-failure relay (A3 W1364 / A2 contract decision 2026-06-12) —
// bridges a harness `profileSaveFailed` HarnessOutbound frame to the
// customer-facing `session.profile_save_failed` webhook.
//
// The asymmetry this closes: a RESTORE failure (session start) errors the
// session — customer-visible; a SAVE failure (session teardown) was logged to
// ops stderr only, so a customer relying on persisted profile state couldn't
// distinguish "saved" from "silently lost" until a stale restore NEXT session.
// This relay makes the failure an explicit customer event. The session itself
// stays SUCCEEDED (the browsing succeeded; only the save-back-for-next-time
// failed) and the failure is TERMINAL by contract — the harness's internal PUT
// retry is exhausted before it emits, so there is no will_retry field.
//
// Returns a synchronous void handler (handleInbound is sync): the account
// lookup + webhook enqueue are fire-and-forget off the receive loop. Failures
// are logged, never thrown — a crashing receive loop would tear down every
// session on the node. An unknown session (no row) is dropped with a warn.
// Same shape as makeChallengeRelay (challenge-relay.ts).

import type { ProfileSaveFailed } from '../schemas/harness-control-protocol.js';
import type { WebhookEventType } from './webhooks.js';
import type { Logger } from '../lib/logger.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';
import { isCrossNodeSpoof } from './fleet-session-ownership.js';
import { customerSafeNodeDiagnostic } from './scrub-node-diagnostics.js';

/** Narrow structural deps so the relay is unit-testable without standing up the
 *  full repo / WebhooksService (the real instances satisfy these). `nodeId` is the
 *  session's owning node — the audit-M1 cross-node gate; the real repo returns it. */
interface ProfileSaveFailedRelaySessions {
  get(id: string): Promise<{ accountId: string; nodeId: string | null } | null>;
}
interface ProfileSaveFailedRelayWebhooks {
  enqueueEvent(
    accountId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<number>;
}

/**
 * Build the `onProfileSaveFailed` handler wired into FleetControlRegistry. The
 * caller passes the real agent-sessions repo + WebhooksService; omitting it (no
 * fleet control plane) leaves the frame accepted + ignored.
 */
export function makeProfileSaveFailedRelay(
  sessions: ProfileSaveFailedRelaySessions,
  webhooks: ProfileSaveFailedRelayWebhooks,
  logger: Logger,
): (frame: ProfileSaveFailed, reportingNodeId: string) => void {
  const process = async (frame: ProfileSaveFailed, reportingNodeId: string): Promise<void> => {
    const session = await sessions.get(frame.sessionId);
    if (session === null) {
      logger.warn(
        {
          component: 'profile-save-failed-relay',
          sessionId: frame.sessionId,
          profileId: frame.profile_id,
          reason: frame.reason,
        },
        'profileSaveFailed for unknown session — dropping relay',
      );
      return;
    }
    // audit M1 — only the session's OWNING node may fire its save-failed
    // webhook. Drop a frame from a non-owning node (cross-node spoof).
    if (isCrossNodeSpoof(session.nodeId, reportingNodeId)) {
      logger.warn(
        {
          component: 'profile-save-failed-relay',
          sessionId: frame.sessionId,
          ownerNodeId: session.nodeId,
          reportingNodeId,
        },
        'dropped profileSaveFailed from a non-owning node (cross-node spoof guard)',
      );
      return;
    }
    const endpoints = await webhooks.enqueueEvent(
      session.accountId,
      'session.profile_save_failed',
      {
        session_id: frame.sessionId,
        profile_id: frame.profile_id,
        reason: frame.reason,
        // Scrub credentials plus the node's real egress IP before the free-form
        // detail reaches the customer webhook.
        ...(frame.detail !== undefined ? { detail: customerSafeNodeDiagnostic(frame.detail) } : {}),
      },
    );
    logger.info(
      {
        component: 'profile-save-failed-relay',
        sessionId: frame.sessionId,
        profileId: frame.profile_id,
        reason: frame.reason,
        endpoints,
      },
      'relayed session.profile_save_failed webhook',
    );
  };

  return makeBoundedNodeLatestRelay({
    getSessionId: (frame) => frame.sessionId,
    process,
    onError: ({ error, frame, sessionId }) => {
      logger.error(
        {
          component: 'profile-save-failed-relay',
          sessionId,
          profileId: frame.profile_id,
          reason: frame.reason,
          err: error,
        },
        'failed to relay session.profile_save_failed',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        {
          component: 'profile-save-failed-relay',
          reportingNodeId,
          sessionBudget,
          sessionId,
        },
        'dropped profileSaveFailed because the reporting node exceeded its relay session budget',
      );
    },
  });
}
