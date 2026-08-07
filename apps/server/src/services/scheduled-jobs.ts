// V-202d — generic time-shifted job dispatcher built on the
// `scheduled_jobs` table. Per founder verdict (2026-05-05),
// V-173-pattern extension: bootstrap runs setInterval poller that
// calls `processTick(now)`; the service claims due jobs via
// SELECT ... FOR UPDATE SKIP LOCKED, dispatches each to its
// registered handler keyed by job_type, and marks complete (or
// retries on transient failure / fails permanently when attempts
// exhaust).
//
// Consumers register a handler keyed by job_type and enqueue rows —
// no new table per consumer. Live consumers: `auth_tokens.sweep`
// (expired auth-token GC), `sessions.duration_sweep` (free-tier
// session auto-destroy), `cost.recompute_nightly` (usage cost
// rollup). Each self-re-arms by enqueuing its next run from its own
// handler.

import type { Logger } from '../lib/logger.js';
import { redactText } from '../lib/redact-url.js';

const SCHEDULED_JOB_ERROR_MAX_CHARS = 500;
const SCHEDULED_JOB_ERROR_PRE_REDACT_MAX_CHARS = 2_000;

/** Durable scheduler diagnostics must be useful to operators without turning
 * provider-controlled exception text into an unbounded credential archive. */
function safeScheduledJobError(err: unknown): string {
  let raw: string;
  try {
    raw = err instanceof Error ? err.message : String(err);
  } catch {
    raw = 'scheduled job failed';
  }
  return redactText(raw.slice(0, SCHEDULED_JOB_ERROR_PRE_REDACT_MAX_CHARS)).slice(
    0,
    SCHEDULED_JOB_ERROR_MAX_CHARS,
  );
}

export interface ScheduledJobRow {
  id: string;
  jobType: string;
  accountId: string | null;
  payload: Record<string, unknown>;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueScheduledJobInput {
  jobType: string;
  accountId: string | null;
  payload: Record<string, unknown>;
  runAt: Date;
  /**
   * When true, `enqueue` no-ops if a pending job (completed_at IS NULL
   * AND failed_at IS NULL) already exists with the same
   * (account_id, job_type). Used to ensure one pending job per account
   * regardless of how many times the triggering event re-fires.
   */
  dedupOnAccountAndType?: boolean;
  /**
   * When set, only a distinct pending successor with run_at strictly after
   * this boundary suppresses enqueue. Self-arming handlers pass their current
   * job's runAt, which ignores the current/older duplicate cohort while a
   * committed future successor suppresses every peer or retry. Internal
   * scheduler primitive; leave unset for ordinary/bootstrap enqueue.
   */
  dedupAfterRunAt?: Date;
}

export interface ScheduledJobsRepo {
  enqueue(input: EnqueueScheduledJobInput): Promise<{ enqueued: boolean }>;
  /**
   * Atomically claim up to `batchSize` due jobs (run_at <= now,
   * not yet completed/failed, not currently locked). Sets
   * locked_by + locked_at + increments attempts. The implementation
   * MUST use SELECT ... FOR UPDATE SKIP LOCKED so concurrent workers
   * never claim the same row.
   */
  claimDue(opts: { batchSize: number; now: Date; workerId: string }): Promise<ScheduledJobRow[]>;
  /**
   * Job types that currently have at least one PENDING row (not completed, not
   * failed). Used as a liveness probe on the self-re-arming chains.
   *
   * A recurring sweep survives by enqueueing its own successor, so exactly one
   * pending row is its steady state. Zero pending rows means the chain is dead
   * and stays dead until a process restart — the failure every register* helper
   * warns about in its own comments — and nothing detects it today.
   */
  jobTypesWithPendingWork(): Promise<string[]>;
  /**
   * Settle a job THIS worker still holds the lock on. All three settles are
   * fenced on `locked_by = workerId` and report whether the fence matched.
   *
   * V-747 — they used to key on `id` alone. claimDue re-claims any row whose
   * `locked_at` is older than the 5-minute stale window WITHOUT excluding the
   * current worker's own still-running job, so a handler that overruns that
   * window is re-claimed and re-run while the first invocation is still going.
   * With an unfenced settle the slow invocation then wrote through: it could
   * mark a job complete that the new owner is still running, or — worse —
   * `markRetry` a job the new owner had already completed, re-arming `run_at`
   * and running a side-effecting sweep a third time. `false` means this worker
   * no longer owned the row, which is the only in-band signal that an overrun
   * (and therefore a duplicate execution) happened.
   */
  markComplete(jobId: string, at: Date, workerId: string): Promise<boolean>;
  markRetry(
    jobId: string,
    opts: { lastError: string; nextRunAt: Date; workerId: string },
  ): Promise<boolean>;
  markFailed(
    jobId: string,
    opts: { lastError: string; at: Date; workerId: string },
  ): Promise<boolean>;
  /**
   * W441 retention — hard-delete finished rows (completed OR failed) whose
   * terminal timestamp is older than `olderThan`. Returns the deleted count.
   */
  pruneFinished(olderThan: Date): Promise<number>;
}

export type ScheduledJobHandler = (job: ScheduledJobRow) => Promise<void>;

export interface ScheduledJobsServiceConfig {
  /** Batch size per tick. */
  batchSize?: number;
  /** Backoff for retries: ms = base * 2^(attempts-1). */
  retryBackoffBaseMs?: number;
  /** Identifier for this worker process; written to locked_by. */
  workerId: string;
}

export class ScheduledJobsService {
  private readonly handlers = new Map<string, ScheduledJobHandler>();
  private readonly batchSize: number;
  private readonly retryBackoffBaseMs: number;
  private readonly workerId: string;

  constructor(
    private readonly repo: ScheduledJobsRepo,
    private readonly logger: Logger,
    config: ScheduledJobsServiceConfig,
  ) {
    this.batchSize = config.batchSize ?? 25;
    this.retryBackoffBaseMs = config.retryBackoffBaseMs ?? 60_000;
    this.workerId = config.workerId;
  }

  /** Register a handler for a job_type. Last-write-wins if called twice. */
  register(jobType: string, handler: ScheduledJobHandler): void {
    this.handlers.set(jobType, handler);
  }

  enqueue(input: EnqueueScheduledJobInput): Promise<{ enqueued: boolean }> {
    return this.repo.enqueue(input);
  }

  /**
   * One scheduler tick. Claims due jobs, runs handlers, marks each
   * complete / retry / failed. Returns the count of jobs processed
   * (claimed + dispatched), useful for tests + ops metrics.
   */
  async processTick(now: Date): Promise<{ processed: number }> {
    const due = await this.repo.claimDue({
      batchSize: this.batchSize,
      now,
      workerId: this.workerId,
    });
    if (due.length === 0) return { processed: 0 };

    await Promise.all(due.map((job) => this.runOne(job, now)));
    // Info log on the rare non-empty tick — gives ops/founder a
    // single-line audit trail when cadence-fire jobs (auth-tokens
    // sweep, cost nightly, session duration sweep) actually fire,
    // without flooding logs on the 60s empty-tick majority.
    this.logger.info(
      {
        component: 'scheduled-jobs',
        processed: due.length,
        jobTypes: Array.from(new Set(due.map((j) => j.jobType))),
      },
      'scheduled-jobs tick processed due jobs',
    );
    return { processed: due.length };
  }

  /**
   * V-747 — a settle that matched 0 rows means claimDue handed this job to
   * another claim while this invocation was still running (the handler outran the
   * 5-minute stale-lock window). The write was correctly discarded, but the
   * duplicate execution already happened, so say so loudly: side-effecting sweeps
   * ran twice and each re-claim also burned a retry attempt.
   */
  private reportLostLock(job: ScheduledJobRow, settle: string): void {
    this.logger.error(
      {
        component: 'scheduled-jobs',
        event: 'scheduled_job_lock_lost_before_settle',
        jobId: job.id,
        jobType: job.jobType,
        accountId: job.accountId,
        attempts: job.attempts,
        settle,
      },
      'job lock was lost before settling — the handler outran the stale-lock window and this job was re-claimed and RUN AGAIN concurrently; this write was discarded (integrity alarm)',
    );
  }

  private async runOne(job: ScheduledJobRow, now: Date): Promise<void> {
    const handler = this.handlers.get(job.jobType);
    if (!handler) {
      this.logger.warn(
        {
          component: 'scheduled-jobs',
          jobId: job.id,
          jobType: job.jobType,
          accountId: job.accountId,
        },
        'no handler registered for job_type — marking failed (operator should register or delete)',
      );
      if (
        !(await this.repo.markFailed(job.id, {
          lastError: `no handler registered for job_type=${job.jobType}`,
          at: now,
          workerId: this.workerId,
        }))
      ) {
        this.reportLostLock(job, 'markFailed:no-handler');
      }
      return;
    }

    try {
      await handler(job);
      if (!(await this.repo.markComplete(job.id, now, this.workerId))) {
        this.reportLostLock(job, 'markComplete');
      }
    } catch (err) {
      const message = safeScheduledJobError(err);
      const exhausted = job.attempts >= job.maxAttempts;
      if (exhausted) {
        this.logger.error(
          {
            component: 'scheduled-jobs',
            jobId: job.id,
            jobType: job.jobType,
            accountId: job.accountId,
            attempts: job.attempts,
            err: { message },
          },
          'job failed permanently — attempts exhausted',
        );
        if (
          !(await this.repo.markFailed(job.id, {
            lastError: message,
            at: now,
            workerId: this.workerId,
          }))
        ) {
          this.reportLostLock(job, 'markFailed:exhausted');
        }
      } else {
        // Exponential backoff: 60s, 120s, 240s, ... per default base.
        const backoffMs = this.retryBackoffBaseMs * 2 ** Math.max(0, job.attempts - 1);
        const nextRunAt = new Date(now.getTime() + backoffMs);
        this.logger.warn(
          {
            component: 'scheduled-jobs',
            jobId: job.id,
            jobType: job.jobType,
            accountId: job.accountId,
            attempts: job.attempts,
            nextRunAt,
            err: { message },
          },
          'job failed — scheduling retry',
        );
        if (
          !(await this.repo.markRetry(job.id, {
            lastError: message,
            nextRunAt,
            workerId: this.workerId,
          }))
        ) {
          this.reportLostLock(job, 'markRetry');
        }
      }
    }
  }
}
