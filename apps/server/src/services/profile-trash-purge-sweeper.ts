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

export const PROFILE_TRASH_PURGE_JOB_TYPE = 'profile_trash.purge';

const PROFILE_TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProfileTrashPurgeSweeperDeps {
  readonly repo: ProfilesRepo;
  /** Days a trashed profile is retained before purge. Defaults to 30. */
  readonly retentionDays?: number;
}

export interface ProfileTrashPurgeResult {
  readonly purged: number;
}

export class ProfileTrashPurgeSweeperService {
  private readonly retentionMs: number;

  constructor(private readonly deps: ProfileTrashPurgeSweeperDeps) {
    this.retentionMs = (deps.retentionDays ?? PROFILE_TRASH_RETENTION_DAYS) * DAY_MS;
  }

  async tickOnce(now: Date): Promise<ProfileTrashPurgeResult> {
    const cutoff = new Date(now.getTime() - this.retentionMs);
    const purged = await this.deps.repo.purgeTrashedBefore(cutoff);
    return { purged };
  }
}

export interface RegisterProfileTrashPurgeJobOpts {
  scheduledJobs: ScheduledJobsService;
  sweeper: ProfileTrashPurgeSweeperService;
  logger: Logger;
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

export function registerProfileTrashPurgeJob(opts: RegisterProfileTrashPurgeJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(PROFILE_TRASH_PURGE_JOB_TYPE, async (_job: ScheduledJobRow) => {
    const result = await opts.sweeper.tickOnce(new Date(now()));
    opts.logger.info?.(
      { component: 'profile-trash-purge', purged: result.purged },
      'profile-trash purge sweep complete',
    );
    // Re-arm with dedup OFF — the in-flight (still-locked, not-yet-completed)
    // job would otherwise be seen as a pending duplicate and block the
    // re-enqueue, killing the chain. See the auth-tokens-sweeper JSDoc.
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
