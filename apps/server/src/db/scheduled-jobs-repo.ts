// V-202d — Drizzle implementation of ScheduledJobsRepo.

import { and, eq, isNull, sql } from 'drizzle-orm';
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
    if (input.dedupOnAccountAndType === true && input.accountId !== null) {
      // Check for an existing pending job of the same (account_id, job_type).
      const existing = await this.database.db
        .select({ id: scheduledJobs.id })
        .from(scheduledJobs)
        .where(
          and(
            eq(scheduledJobs.accountId, input.accountId),
            eq(scheduledJobs.jobType, input.jobType),
            isNull(scheduledJobs.completedAt),
            isNull(scheduledJobs.failedAt),
          ),
        )
        .limit(1);
      if (existing.length > 0) return { enqueued: false };
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
         WHERE run_at <= ${opts.now}
           AND completed_at IS NULL
           AND failed_at IS NULL
           AND (locked_by IS NULL OR locked_at < ${new Date(opts.now.getTime() - 5 * 60_000)})
         ORDER BY run_at ASC
         LIMIT ${opts.batchSize}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE scheduled_jobs sj
         SET locked_by   = ${opts.workerId},
             locked_at   = ${opts.now},
             attempts    = sj.attempts + 1,
             updated_at  = ${opts.now}
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
}
