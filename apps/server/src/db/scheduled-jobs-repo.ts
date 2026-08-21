// V-202d — Drizzle implementation of ScheduledJobsRepo.

import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { scheduledJobs } from './schema.js';
import type {
  EnqueueScheduledJobInput,
  ScheduledJobRow,
  ScheduledJobsRepo,
} from '../services/scheduled-jobs.js';

function parseClaimedRunAt(value: unknown): Date {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (parsed === null || !Number.isFinite(parsed.getTime())) {
    throw new TypeError('scheduled_jobs.run_at returned an invalid timestamp');
  }
  return parsed;
}

// V-1247 — how long a held lock may go untouched before another worker may reclaim the
// job. Exported because the in-memory double carried its own `const STALE_LOCK_MS =
// 5 * 60_000`: the same policy window written twice, agreeing only until somebody widened
// one of them. Widening it here would have left the double reclaiming after five minutes
// while production waited longer, and every test standing on the double would have gone on
// asserting the old cadence and agreeing with itself.
//
// This is a RECOVERY window, not a timeout: it decides how long a job sits unworked after
// a worker dies mid-flight. Too short and two workers run the same job concurrently; too
// long and a crashed worker's jobs stall for that long.
export const SCHEDULED_JOB_STALE_LOCK_MS = 5 * 60_000;

export class DrizzleScheduledJobsRepo implements ScheduledJobsRepo {
  constructor(private readonly database: Database) {}

  async enqueue(input: EnqueueScheduledJobInput): Promise<{ enqueued: boolean }> {
    if (input.dedupOnAccountAndType === true) {
      // A SELECT followed by INSERT without serialization lets two bootstrap
      // replicas both observe an empty queue and create parallel chains. Lock
      // the canonical tuple for this transaction, recheck, and insert before
      // releasing it. hashtextextended supplies a stable 64-bit advisory-lock
      // key without requiring a schema/index migration.
      const dedupLockTuple = JSON.stringify([input.accountId, input.jobType]);
      return this.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${dedupLockTuple}, 0))`);
        // Caught in prod 2026-05-20: 13 pending auth_tokens.sweep rows
        // accumulated across service restarts because of a missed NULL branch.
        // accountId may be null for global jobs (e.g. auth_tokens.sweep) —
        // handle it explicitly because `col = NULL` is never true in SQL.
        const existing = await tx
          .select({ id: scheduledJobs.id })
          .from(scheduledJobs)
          .where(
            and(
              input.accountId === null
                ? isNull(scheduledJobs.accountId)
                : eq(scheduledJobs.accountId, input.accountId),
              eq(scheduledJobs.jobType, input.jobType),
              isNull(scheduledJobs.completedAt),
              isNull(scheduledJobs.failedAt),
              input.dedupAfterRunAt === undefined
                ? undefined
                : gt(scheduledJobs.runAt, input.dedupAfterRunAt),
            ),
          )
          .limit(1);
        if (existing.length > 0) return { enqueued: false };

        await tx.insert(scheduledJobs).values({
          jobType: input.jobType,
          accountId: input.accountId,
          payload: input.payload,
          runAt: input.runAt,
        });
        return { enqueued: true };
      });
    }

    await this.database.db.insert(scheduledJobs).values({
      jobType: input.jobType,
      accountId: input.accountId,
      payload: input.payload,
      runAt: input.runAt,
    });
    return { enqueued: true };
  }

  async claimDue(opts: {
    batchSize: number;
    now: Date;
    workerId: string;
  }): Promise<ScheduledJobRow[]> {
    // Atomic claim via CTE + UPDATE ... FROM ... RETURNING. The inner
    // SELECT picks unfinished, due rows with FOR UPDATE SKIP LOCKED so
    // concurrent workers never claim the same row. The outer UPDATE
    // sets locked_by + locked_at + increments attempts, then RETURNING
    // gives us back the claimed rows.
    //
    // Date params pre-serialized to ISO strings: drizzle-orm 0.38.4's
    // construct(client) swaps postgres-js's OID 1184/1082/1083/1114
    // serializers with a no-op (val) => val transparentParser; that
    // leaves Date instances in postgres-js's Bind step where
    // Buffer.byteLength crashes with ERR_INVALID_ARG_TYPE. drizzle's
    // table-builder API (db.update().set({date})) pre-serializes via
    // column-schema metadata before postgres-js sees the value, but raw
    // sql template literals like this one feed Dates through directly.
    // Sending the ISO string passes through transparentParser unchanged
    // and postgres parses it as timestamptz on the server.
    const nowIso = opts.now.toISOString();
    const lockStaleAtIso = new Date(opts.now.getTime() - SCHEDULED_JOB_STALE_LOCK_MS).toISOString();
    const result = await this.database.db.execute<{
      id: string;
      job_type: string;
      account_id: string | null;
      payload: Record<string, unknown>;
      run_at: unknown;
      attempts: number;
      max_attempts: number;
    }>(sql`
      WITH due AS (
        SELECT id
          FROM scheduled_jobs
         WHERE run_at <= ${nowIso}
           AND completed_at IS NULL
           AND failed_at IS NULL
           AND (locked_by IS NULL OR locked_at < ${lockStaleAtIso})
         ORDER BY run_at ASC
         LIMIT ${opts.batchSize}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE scheduled_jobs sj
         SET locked_by   = ${opts.workerId},
             locked_at   = ${nowIso},
             attempts    = sj.attempts + 1,
             updated_at  = ${nowIso}
        FROM due
       WHERE sj.id = due.id
       RETURNING sj.id, sj.job_type, sj.account_id, sj.payload, sj.run_at,
                 sj.attempts, sj.max_attempts;
    `);

    // postgres-js returns rows as a typed array.
    const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown[]);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      jobType: r.job_type as string,
      accountId: (r.account_id as string | null) ?? null,
      payload: (r.payload as Record<string, unknown>) ?? {},
      // Raw db.execute() rows bypass Drizzle's column-schema timestamp
      // decoder and postgres-js returns timestamptz as an ISO string in the
      // production driver configuration. Normalize at this repository
      // boundary: self-arming handlers pass runAt back through Drizzle's
      // timestamp mapper, which correctly requires a real Date.
      runAt: parseClaimedRunAt(r.run_at),
      attempts: r.attempts as number,
      maxAttempts: r.max_attempts as number,
    }));
  }

  async jobTypesWithPendingWork(): Promise<string[]> {
    const rows = await this.database.client<Array<{ job_type: string }>>`
      SELECT DISTINCT job_type
      FROM scheduled_jobs
      WHERE completed_at IS NULL AND failed_at IS NULL`;
    return rows.map((r) => r.job_type);
  }

  // V-747 — every settle is fenced on `locked_by = workerId` and returns whether
  // it matched. claimDue re-claims a row whose lock is older than the 5-minute
  // stale window without excluding the current worker's own running job, so an
  // overrunning handler's late write must not land on a row someone else now owns
  // (it could complete a job still running, or markRetry one already completed and
  // re-run a side-effecting sweep). RETURNING id tells the caller which happened.
  async markComplete(jobId: string, at: Date, workerId: string): Promise<boolean> {
    const rows = await this.database.db
      .update(scheduledJobs)
      .set({ completedAt: at, lockedBy: null, lockedAt: null, updatedAt: at })
      .where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.lockedBy, workerId)))
      .returning({ id: scheduledJobs.id });
    return rows.length > 0;
  }

  async markRetry(
    jobId: string,
    opts: { lastError: string; nextRunAt: Date; workerId: string },
  ): Promise<boolean> {
    const rows = await this.database.db
      .update(scheduledJobs)
      .set({
        runAt: opts.nextRunAt,
        lastError: opts.lastError,
        lockedBy: null,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.lockedBy, opts.workerId)))
      .returning({ id: scheduledJobs.id });
    return rows.length > 0;
  }

  async markFailed(
    jobId: string,
    opts: { lastError: string; at: Date; workerId: string },
  ): Promise<boolean> {
    const rows = await this.database.db
      .update(scheduledJobs)
      .set({
        failedAt: opts.at,
        lastError: opts.lastError,
        lockedBy: null,
        lockedAt: null,
        updatedAt: opts.at,
      })
      .where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.lockedBy, opts.workerId)))
      .returning({ id: scheduledJobs.id });
    return rows.length > 0;
  }

  // W441 — retention prune. Hard-deletes finished rows (completed OR failed)
  // whose terminal timestamp is older than `olderThan`. Uses the drizzle
  // builder API (not a raw sql template) so the Date is serialized via the
  // column-schema metadata — raw `sql\`…${date}…\`` would crash postgres-js's
  // Bind step (see claimDue's note). RETURNING gives the deleted count.
  async pruneFinished(olderThan: Date): Promise<number> {
    const deleted = await this.database.db
      .delete(scheduledJobs)
      .where(
        or(
          and(isNotNull(scheduledJobs.completedAt), lt(scheduledJobs.completedAt, olderThan)),
          and(isNotNull(scheduledJobs.failedAt), lt(scheduledJobs.failedAt, olderThan)),
        ),
      )
      .returning({ id: scheduledJobs.id });
    return deleted.length;
  }
}
