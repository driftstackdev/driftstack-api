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
