// Profile-backed sessions (v1.5; A3 W417) — server-side persistence of the
// per-profile encrypted store on session end.
//
// On a PROFILE-BACKED session ending, the harness emits a `profileSaved`
// HarnessOutbound frame (routed by FleetControlConnection.handleInbound). Two
// shapes:
//   inline (small ≤256KB): { sealed_blob } — the harness ships the sealed blob
//     inline; the server writes it to R2 under profileSealedBlobKey(profile_id).
//   large (presigned-PUT): { stored: true } — the harness already PUT the blob
//     to the server-supplied `sealed_blob_put_url` (minted on assign, step (e)),
//     so the server has nothing to write; `stored:true` is the ack.
//
// The sealed blob is OPAQUE to the server (LZFSE + AES-GCM-256 under a per-profile
// DEK the harness never persists) — this module only moves bytes, never decrypts.
//
// Returns a synchronous void handler (handleInbound is sync): the R2 write is
// fire-and-forget off the receive loop. A write failure is logged, never thrown
// (a crashing receive loop would tear down every session on the node).

import type { ProfileSaved } from '../schemas/harness-control-protocol.js';
import { profileSealedBlobKey, type R2 } from '../lib/r2.js';
import type { Logger } from '../lib/logger.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';

/**
 * Cross-account ownership guard for the profileSaved persist (defense-in-depth).
 * A `profileSaved` frame carries a NODE-supplied `profile_id`; without this guard
 * an authenticated fleet node could emit `{ sessionId: <own session>, profile_id:
 * <ANY profile> }` and overwrite another account's sealed blob. These two
 * structural lookups bind the write to the exact session assignment: the session
 * (by `frame.sessionId`) must carry this `profile_id`, and its account must still
 * own that profile. Satisfied by the real AgentSessionsRepo (`get`) + ProfilesRepo
 * (`findById`).
 */
export interface ProfileSavedOwnershipDeps {
  agentSessions: {
    get(
      id: string,
    ): Promise<{ accountId: string; nodeId: string | null; profileId: string | null } | null>;
  };
  profiles: {
    findById(args: { id: string; accountId: string }): Promise<unknown>;
    // doc-150 item 5 — stamp last_saved_at (+ size_bytes when the harness
    // emitted it) on the owning profile row. Account-scoped, so the resolved
    // session-owner account is what binds the write to the right profile.
    recordSave(args: {
      id: string;
      accountId: string;
      at: Date;
      sizeBytes?: number;
    }): Promise<void>;
  };
}

/**
 * Build the `onProfileSaved` handler wired into FleetControlRegistry. When R2 is
 * not configured the caller passes `undefined` instead (no-op); this factory is
 * only called when an R2 client exists.
 *
 * The write is REFUSED (fail-closed, logged) unless `frame.sessionId` is assigned
 * to `frame.profile_id` and that account still owns the profile — blocking both
 * cross-account and same-account redirected writes. `ownership` is REQUIRED
 * (V-2140): it was optional, and a caller that omitted it got the pre-guard
 * behaviour — an authenticated node could overwrite any profile's sealed blob.
 * Production always passed it; the door existed for the next caller.
 */
export function makeProfileSavedPersister(
  r2: R2,
  logger: Logger,
  ownership: ProfileSavedOwnershipDeps,
): (frame: ProfileSaved, reportingNodeId?: string) => void {
  const process = async (frame: ProfileSaved, reportingNodeId?: string): Promise<void> => {
    const sealedBlob = frame.sealed_blob;
    // doc-150 item 5 — the size + save-back metadata rides BOTH shapes (inline
    // `sealed_blob` and the presigned `stored:true` ack), while only the inline
    // path has bytes for the server to write to R2. So we no longer early-return
    // on the large path: it still resolves ownership + records the save
    // metadata; it just skips the R2 write (the harness already PUT the blob).
    // The whole body is wrapped in a try/catch so that a rejection from the
    // ownership-resolution awaits below (agentSessions.get / profiles.findById)
    // — which run a DB query that can reject on a Neon compute-quota block /
    // blip — is LOGGED + the frame dropped, NOT thrown. A profileSaved frame
    // fires on every profile-backed teardown; an unhandled rejection here under
    // Node 22 (--unhandled-rejections=throw) would terminate the Fastify process
    // during exactly that window. The R2 put + recordSave below have their own
    // inner try/catch; this outer guard backstops the bare awaits + anything
    // else. The trailing `.catch()` is a second backstop in case the async
    // function ever throws synchronously before entering this try.
    await (async () => {
      try {
        let ownerAccountId: string | undefined;
        {
          const session = await ownership.agentSessions.get(frame.sessionId);
          if (session === null) {
            logger.warn(
              {
                component: 'profile-store',
                sessionId: frame.sessionId,
                profileId: frame.profile_id,
              },
              'profileSaved refused: unknown session for profile-blob write',
            );
            return;
          }
          // Fleet-origin profile saves fail closed unless the authenticated
          // reporting node exactly owns the session. A NULL node_id is never a
          // legitimate save-back source: dispatch persists node_id before it
          // sends sessionAssign, so allowing NULL would recreate the spoof gap.
          if (reportingNodeId === undefined || session.nodeId !== reportingNodeId) {
            logger.warn(
              {
                component: 'profile-store',
                sessionId: frame.sessionId,
                profileId: frame.profile_id,
                ownerNodeId: session.nodeId,
                reportingNodeId,
              },
              'profileSaved refused: reporting node does not own the session',
            );
            return;
          }
          // Account ownership alone is insufficient: a compromised node that
          // owns one session for an account could otherwise redirect that save
          // into any other profile in the same account. Migration 0089 persists
          // the exact create-time session binding, so require it before a victim
          // profile lookup or R2 key construction. Ephemeral sessions fail closed.
          if (session.profileId !== frame.profile_id) {
            logger.warn(
              {
                component: 'profile-store',
                sessionId: frame.sessionId,
                assignedProfileId: session.profileId,
                reportedProfileId: frame.profile_id,
                reportingNodeId,
              },
              'profileSaved refused: reported profile does not match the session binding',
            );
            return;
          }
          const owned = await ownership.profiles.findById({
            id: frame.profile_id,
            accountId: session.accountId,
          });
          if (owned === null) {
            logger.warn(
              {
                component: 'profile-store',
                sessionId: frame.sessionId,
                profileId: frame.profile_id,
                accountId: session.accountId,
              },
              'profileSaved refused: profile not owned by the session account (cross-account write blocked)',
            );
            return;
          }
          ownerAccountId = session.accountId;
        }

        // Inline path: persist the sealed bytes to R2 (the large path already PUT).
        if (sealedBlob !== undefined) {
          const key = profileSealedBlobKey(frame.profile_id);
          try {
            await r2.putObject({
              key,
              body: Buffer.from(sealedBlob, 'base64'),
              contentType: 'application/octet-stream',
            });
            logger.info(
              {
                component: 'profile-store',
                profileId: frame.profile_id,
                sessionId: frame.sessionId,
              },
              'persisted profile sealed-blob to R2',
            );
          } catch (err) {
            logger.error(
              {
                component: 'profile-store',
                profileId: frame.profile_id,
                sessionId: frame.sessionId,
                err,
              },
              'failed to persist profile sealed-blob to R2',
            );
            // Do not stamp last_saved_at for an inline save whose blob never
            // reached R2; metadata must describe durable state, not an attempt.
            return;
          }
        }

        // doc-150 item 5 — best-effort record of the save-back (last_saved_at +
        // size_bytes) on the profile row. Only when ownership deps are wired (the
        // resolved session-owner account scopes the write). A missing size_bytes
        // leaves the column untouched; a failure is logged, never thrown.
        if (ownerAccountId !== undefined) {
          try {
            await ownership.profiles.recordSave({
              id: frame.profile_id,
              accountId: ownerAccountId,
              at: new Date(),
              ...(frame.size_bytes !== undefined ? { sizeBytes: frame.size_bytes } : {}),
            });
          } catch (err) {
            logger.error(
              {
                component: 'profile-store',
                profileId: frame.profile_id,
                sessionId: frame.sessionId,
                err,
              },
              'failed to record profile save metadata (size_bytes / last_saved_at)',
            );
          }
        }
      } catch (err) {
        // Backstop: a rejection from the ownership-resolution awaits (DB blip /
        // Neon quota block) lands here — log + drop the frame; NEVER throw out of
        // the fire-and-forget handler (an unhandled rejection would crash the
        // control-plane process).
        logger.error(
          {
            component: 'profile-store',
            profileId: frame.profile_id,
            sessionId: frame.sessionId,
            err,
          },
          'profileSaved persist failed during ownership resolution; dropping frame',
        );
      }
    })().catch((err: unknown) => {
      // Second backstop — the IIFE is fully try/caught above, but guard against
      // any synchronous throw before the try (or a future refactor) so the
      // process can never die on a profileSaved frame.
      logger.error(
        {
          component: 'profile-store',
          profileId: frame.profile_id,
          sessionId: frame.sessionId,
          err,
        },
        'profileSaved persist promise rejected (outer backstop)',
      );
    });
  };

  const bounded = makeBoundedNodeLatestRelay({
    getSessionId: (frame: ProfileSaved) => frame.sessionId,
    process: (frame, reportingNodeId) => process(frame, reportingNodeId),
    onError: ({ error, frame }) => {
      logger.error(
        {
          component: 'profile-store',
          profileId: frame.profile_id,
          sessionId: frame.sessionId,
          err: error,
        },
        'profileSaved persist promise rejected (bounded-queue backstop)',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        { component: 'profile-store', reportingNodeId, sessionBudget, sessionId },
        'dropped profileSaved because the reporting node exceeded its persistence session budget',
      );
    },
  });

  return (frame: ProfileSaved, reportingNodeId?: string): void => {
    // Fail before DB/R2 work when a non-registry caller omits the authenticated
    // node identity. The registry path always supplies it.
    if (reportingNodeId === undefined) {
      logger.warn(
        {
          component: 'profile-store',
          sessionId: frame.sessionId,
          profileId: frame.profile_id,
        },
        'profileSaved refused: missing authenticated reporting-node identity',
      );
      return;
    }
    bounded(frame, reportingNodeId);
  };
}

/**
 * The camelCase `profile` argument for serializeSessionAssign — the restore side
 * of a profile-backed session (step (e)). Built by buildAssignProfileBlock.
 */
export interface AssignProfileBlock {
  profileId: string;
  dek: string;
  /** Presigned GET for the existing sealed store; omitted for a fresh profile. */
  sealedBlobUrl?: string;
  /** Presigned PUT the harness uses to save the sealed store back on session end. */
  sealedBlobPutUrl: string;
}

/**
 * Build the assign `profile` block for a profile-backed session (A3 W420 restore
 * + save-back contract). Mints presigned R2 URLs rather than streaming the blob
 * through the server: the opaque sealed store (LZFSE + AES-GCM-256) flows R2 ↔
 * harness directly via `URLSession`, so the control plane never holds it. We
 * always use the presigned-GET path (never inline `sealed_blob`) — A3's decoder
 * fetches `sealed_blob_url` (W420, tested), and this keeps an arbitrarily large
 * blob off the server with no size-probe needed.
 *
 * `dek` is forwarded verbatim — this helper is crypto-free; the per-profile DEK
 * mint/wrap (KMS → TMK → DEK, file 57) is the founder-gated step (c) the caller
 * supplies. A fresh profile (no prior store) gets a PUT URL but no GET URL, so
 * the harness starts stateless and seals its first store on end.
 *
 * `urlTtlSeconds` sets the save-back PUT URL's lifetime, which MUST outlive the
 * session: the PUT URL is minted now (at assign) but used by the harness at
 * session END. R2/S3 presigned URLs default to 900s (15 min) and a manual
 * session runs up to MANUAL_SESSION_MAX_DURATION_SECONDS (4h) — so a too-short
 * TTL would expire the save-back URL mid-session and the customer's profile
 * updates would be silently lost. The caller passes the session's
 * maxDurationSeconds plus a teardown margin; clamped to R2's 7-day presign
 * ceiling. The restore GET URL, by contrast, is consumed at session START (the
 * harness fetches the sealed store to restore it), NOT at teardown — so it gets
 * a SHORTER TTL (the 1h restore window) independent of `urlTtlSeconds`. That's
 * least-privilege: a leaked GET (ciphertext of the customer's sealed store) then
 * stays valid only as long as a restore could plausibly still be pending, not
 * for the whole multi-hour session.
 */
const PRESIGN_MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // R2/S3 SigV4 ceiling
const DEFAULT_PROFILE_URL_TTL_SECONDS = 3600; // covers the 1800s default max session + margin

export async function buildAssignProfileBlock(
  r2: R2,
  profileId: string,
  dek: string,
  opts: { urlTtlSeconds?: number } = {},
): Promise<AssignProfileBlock> {
  // The save-back PUT is used at session END, so its TTL must cover the whole
  // session lifetime (the caller passes maxDurationSeconds + a teardown margin).
  const putExpiresIn = Math.min(
    Math.max(opts.urlTtlSeconds ?? DEFAULT_PROFILE_URL_TTL_SECONDS, 1),
    PRESIGN_MAX_TTL_SECONDS,
  );
  // The restore GET is consumed at session START, not teardown — so it does not
  // need to outlive the session. Cap it at the restore window (1h, which
  // comfortably covers any cold-start) for least-privilege; never longer than the
  // PUT TTL (a short caller override shrinks both).
  const getExpiresIn = Math.min(putExpiresIn, DEFAULT_PROFILE_URL_TTL_SECONDS);
  const key = profileSealedBlobKey(profileId);
  // PUT URL always (every profile-backed session must be able to save back). TTL
  // covers the full session lifetime — it's used at END, not now.
  const sealedBlobPutUrl = await r2.presignPut({
    key,
    contentType: 'application/octet-stream',
    expiresIn: putExpiresIn,
  });
  // GET URL only when a prior sealed store exists (else the harness is stateless
  // for this profile until its first save-back).
  const { exists } = await r2.headObject(key);
  if (exists) {
    const sealedBlobUrl = await r2.presignGet({ key, expiresIn: getExpiresIn });
    return { profileId, dek, sealedBlobUrl, sealedBlobPutUrl };
  }
  return { profileId, dek, sealedBlobPutUrl };
}
