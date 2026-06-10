// W441 — scheduled_jobs prune sweeper: registration + prune-cutoff + re-arm
// contract. Mirrors the session-duration-sweeper scheduling test (the re-arm
// MUST survive an in-flight job via dedup:false, else the chain dies after one
// run).
import { describe, it, expect } from 'vitest';
import type {
  EnqueueScheduledJobInput,
  ScheduledJobHandler,
  ScheduledJobsRepo,
  ScheduledJobsService,
} from '../../src/services/scheduled-jobs.js';
import type { Logger } from '../../src/lib/logger.js';
import {
  SCHEDULED_JOBS_PRUNE_JOB_TYPE,
  SCHEDULED_JOBS_PRUNE_INTERVAL_MS,
  SCHEDULED_JOBS_PRUNE_RETENTION_MS,
  registerScheduledJobsPruneJob,
  enqueueNextScheduledJobsPrune,
} from '../../src/services/scheduled-jobs-prune-sweeper.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as unknown as Logger;

class FakeScheduledJobs {
  handlers = new Map<string, ScheduledJobHandler>();
  jobs: Array<{ jobType: string; accountId: string | null; runAt: Date; completed: boolean }> = [];
  register(jobType: string, handler: ScheduledJobHandler): void {
    this.handlers.set(jobType, handler);
  }
  enqueue(input: EnqueueScheduledJobInput): Promise<{ enqueued: boolean }> {
    if (input.dedupOnAccountAndType) {
      const dup = this.jobs.some(
        (j) => !j.completed && j.jobType === input.jobType && j.accountId === input.accountId,
      );
      if (dup) return Promise.resolve({ enqueued: false });
    }
    this.jobs.push({
      jobType: input.jobType,
      accountId: input.accountId,
      runAt: input.runAt,
      completed: false,
    });
    return Promise.resolve({ enqueued: true });
  }
  getHandler(jobType: string): ScheduledJobHandler {
    const h = this.handlers.get(jobType);
    if (!h) throw new Error(`no handler registered for ${jobType}`);
    return h;
  }
  pendingOfType(jobType: string): number {
    return this.jobs.filter((j) => !j.completed && j.jobType === jobType).length;
  }
}

function fakeRepo(): { repo: ScheduledJobsRepo; cutoffs: Date[] } {
  const cutoffs: Date[] = [];
  const repo = {
    pruneFinished: (olderThan: Date) => {
      cutoffs.push(olderThan);
      return Promise.resolve(3);
    },
  } as unknown as ScheduledJobsRepo;
  return { repo, cutoffs };
}

const NOW_MS = Date.parse('2026-06-10T00:00:00.000Z');

describe('W441 scheduled_jobs prune sweeper', () => {
  it('enqueueNextScheduledJobsPrune: runs at now + INTERVAL, accountId null, dedup default true', async () => {
    const scheduledJobs = new FakeScheduledJobs();
    await enqueueNextScheduledJobsPrune({
      scheduledJobs: scheduledJobs as unknown as ScheduledJobsService,
      nowFn: () => NOW_MS,
    });
    expect(scheduledJobs.jobs).toHaveLength(1);
    expect(scheduledJobs.jobs[0]!.jobType).toBe(SCHEDULED_JOBS_PRUNE_JOB_TYPE);
    expect(scheduledJobs.jobs[0]!.accountId).toBeNull();
    expect(scheduledJobs.jobs[0]!.runAt.getTime()).toBe(NOW_MS + SCHEDULED_JOBS_PRUNE_INTERVAL_MS);
  });

  it('handler prunes finished rows older than now - RETENTION_MS, then re-arms (survives in-flight job, dedup:false)', async () => {
    const scheduledJobs = new FakeScheduledJobs();
    const { repo, cutoffs } = fakeRepo();
    registerScheduledJobsPruneJob({
      scheduledJobs: scheduledJobs as unknown as ScheduledJobsService,
      repo,
      logger: silentLogger,
      nowFn: () => NOW_MS,
    });
    // (a) bootstrap-enqueue (dedup:true default) → 1 pending.
    await enqueueNextScheduledJobsPrune({
      scheduledJobs: scheduledJobs as unknown as ScheduledJobsService,
      nowFn: () => NOW_MS,
    });
    expect(scheduledJobs.pendingOfType(SCHEDULED_JOBS_PRUNE_JOB_TYPE)).toBe(1);
    // (b) run the handler while the bootstrap job is still in-flight (the poller
    //     runs handler BEFORE markComplete) — the re-arm must still enqueue.
    const handler = scheduledJobs.getHandler(SCHEDULED_JOBS_PRUNE_JOB_TYPE);
    await handler({
      id: 'job-1',
      jobType: SCHEDULED_JOBS_PRUNE_JOB_TYPE,
      accountId: null,
      payload: {},
      runAt: new Date(NOW_MS),
      attempts: 1,
      maxAttempts: 5,
    });
    // pruned with cutoff = now - RETENTION_MS.
    expect(cutoffs).toHaveLength(1);
    expect(cutoffs[0]!.getTime()).toBe(NOW_MS - SCHEDULED_JOBS_PRUNE_RETENTION_MS);
    // re-armed a 2nd job despite the 1st still pending → chain survives.
    expect(scheduledJobs.pendingOfType(SCHEDULED_JOBS_PRUNE_JOB_TYPE)).toBe(2);
  });
});
