// Profile save-failure relay (W1364 / contract decision 2026-06-12) —
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

import {
  PROFILE_SAVE_FAILED_DEVICE_REASONS,
  type ProfileSaveFailed,
} from '../schemas/harness-control-protocol.js';
import { logLostWebhookEvent, type WebhookEventType } from './webhooks.js';
import type { Logger } from '../lib/logger.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';
import { isCrossNodeSpoof } from './fleet-session-ownership.js';
import { customerSafeNodeDiagnostic } from './scrub-node-diagnostics.js';

/**
 * Migration 0143 — the reason the SERVER gives when it refused a session's
 * profile save-back because the session never started from the profile's stored
 * state (dispatch could not hand the device that state). The stored profile is
 * kept; this session's changes are not saved to it. Not a device reason: the
 * device reports how a save failed, this says why the server would not take one.
 */
export const PROFILE_NOT_LOADED_REASON = 'profile_not_loaded';

/** Customer copy for {@link PROFILE_NOT_LOADED_REASON}: what happened, not how. */
export const PROFILE_NOT_LOADED_DETAIL =
  "The profile could not be loaded when this session started, so this session's changes were not saved to it.";

/** Every `reason` a `session.profile_save_failed` webhook can carry — the
 *  customer reference lists exactly these (pinned by
 *  every-profile-save-failed-reason-the-server-sends-is-documented.test.ts). */
export const PROFILE_SAVE_FAILED_WEBHOOK_REASONS = [
  ...PROFILE_SAVE_FAILED_DEVICE_REASONS,
  PROFILE_NOT_LOADED_REASON,
] as const;

/** Narrow structural deps so the relay is unit-testable without standing up the
 *  full repo / WebhooksService (the real instances satisfy these). `nodeId` is the
 *  session's owning node — the audit-M1 cross-node gate. `profileId` is the exact
 *  persisted dispatch binding; both are returned by the real repo. So is
 *  `profileSaveBackRefused` (0143), which only changes the reported reason here,
 *  so a double that omits it reads as "not refused". */
interface ProfileSaveFailedRelaySessions {
  get(id: string): Promise<{
    accountId: string;
    nodeId: string | null;
    profileId: string | null;
    profileSaveBackRefused?: boolean;
  } | null>;
}
export interface ProfileSaveFailedRelayWebhooks {
  enqueueEvent(
    accountId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<number>;
}

/**
 * The `session.profile_save_failed` payload for a save-back refused because the
 * session never started from the profile's stored state — the same event, and
 * the same shape, as a device-reported save failure. Each caller enqueues it
 * itself, so every enqueue site stays visible to the lost-event scan.
 */
export function profileNotLoadedEventData(args: {
  sessionId: string;
  profileId: string;
}): Record<string, unknown> {
  return {
    session_id: args.sessionId,
    profile_id: args.profileId,
    reason: PROFILE_NOT_LOADED_REASON,
    detail: PROFILE_NOT_LOADED_DETAIL,
  };
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
    // Match the successful profileSaved path: owning the session is necessary
    // but not sufficient. The node-supplied profile_id must also match the
    // immutable profile bound when this session was created. Ephemeral sessions
    // have no legitimate profile save-back failure and therefore fail closed.
    if (session.profileId === null || session.profileId !== frame.profile_id) {
      logger.warn(
        {
          component: 'profile-save-failed-relay',
          sessionId: frame.sessionId,
          assignedProfileId: session.profileId,
          reportedProfileId: frame.profile_id,
          reportingNodeId,
        },
        'dropped profileSaveFailed whose profile does not match the session binding',
      );
      return;
    }
    // 0143 — a session whose save-back was refused at dispatch never started
    // from the stored profile, so whatever the device says went wrong with its
    // save, the reason the customer's changes were not kept is that one: nothing
    // from this session could have replaced the stored profile. Report it as
    // such rather than as a transport failure worth retrying.
    const notLoaded = session.profileSaveBackRefused === true;
    let endpoints: number;
    try {
      endpoints = await webhooks.enqueueEvent(
        session.accountId,
        'session.profile_save_failed',
        notLoaded
          ? profileNotLoadedEventData({ sessionId: frame.sessionId, profileId: session.profileId })
          : {
              session_id: frame.sessionId,
              profile_id: session.profileId,
              reason: frame.reason,
              // Scrub credentials plus the node's real egress IP before the free-form
              // detail reaches the customer webhook.
              ...(frame.detail !== undefined
                ? { detail: customerSafeNodeDiagnostic(frame.detail) }
                : {}),
            },
      );
    } catch (err) {
      // Webhooks audit #5 — logged here, where the account is known, rather
      // than by the relay's generic onError, which could name only the session.
      logLostWebhookEvent(logger, {
        component: 'profile-save-failed-relay',
        accountId: session.accountId,
        eventType: 'session.profile_save_failed',
        err,
        context: { session_id: frame.sessionId, profile_id: session.profileId },
      });
      return;
    }
    logger.info(
      {
        component: 'profile-save-failed-relay',
        sessionId: frame.sessionId,
        profileId: session.profileId,
        reason: notLoaded ? PROFILE_NOT_LOADED_REASON : frame.reason,
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
