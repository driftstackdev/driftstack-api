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

/**
 * Build the `onProfileSaved` handler wired into FleetControlRegistry. When R2 is
 * not configured the caller passes `undefined` instead (no-op); this factory is
 * only called when an R2 client exists.
 */
export function makeProfileSavedPersister(r2: R2, logger: Logger): (frame: ProfileSaved) => void {
  return (frame: ProfileSaved): void => {
    // Large path: the harness already PUT to the presigned URL; nothing to store.
    if (frame.sealed_blob === undefined) return;
    const key = profileSealedBlobKey(frame.profile_id);
    void r2
      .putObject({
        key,
        body: Buffer.from(frame.sealed_blob, 'base64'),
        contentType: 'application/octet-stream',
      })
      .then(() => {
        logger.info(
          { component: 'profile-store', profileId: frame.profile_id, sessionId: frame.sessionId },
          'persisted profile sealed-blob to R2',
        );
      })
      .catch((err: unknown) => {
        logger.error(
          {
            component: 'profile-store',
            profileId: frame.profile_id,
            sessionId: frame.sessionId,
            err,
          },
          'failed to persist profile sealed-blob to R2',
        );
      });
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
 * `urlTtlSeconds` MUST outlive the session: the save-back PUT URL is minted now
 * (at assign) but used by the harness at session END. R2/S3 presigned URLs
 * default to 900s (15 min), but a session's max duration defaults to 1800s
 * (30 min) and can be configured longer — so the default TTL would expire the
 * save-back URL mid-session and the customer's profile updates would be silently
 * lost. The caller passes the session's maxDurationSeconds plus a teardown
 * margin; the default here (3600s) safely covers the 1800s default max. Clamped
 * to R2's 7-day presign ceiling.
 */
const PRESIGN_MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // R2/S3 SigV4 ceiling
const DEFAULT_PROFILE_URL_TTL_SECONDS = 3600; // covers the 1800s default max session + margin

export async function buildAssignProfileBlock(
  r2: R2,
  profileId: string,
  dek: string,
  opts: { urlTtlSeconds?: number } = {},
): Promise<AssignProfileBlock> {
  const expiresIn = Math.min(
    Math.max(opts.urlTtlSeconds ?? DEFAULT_PROFILE_URL_TTL_SECONDS, 1),
    PRESIGN_MAX_TTL_SECONDS,
  );
  const key = profileSealedBlobKey(profileId);
  // PUT URL always (every profile-backed session must be able to save back). TTL
  // covers the full session lifetime — it's used at END, not now.
  const sealedBlobPutUrl = await r2.presignPut({
    key,
    contentType: 'application/octet-stream',
    expiresIn,
  });
  // GET URL only when a prior sealed store exists (else the harness is stateless
  // for this profile until its first save-back).
  const { exists } = await r2.headObject(key);
  if (exists) {
    const sealedBlobUrl = await r2.presignGet({ key, expiresIn });
    return { profileId, dek, sealedBlobUrl, sealedBlobPutUrl };
  }
  return { profileId, dek, sealedBlobPutUrl };
}
