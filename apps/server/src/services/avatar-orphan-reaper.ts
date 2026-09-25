// Security sweep E-23 (2026-09-24) — avatar images no account points at.
//
// Removing or replacing an avatar now deletes the old objects
// (routes/account-me.ts), and the account-deletion purge deletes a terminated
// account's avatar. All three find the objects through the account's pointer
// and act only at the moment of a future event. That leaves every image removed
// or replaced BEFORE the fix on the public bucket for good: its pointer is
// already NULL, or names the newer image, so no later removal, upload or purge
// would ever select it. The same goes for an account that removed its avatar and
// was deleted afterwards, and for a replaced image whose cleanup delete failed
// (the upload only logs that).
//
// So this lists `avatars/` on the public bucket and deletes each object that is
// not its account's current avatar:
//
//   • only a key of exactly `avatars/<account uuid>.<png|jpg|webp|bin>` is
//     considered; anything else on the prefix is left alone, and never reaches
//     the uuid-typed pointer query (one malformed id would fail every pass);
//   • only an object OLDER than the grace window is a candidate. An upload
//     writes the object first and sets the pointer after, so a young object with
//     no pointer is an upload in flight, not an orphan. A null lastModified is
//     treated as young;
//   • an object that IS its account's current pointer is kept whatever the
//     account's status: a deleted account's avatar inside the retention window is
//     the purge arm's to delete, on time.
//
// Residual race, accepted: if the same account re-uploads the SAME format between
// this pass reading its pointer (NULL) and deleting the old object, the fresh
// image is deleted and the account shows no image until it uploads again. The
// window is one pointer read to one delete; the lookup is batched per 500 ids and
// each batch's deletes follow its read immediately to keep it that small.
//
// Needs list permission on the public bucket (the sibling profile-blob reaper
// needs the same on the private one). Without it, `listObjects` throws and the
// purge sweeper reports the arm as failed; nothing is deleted.

import type { R2 } from '../lib/r2.js';
import type { AvatarOrphanReap, AvatarOrphanReapResult } from './account-deletion-purge-sweeper.js';

/**
 * An upload is a put followed by one UPDATE, so its gap is milliseconds; an hour
 * leaves room for a slow request and for clock skew between the bucket and us.
 */
export const AVATAR_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Pointer lookups per query; bounds the IN list whatever the bucket holds. */
const POINTER_BATCH = 500;

const AVATAR_PREFIX = 'avatars/';

/** Every key `avatarKey` can produce, anchored, with the uuid shape spelled out. */
const AVATAR_KEY_RE =
  /^avatars\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:png|jpg|webp|bin)$/;

/** The accounts table as the reaper reads it. */
export interface AvatarPointerRepo {
  /**
   * For each id that has an accounts row (any status): its current
   * `avatar_r2_key`, or null when it has none. An id with no row is absent.
   */
  findAvatarKeysForAccounts(accountIds: readonly string[]): Promise<Map<string, string | null>>;
}

export class AvatarOrphanReaper implements AvatarOrphanReap {
  constructor(
    private readonly publicBucket: Pick<R2, 'listObjects' | 'deleteObject'>,
    private readonly accounts: AvatarPointerRepo,
    private readonly graceMs: number = AVATAR_ORPHAN_GRACE_MS,
  ) {}

  /**
   * One pass. Rejects only when the listing fails; a failed delete is counted in
   * `failed` and the object stays for the next pass.
   */
  async reapOrphanedAvatars(now: Date): Promise<AvatarOrphanReapResult> {
    const objects = await this.publicBucket.listObjects(AVATAR_PREFIX);
    const graceCutoff = now.getTime() - this.graceMs;

    const byAccount = new Map<string, string[]>();
    for (const obj of objects) {
      const m = AVATAR_KEY_RE.exec(obj.key);
      if (m === null) continue;
      if (obj.lastModified === null || obj.lastModified.getTime() >= graceCutoff) continue;
      const accountId = m[1]!;
      const keys = byAccount.get(accountId) ?? [];
      keys.push(obj.key);
      byAccount.set(accountId, keys);
    }

    let reaped = 0;
    let failed = 0;
    const ids = [...byAccount.keys()];
    for (let i = 0; i < ids.length; i += POINTER_BATCH) {
      const batch = ids.slice(i, i + POINTER_BATCH);
      const pointers = await this.accounts.findAvatarKeysForAccounts(batch);
      for (const accountId of batch) {
        const current = pointers.get(accountId) ?? null;
        for (const key of byAccount.get(accountId) ?? []) {
          if (key === current) continue;
          try {
            await this.publicBucket.deleteObject(key);
            reaped += 1;
          } catch {
            failed += 1;
          }
        }
      }
    }

    return { scanned: objects.length, reaped, failed };
  }
}
