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

/** Narrow structural deps so the relay is unit-testable without standing up the
 *  full repo / WebhooksService (the real instances satisfy these). */
interface ProfileSaveFailedRelaySessions {
  get(id: string): Promise<{ accountId: string } | null>;
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
): (frame: ProfileSaveFailed) => void {
  return (frame: ProfileSaveFailed): void => {
    void sessions
      .get(frame.sessionId)
      .then((session) => {
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
        return webhooks
          .enqueueEvent(session.accountId, 'session.profile_save_failed', {
            session_id: frame.sessionId,
            profile_id: frame.profile_id,
            reason: frame.reason,
            ...(frame.detail !== undefined ? { detail: frame.detail } : {}),
          })
          .then((endpoints) => {
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
          });
      })
      .catch((err: unknown) => {
        logger.error(
          {
            component: 'profile-save-failed-relay',
            sessionId: frame.sessionId,
            profileId: frame.profile_id,
            reason: frame.reason,
            err,
          },
          'failed to relay session.profile_save_failed',
        );
      });
  };
}
