// V-202d — in-memory ScheduledJobsRepo for integration + unit tests.

import { randomUUID } from 'node:crypto';
import type {
  EnqueueScheduledJobInput,
  ScheduledJobRow,
  ScheduledJobsRepo,
} from '../../../src/services/scheduled-jobs.js';
import { SCHEDULED_JOB_STALE_LOCK_MS } from '../../../src/db/scheduled-jobs-repo.js';

interface InMemoryRow {
  id: string;
  jobType: string;
  accountId: string | null;
  payload: Record<string, unknown>;
  runAt: Date;
  lockedBy: string | null;
  lockedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  lastError: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

// V-1247 — the stale-lock window is read from DrizzleScheduledJobsRepo rather than
// restated. It used to be its own `5 * 60_000`: the same policy window twice over.
const STALE_LOCK_MS = SCHEDULED_JOB_STALE_LOCK_MS;

export class InMemoryScheduledJobsRepo implements ScheduledJobsRepo {
  private readonly rows = new Map<string, InMemoryRow>();

  /** Test seam — read full row for assertions. */
  read(id: string): InMemoryRow | undefined {
    const r = this.rows.get(id);
    return r ? { ...r } : undefined;
  }

  /** Test seam — list all rows. */
  all(): InMemoryRow[] {
    return Array.from(this.rows.values()).map((r) => ({ ...r }));
  }

  enqueue(input: EnqueueScheduledJobInput): Promise<{ enqueued: boolean }> {
    // Mirror DrizzleScheduledJobsRepo: dedup applies for ANY accountId,
    // null INCLUDED (global jobs like auth_tokens.sweep / cost.recompute_
    // nightly). The real repo uses isNull() for the null branch + eq() for
    // the set branch; here `r.accountId === input.accountId` covers both
    // (null === null is true). Skipping the null case was the prod
    // 2026-05-20 bug — 13 pending auth_tokens.sweep rows accumulated across
    // restarts — so the mock must dedup null too or it masks that bug.
    if (input.dedupOnAccountAndType === true) {
      for (const r of this.rows.values()) {
        if (
          r.accountId === input.accountId &&
          r.jobType === input.jobType &&
          r.completedAt === null &&
          r.failedAt === null
        ) {
          return Promise.resolve({ enqueued: false });
        }
      }
    }

    const id = randomUUID();
    const now = new Date();
    this.rows.set(id, {
      id,
      jobType: input.jobType,
      accountId: input.accountId,
      payload: input.payload,
      runAt: input.runAt,
      lockedBy: null,
      lockedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
    });
    return Promise.resolve({ enqueued: true });
  }

  claimDue(opts: { batchSize: number; now: Date; workerId: string }): Promise<ScheduledJobRow[]> {
    const due: InMemoryRow[] = [];
    for (const r of this.rows.values()) {
      if (r.completedAt !== null || r.failedAt !== null) continue;
      if (r.runAt.getTime() > opts.now.getTime()) continue;
      // Skip if currently locked + lock is fresh.
      if (r.lockedBy !== null && r.lockedAt !== null) {
        const lockAgeMs = opts.now.getTime() - r.lockedAt.getTime();
        if (lockAgeMs < STALE_LOCK_MS) continue;
      }
      due.push(r);
    }
    // V-1213 — sort BEFORE applying the batch limit, mirroring the Drizzle repo's
    // `ORDER BY run_at ASC LIMIT $batchSize`. This used to break out of the loop at batchSize and
    // sort what it had already taken, which orders an arbitrary subset: under a backlog the oldest
    // due job could be passed over indefinitely, and nothing else would advance it.
    due.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
    const batch = due.slice(0, opts.batchSize);

    const claimed: ScheduledJobRow[] = [];
    for (const r of batch) {
      const updated: InMemoryRow = {
        ...r,
        lockedBy: opts.workerId,
        lockedAt: opts.now,
        attempts: r.attempts + 1,
      };
      this.rows.set(r.id, updated);
      claimed.push({
        id: updated.id,
        jobType: updated.jobType,
        accountId: updated.accountId,
        payload: updated.payload,
        runAt: updated.runAt,
        attempts: updated.attempts,
        maxAttempts: updated.maxAttempts,
      });
    }
    return Promise.resolve(claimed);
  }

  /**
   * Job types with a pending row. Mirrors the Drizzle repo: a recurring sweep
   * re-arms itself, so one pending row is its steady state and zero means the
   * chain is dead. The liveness gauge reads this.
   */
  jobTypesWithPendingWork(): Promise<string[]> {
    const pending = Array.from(this.rows.values())
      .filter((r) => r.completedAt === null && r.failedAt === null)
      .map((r) => r.jobType);
    return Promise.resolve([...new Set(pending)]);
  }

  // V-747 — mirrors the Drizzle fence: a settle only lands if this worker still
  // holds the lock, and reports whether it did.
  markComplete(jobId: string, at: Date, workerId: string): Promise<boolean> {
    const r = this.rows.get(jobId);
    if (!r || r.lockedBy !== workerId) return Promise.resolve(false);
    this.rows.set(jobId, { ...r, completedAt: at, lockedBy: null, lockedAt: null });
    return Promise.resolve(true);
  }

  markRetry(
    jobId: string,
    opts: { lastError: string; nextRunAt: Date; workerId: string },
  ): Promise<boolean> {
    const r = this.rows.get(jobId);
    if (!r || r.lockedBy !== opts.workerId) return Promise.resolve(false);
    this.rows.set(jobId, {
      ...r,
      runAt: opts.nextRunAt,
      lastError: opts.lastError,
      lockedBy: null,
      lockedAt: null,
    });
    return Promise.resolve(true);
  }

  markFailed(
    jobId: string,
    opts: { lastError: string; at: Date; workerId: string },
  ): Promise<boolean> {
    const r = this.rows.get(jobId);
    if (!r || r.lockedBy !== opts.workerId) return Promise.resolve(false);
    this.rows.set(jobId, {
      ...r,
      failedAt: opts.at,
      lastError: opts.lastError,
      lockedBy: null,
      lockedAt: null,
    });
    return Promise.resolve(true);
  }

  // W441 — mirror DrizzleScheduledJobsRepo.pruneFinished: delete finished rows
  // (completed OR failed) whose terminal timestamp is older than `olderThan`.
  pruneFinished(olderThan: Date): Promise<number> {
    let deleted = 0;
    for (const r of this.rows.values()) {
      const terminal =
        (r.completedAt !== null && r.completedAt < olderThan) ||
        (r.failedAt !== null && r.failedAt < olderThan);
      if (terminal) {
        this.rows.delete(r.id);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}
