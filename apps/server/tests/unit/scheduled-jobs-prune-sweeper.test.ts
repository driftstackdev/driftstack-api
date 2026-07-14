// W441 — scheduled_jobs prune sweeper: registration + prune-cutoff + re-arm
// contract. Mirrors the session-duration-sweeper scheduling test (the re-arm
// must ignore the current cohort while deduplicating future successors).
import { describe, it, expect, vi } from 'vitest';
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
  jobs: Array<{
    jobType: string;
    accountId: string | null;
    runAt: Date;
    dedup: boolean;
    completed: boolean;
  }> = [];
  register(jobType: string, handler: ScheduledJobHandler): void {
    this.handlers.set(jobType, handler);
  }
  enqueue(input: EnqueueScheduledJobInput): Promise<{ enqueued: boolean }> {
    if (input.dedupOnAccountAndType) {
      const dup = this.jobs.some(
        (j) =>
          !j.completed &&
          j.jobType === input.jobType &&
          j.accountId === input.accountId &&
          (input.dedupAfterRunAt === undefined || j.runAt > input.dedupAfterRunAt),
      );
      if (dup) return Promise.resolve({ enqueued: false });
    }
    this.jobs.push({
      jobType: input.jobType,
      accountId: input.accountId,
      runAt: input.runAt,
      dedup: input.dedupOnAccountAndType ?? false,
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

  it('handler prunes finished rows, then re-arms exactly once across replay', async () => {
    const scheduledJobs = new FakeScheduledJobs();
    const { repo, cutoffs } = fakeRepo();
    registerScheduledJobsPruneJob({
      scheduledJobs: scheduledJobs as unknown as ScheduledJobsService,
      repo,
      logger: silentLogger,
      nowFn: () => NOW_MS,
    });
    // Seed the in-flight current row at the handler's run time.
    await scheduledJobs.enqueue({
      jobType: SCHEDULED_JOBS_PRUNE_JOB_TYPE,
      accountId: null,
      payload: {},
      runAt: new Date(NOW_MS),
      dedupOnAccountAndType: false,
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
    await handler({
      id: 'job-1-replay',
      jobType: SCHEDULED_JOBS_PRUNE_JOB_TYPE,
      accountId: null,
      payload: {},
      runAt: new Date(NOW_MS),
      attempts: 2,
      maxAttempts: 5,
    });
    expect(scheduledJobs.pendingOfType(SCHEDULED_JOBS_PRUNE_JOB_TYPE)).toBe(2);
  });

  it('the re-arm survives a pruneFinished failure (chain never dies) and does not fan out', async () => {
    const scheduledJobs = new FakeScheduledJobs();
    // A prune that always throws (e.g. the DB delete fails) must not stop the
    // self-re-arming chain: the handler swallows + re-arms exactly once. If it
    // re-threw, the poller would retry to maxAttempts then markFailed with no
    // pending prune — the chain would die and scheduled_jobs would grow forever.
    // Captured mock (read off the local variable, not the object → no-unbound-
    // method).
    const pruneFinished = vi.fn().mockRejectedValue(new Error('db down'));
    const repo = { pruneFinished } as unknown as ScheduledJobsRepo;
    registerScheduledJobsPruneJob({
      scheduledJobs: scheduledJobs as unknown as ScheduledJobsService,
      repo,
      logger: silentLogger,
      nowFn: () => NOW_MS,
    });
    const handler = scheduledJobs.getHandler(SCHEDULED_JOBS_PRUNE_JOB_TYPE);

    // The handler must resolve (not reject) despite the failing prune.
    await expect(
      handler({
        id: 'job-1',
        jobType: SCHEDULED_JOBS_PRUNE_JOB_TYPE,
        accountId: null,
        payload: {},
        runAt: new Date(NOW_MS),
        attempts: 1,
        maxAttempts: 5,
      }),
    ).resolves.toBeUndefined();

    // Exactly one re-arm enqueued → chain alive, no duplicate parallel chains.
    expect(scheduledJobs.jobs).toHaveLength(1);
    expect(scheduledJobs.jobs[0]!.jobType).toBe(SCHEDULED_JOBS_PRUNE_JOB_TYPE);
    expect(scheduledJobs.jobs[0]!.dedup).toBe(true);
    expect(pruneFinished).toHaveBeenCalledTimes(1);
  });
});
