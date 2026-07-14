// V-202d — Drizzle implementation of ScheduledJobsRepo.

import { and, eq, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { scheduledJobs } from './schema.js';
import type {
  EnqueueScheduledJobInput,
  ScheduledJobRow,
  ScheduledJobsRepo,
} from '../services/scheduled-jobs.js';

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
              input.dedupExcludeJobId === undefined
                ? undefined
                : ne(scheduledJobs.id, input.dedupExcludeJobId),
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
    const lockStaleAtIso = new Date(opts.now.getTime() - 5 * 60_000).toISOString();
    const result = await this.database.db.execute<{
      id: string;
      job_type: string;
      account_id: string | null;
      payload: Record<string, unknown>;
      run_at: Date;
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
      runAt: r.run_at as Date,
      attempts: r.attempts as number,
      maxAttempts: r.max_attempts as number,
    }));
  }

  async markComplete(jobId: string, at: Date): Promise<void> {
    await this.database.db
      .update(scheduledJobs)
      .set({ completedAt: at, lockedBy: null, lockedAt: null, updatedAt: at })
      .where(eq(scheduledJobs.id, jobId));
  }

  async markRetry(jobId: string, opts: { lastError: string; nextRunAt: Date }): Promise<void> {
    await this.database.db
      .update(scheduledJobs)
      .set({
        runAt: opts.nextRunAt,
        lastError: opts.lastError,
        lockedBy: null,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(scheduledJobs.id, jobId));
  }

  async markFailed(jobId: string, opts: { lastError: string; at: Date }): Promise<void> {
    await this.database.db
      .update(scheduledJobs)
      .set({
        failedAt: opts.at,
        lastError: opts.lastError,
        lockedBy: null,
        lockedAt: null,
        updatedAt: opts.at,
      })
      .where(eq(scheduledJobs.id, jobId));
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
