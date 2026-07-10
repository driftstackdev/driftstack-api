// 2026-06-16 — recycle-bin retention purge sweeper (L4b Step 4).
//
// Profile delete is a SOFT delete (deletedAt set; row + wrapped DEK survive so
// the customer can restore from the Trash view). This sweeper closes the loop:
// trashed profiles older than the retention window are HARD-deleted, removing
// the row and its wrapped DEK. Without it, trashed rows + DEKs accumulate
// forever (same stale-row class as the auth-tokens sweep this mirrors).
//
// Retention: PROFILE_TRASH_RETENTION_DAYS (30) after deletedAt. Generous so a
// customer who trashed a profile by mistake has a month to restore it.
//
// Scheduling: daily at 04:00 UTC (staggered one hour after the 03:00 auth-token
// sweep so the two don't contend). Exposes tickOnce(now) as the testable unit;
// registerProfileTrashPurgeJob wires it into the scheduled-jobs poller and
// re-arms after each run (dedup OFF on the in-handler re-arm — see the
// auth-tokens-sweeper JSDoc for the locked-in-flight-job reasoning).

import type { ProfilesRepo } from './profiles.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';
import { profileSealedBlobKey, type R2 } from '../lib/r2.js';

export const PROFILE_TRASH_PURGE_JOB_TYPE = 'profile_trash.purge';

const PROFILE_TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProfileTrashPurgeSweeperDeps {
  readonly repo: ProfilesRepo;
  /** Days a trashed profile is retained before purge. Defaults to 30. */
  readonly retentionDays?: number;
  /**
   * R2 client for the profiles' sealed-blob store. When wired, each purged
   * profile's `profiles/<id>.sealed` object is best-effort deleted so the
   * encrypted bytes don't orphan in R2 forever. Null/undefined (R2 not
   * configured) → DB-only purge, unchanged. The `logger` records a
   * best-effort delete failure (the DB row is already gone — a left-behind
   * blob is opaque + inert, so we log and move on, never throw).
   */
  readonly r2?: R2 | null;
  readonly logger?: Logger;
}

export interface ProfileTrashPurgeResult {
  readonly purged: number;
  /** doc-150 — count of purged sealed blobs the R2 cleanup deleted (0 when R2
   *  is unwired or every purged profile had never been saved). */
  readonly blobsDeleted: number;
}

export class ProfileTrashPurgeSweeperService {
  private readonly retentionMs: number;

  constructor(private readonly deps: ProfileTrashPurgeSweeperDeps) {
    this.retentionMs = (deps.retentionDays ?? PROFILE_TRASH_RETENTION_DAYS) * DAY_MS;
  }

  async tickOnce(now: Date): Promise<ProfileTrashPurgeResult> {
    const cutoff = new Date(now.getTime() - this.retentionMs);
    const purgedIds = await this.deps.repo.purgeTrashedBefore(cutoff);
    // Best-effort R2 cleanup of each purged profile's orphaned sealed blob.
    // R2 DELETE is idempotent (a never-saved profile's missing blob is a no-op
    // 204), so we delete unconditionally. A failure is logged, never thrown —
    // the DB row is already gone and the blob is opaque + inert.
    let blobsDeleted = 0;
    const r2 = this.deps.r2;
    if (r2 !== undefined && r2 !== null) {
      for (const id of purgedIds) {
        try {
          await r2.deleteObject(profileSealedBlobKey(id));
          blobsDeleted += 1;
        } catch (err) {
          this.deps.logger?.error?.(
            { component: 'profile-trash-purge', profileId: id, err },
            'failed to delete purged profile sealed-blob from R2 (orphan left behind)',
          );
        }
      }
    }
    return { purged: purgedIds.length, blobsDeleted };
  }
}

export interface RegisterProfileTrashPurgeJobOpts {
  scheduledJobs: ScheduledJobsService;
  sweeper: ProfileTrashPurgeSweeperService;
  logger: Logger;
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

/**
 * Wire the sweeper onto the ScheduledJobsService.
 *
 * Chain survival: the re-arm must run even if `tickOnce` throws. If it did not,
 * a throw would leave no re-arm, the poller would retry the job, and once
 * `maxAttempts` is exhausted the job is markFailed with NO pending purge row —
 * the self-re-arming chain is then dead until a process restart and NO trashed
 * profile is ever hard-deleted again (soft-deleted rows + their wrapped DEKs
 * accumulate forever). We therefore SWALLOW a tick failure (logging it) and
 * re-arm exactly once. We must NOT re-throw-and-re-arm-in-`finally`: the poller
 * would retry the same job and each attempt would re-arm → duplicate parallel
 * chains (fan-out). The tick is idempotent (purgeTrashedBefore re-lists any rows
 * this one missed next run), so a swallowed failure loses nothing.
 */
export function registerProfileTrashPurgeJob(opts: RegisterProfileTrashPurgeJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(PROFILE_TRASH_PURGE_JOB_TYPE, async (_job: ScheduledJobRow) => {
    try {
      const result = await opts.sweeper.tickOnce(new Date(now()));
      opts.logger.info?.(
        {
          component: 'profile-trash-purge',
          purged: result.purged,
          blobsDeleted: result.blobsDeleted,
        },
        'profile-trash purge sweep complete',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.error?.(
        {
          component: 'profile-trash-purge',
          event: 'profile_trash_purge_tick_failed',
          err: { message },
        },
        'profile-trash purge tick failed — re-arming; rows retry next run',
      );
    }
    // Re-arm with dedup OFF — the in-flight (still-locked, not-yet-completed)
    // job would otherwise be seen as a pending duplicate and block the
    // re-enqueue, killing the chain. See the auth-tokens-sweeper JSDoc. This
    // runs OUTSIDE the try above so a tick failure never skips the re-arm.
    await enqueueNextProfileTrashPurge({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      dedup: false,
    });
  });
}

/**
 * Enqueue the next purge at 04:00 UTC strictly after `now`. dedup:true for the
 * bootstrap enqueue (one chain across restarts); dedup:false for the in-handler
 * re-arm (the current job is still locked + non-completed, so dedup:true would
 * no-op every re-arm and kill the chain).
 */
export async function enqueueNextProfileTrashPurge(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  dedup?: boolean;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: PROFILE_TRASH_PURGE_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: nextPurgeRunAt(new Date(now)),
    dedupOnAccountAndType: opts.dedup ?? true,
  });
}

/** Returns 04:00 UTC strictly after `now`. */
export function nextPurgeRunAt(now: Date): Date {
  const next = new Date(now.getTime());
  next.setUTCHours(4, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}
