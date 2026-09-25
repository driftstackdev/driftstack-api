// #158 (2026-07-10) — sealed profile blobs no profile owns (GDPR erasure
// backstop). Since 2026-09-25 the `profile_blob_orphans` arm of the daily
// account-deletion purge.
//
// THE RACE this closes (verified HIGH, task #158). A customer PURGE
// (DELETE /:id/purge → ProfilesService.purge → purgeTrashed) hard-deletes the
// profile row + its wrapped DEK and best-effort deletes the R2
// `profiles/<uuid>.sealed` blob. But a just-closed session for that same
// profile holds a presigned save-back PUT URL minted independently at
// session-assign (buildAssignProfileBlock, profile-store.ts) whose final PUT
// can still be IN FLIGHT. If that PUT lands AFTER the purge, the session's
// direct PUT to R2 RE-CREATES `profiles/<uuid>.sealed` with NO DB row behind
// it — a permanent orphan the purge path can never reap (it already ran) and
// no row-driven sweep touches. "Permanent delete" then isn't permanent: the
// customer's encrypted browser state lingers in R2 forever after erasure.
//
// The #1/#3 (2026-06-30) live-session guard (ProfilesService.assertNoActive
// Session) refuses a purge while a session is still `active`, which shrinks the
// window — but a session that flips to closed a hair before its final save-back
// PUT lands still slips through. This pass is the wall-clock BACKSTOP for that
// residual, and for a purge whose own blob delete failed: it lists
// `profiles/*.sealed` in the private bucket, and deletes any object OLDER than a
// grace window whose uuid has NO profiles row at all.
//
// WHERE IT RUNS. It used to be an in-process setTimeout chain armed at boot with
// its first tick six hours later. Production deploys several times a day, so a
// process rarely lived that long and the pass may never have run. It now rides
// the daily account-deletion purge (account-deletion-purge-sweeper.ts), which
// is scheduled in the database and survives restarts — the same move, for the
// same reason, as AvatarOrphanReaper.
//
// CONSERVATIVE BY DESIGN — it must NEVER delete a live or in-flight blob:
//   • GRACE WINDOW (PROFILE_BLOB_ORPHAN_GRACE_MS, 6h). An object is only a
//     candidate if its lastModified is non-null AND older than the grace window.
//     This MUST exceed the longest presigned save-back PUT a session is given,
//     so an in-flight save-back is never deleted mid-flight. An object with a
//     null lastModified, or younger than the grace, is SKIPPED.
//
//     ⛔ V-1736 — the in-process version of this paragraph once said the grace
//     was 2h and that "the current max minted TTL is
//     DEFAULT_PROFILE_URL_TTL_SECONDS = 3600s (1h)". BOTH halves were wrong: the
//     grace is 6h, and routes/agent-sessions.ts passes
//     PROFILE_SAVE_BACK_PUT_TTL_SECONDS, currently 16200s (4.5h), because that
//     PUT is consumed at session TEARDOWN and must outlive the session. The two
//     errors cancelled and the invariant held (6h > 4.5h), which is exactly why
//     nobody noticed. The margin is 1.5h, and the relation is asserted against
//     the imported constant rather than against literals retyped in a test.
//   • EXISTENCE CHECK is soft-delete-INCLUSIVE (findExistingProfileIds returns
//     trashed rows too): a trashed profile still owns its blob until the 30-day
//     retention purge, so only a blob whose uuid has NO row whatsoever goes.
//   • Only a key of exactly `profiles/<uuid>.sealed` is considered (V-2007).
//   • A refused listing (a token without list permission) or a failed existence
//     query REJECTS, deleting nothing; the purge arm reports it as failed and
//     the rest of the purge still runs.
//   • Per-key deleteObject is best-effort: a failure is counted, never aborts
//     the pass, and the object is retried on the next one.
//   • BOUNDED: existence lookups go 500 ids at a time, and one pass deletes at
//     most PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN objects, oldest first; the
//     rest wait for the next day.
//
// No key material or blob contents are ever logged (the blob is opaque anyway —
// LZFSE + AES-GCM-256 under a per-profile DEK) — only counts.
//
// Needs, on the PRIVATE bucket: list (s3:ListBucket) and delete (s3:DeleteObject)
// on `profiles/`. Delete is what every profile purge already uses; list is the
// grant the in-process version already required.

import type { R2 } from '../lib/r2.js';
import type {
  ProfileBlobOrphanReap,
  ProfileBlobOrphanReapResult,
} from './account-deletion-purge-sweeper.js';

/**
 * Grace window (6h). MUST exceed the longest presigned save-back PUT a session
 * is given, so an in-flight save-back is never deleted mid-flight: a blob's
 * lastModified only advances while a valid PUT URL exists, so once a blob is
 * grace-old no live PUT could still be writing it. The save-back PUT is minted
 * for the session lifetime — up to MANUAL_SESSION_MAX_DURATION_SECONDS (4h) plus
 * a teardown margin (PROFILE_SAVE_BACK_PUT_TTL_SECONDS, 4.5h). ⚠️ If any caller
 * ever mints a LONGER save-back PUT TTL, raise this to stay above it.
 */
export const PROFILE_BLOB_ORPHAN_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * Deletes per pass. The pass is daily and orphans are the residue of a narrow
 * race, so a backlog above this is itself a finding; it drains at this rate,
 * oldest first, rather than in one unbounded pass.
 */
export const PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN = 500;

/** Existence lookups per query; bounds the IN list whatever the bucket holds. */
const EXISTENCE_BATCH = 500;

const SEALED_PREFIX = 'profiles/';

/**
 * `profiles/<uuid>.sealed` — anchored, and the uuid shape is spelled out rather
 * than approximated by a width.
 *
 * V-2007 — this was `[0-9a-f-]{36}`, which is 36 characters of hex-or-dash in ANY
 * arrangement: 36 dashes and 36 undashed hex digits both matched. The captured
 * value goes to `findExistingProfileIds`, which runs `inArray(profiles.id, chunk)`
 * against a Postgres `uuid` column, so one such key makes the query throw — and
 * a key that fails every pass stops ALL reclamation. The app only ever writes
 * `profileSealedBlobKey(<real uuid>)`, but a key can enter the bucket from
 * outside the app.
 */
const SEALED_KEY_RE =
  /^profiles\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sealed$/;

/** Minimal profiles-repo surface the reaper needs (existence check, trashed-inclusive). */
export interface ProfileBlobOrphanExistenceRepo {
  /** #158 — which of `ids` still have a profiles row (any account, INCLUDING trashed). */
  findExistingProfileIds(ids: string[]): Promise<Set<string>>;
}

export class ProfileBlobOrphanReaper implements ProfileBlobOrphanReap {
  private readonly graceMs: number;
  private readonly maxDeletes: number;

  constructor(
    private readonly privateBucket: Pick<R2, 'listObjects' | 'deleteObject'>,
    private readonly profiles: ProfileBlobOrphanExistenceRepo,
    opts: { graceMs?: number; maxDeletesPerRun?: number } = {},
  ) {
    this.graceMs = opts.graceMs ?? PROFILE_BLOB_ORPHAN_GRACE_MS;
    this.maxDeletes = opts.maxDeletesPerRun ?? PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN;
  }

  /**
   * One pass. Rejects when the listing or an existence lookup fails, having
   * deleted nothing that lookup covered; a failed delete is counted in `failed`
   * and the object stays for the next pass.
   */
  async reapOrphanedProfileBlobs(now: Date): Promise<ProfileBlobOrphanReapResult> {
    const objects = await this.privateBucket.listObjects(SEALED_PREFIX);
    const graceCutoff = now.getTime() - this.graceMs;

    // Candidates: a well-formed key, a known lastModified, older than the grace.
    // A null or too-young lastModified is skipped — the in-flight-write guard.
    const candidates: Array<{ key: string; uuid: string; at: number }> = [];
    for (const obj of objects) {
      const m = SEALED_KEY_RE.exec(obj.key);
      if (m === null) continue;
      if (obj.lastModified === null) continue;
      const at = obj.lastModified.getTime();
      if (at >= graceCutoff) continue;
      candidates.push({ key: obj.key, uuid: m[1]!, at });
    }
    // Oldest first, so a capped pass takes the longest-standing orphans.
    candidates.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));

    // The cap is checked before EACH delete, never once per batch: a batch
    // holding fewer orphans than the cap would otherwise be deleted whole and
    // the next one would start under the cap again. `capped` means an orphan
    // was FOUND and left for the next pass, so reaching the cap exactly does not
    // set it; the pass keeps asking (at most one more batch, when a backlog
    // exists) until it meets an orphan it must leave or runs out of candidates.
    // Every lookup is one an uncapped pass would make anyway.
    let reaped = 0;
    let failed = 0;
    let capped = false;
    for (let i = 0; i < candidates.length && !capped; i += EXISTENCE_BATCH) {
      const batch = candidates.slice(i, i + EXISTENCE_BATCH);
      // Trashed-inclusive: a uuid NOT in this set has no row at all.
      const existing = await this.profiles.findExistingProfileIds(batch.map((c) => c.uuid));
      for (const { key, uuid } of batch) {
        if (existing.has(uuid)) continue;
        if (reaped + failed >= this.maxDeletes) {
          capped = true;
          break;
        }
        try {
          await this.privateBucket.deleteObject(key);
          reaped += 1;
        } catch {
          failed += 1;
        }
      }
    }

    return { scanned: objects.length, reaped, failed, capped };
  }
}
