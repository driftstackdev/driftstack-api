// V-784 — the five daily sweeps that had no durable schedule.
//
// They ran on `setInterval(fn, 24h)` created during bootstrap. A `setInterval`
// does not fire until a full period has elapsed, so a process that restarts more
// often than once a day never reached the first tick and those sweeps did not
// run at all — among them the Privacy §3.10 90-day email zero-out. The schedule
// also lived only in process memory, so a restart discarded whatever progress
// the timer had made and began the 24 hours again.
//
// The reason nobody noticed is the case this file cares about most. Chain
// liveness reports 0 for a dead chain precisely so a dashboard can alert on the
// value rather than on a missing series — but its roster is derived from the
// `*_JOB_TYPE` constants sweepers export, so a sweep that was never a job had no
// constant, no pending row, and no series. It was not a dead chain; it was not a
// chain. The watchdog watched exactly the sweeps that were already durable.
//
// These cases pin the contract that makes the conversion worth anything: the
// chain survives a sweep that throws, a restart does not push the next run
// another day out, and one tick produces exactly one successor.

import { describe, it, expect } from 'vitest';

import type {
  EnqueueScheduledJobInput,
  ScheduledJobHandler,
  ScheduledJobRow,
  ScheduledJobsService,
} from '../../src/services/scheduled-jobs.js';
import type { Logger } from '../../src/lib/logger.js';
import {
  DAILY_MAINTENANCE_INTERVAL_MS,
  ROTATION_REMINDER_JOB_TYPES,
  STATUS_SUBSCRIBER_PURGE_JOB_TYPE,
  WEBHOOK_ROTATION_REMINDER_JOB_TYPE,
  BYOK_ANTHROPIC_ROTATION_REMINDER_JOB_TYPE,
  WEBHOOK_GRACE_EXPIRING_NOTICE_JOB_TYPE,
  WEBHOOK_SECRET_PREV_CLEANUP_JOB_TYPE,
  registerDailyMaintenanceJob,
  enqueueNextDailyMaintenance,
  wireDailyMaintenanceSweep,
} from '../../src/services/daily-maintenance-jobs.js';

const errors: Record<string, unknown>[] = [];
const captureLogger = {
  info: () => {},
  warn: () => {},
  error: (obj: Record<string, unknown>) => {
    errors.push(obj);
  },
  debug: () => {},
  child: () => captureLogger,
} as unknown as Logger;

class FakeScheduledJobs {
  handlers = new Map<string, ScheduledJobHandler>();
  jobs: Array<{ jobType: string; accountId: string | null; runAt: Date; completed: boolean }> = [];

  register(jobType: string, handler: ScheduledJobHandler): void {
    this.handlers.set(jobType, handler);
  }

  enqueue(input: EnqueueScheduledJobInput): Promise<{ enqueued: boolean }> {
    if (input.dedupOnAccountAndType === true) {
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
      completed: false,
    });
    return Promise.resolve({ enqueued: true });
  }

  handlerFor(jobType: string): ScheduledJobHandler {
    const h = this.handlers.get(jobType);
    if (h === undefined) throw new Error(`no handler registered for ${jobType}`);
    return h;
  }

  pendingOfType(jobType: string): number {
    return this.jobs.filter((j) => !j.completed && j.jobType === jobType).length;
  }
}

const NOW_MS = Date.parse('2026-08-15T00:00:00.000Z');
const asService = (f: FakeScheduledJobs): ScheduledJobsService =>
  f as unknown as ScheduledJobsService;
const rowFor = (jobType: string, runAt: Date): ScheduledJobRow => ({
  id: `job_${jobType}`,
  jobType,
  accountId: null,
  payload: {},
  runAt,
  attempts: 1,
  maxAttempts: 5,
});

describe('V-784 daily maintenance job chains', () => {
  it('CRITICAL a sweep that throws still re-arms. Without this the poller retries until maxAttempts is exhausted, markFailed leaves no pending row, and the chain is dead until a process restart — which for a daily sweep means dead until someone deploys, and silent the whole time.', async () => {
    errors.length = 0;
    const scheduledJobs = new FakeScheduledJobs();
    registerDailyMaintenanceJob({
      scheduledJobs: asService(scheduledJobs),
      logger: captureLogger,
      nowFn: () => NOW_MS,
      sweep: {
        jobType: STATUS_SUBSCRIBER_PURGE_JOB_TYPE,
        component: 'status-subscriber-purge',
        run: () => Promise.reject(new Error('postgres went away')),
      },
    });

    const runAt = new Date(NOW_MS);
    await expect(
      scheduledJobs.handlerFor(STATUS_SUBSCRIBER_PURGE_JOB_TYPE)(
        rowFor(STATUS_SUBSCRIBER_PURGE_JOB_TYPE, runAt),
      ),
      'the handler must NOT rethrow — a rethrow makes the poller retry and every retry re-arms, fanning out duplicate parallel chains',
    ).resolves.toBeUndefined();

    expect(scheduledJobs.pendingOfType(STATUS_SUBSCRIBER_PURGE_JOB_TYPE), 'chain survived').toBe(1);
    expect(scheduledJobs.jobs[0]!.runAt.getTime()).toBe(NOW_MS + DAILY_MAINTENANCE_INTERVAL_MS);
    expect(errors, 'and the failure is loud, not swallowed silently').toHaveLength(1);
    expect(errors[0]!.event).toBe('daily_maintenance_sweep_failed');
    expect(errors[0]!.jobType).toBe(STATUS_SUBSCRIBER_PURGE_JOB_TYPE);
  });

  it('CRITICAL one tick produces exactly one successor even when the handler is replayed. A re-arm that dedups against nothing would let each redelivery of the same job add another pending row, and the chain would fan out into parallel copies of a sweep that sends customer email.', async () => {
    const scheduledJobs = new FakeScheduledJobs();
    let ran = 0;
    registerDailyMaintenanceJob({
      scheduledJobs: asService(scheduledJobs),
      logger: captureLogger,
      nowFn: () => NOW_MS,
      sweep: {
        jobType: WEBHOOK_ROTATION_REMINDER_JOB_TYPE,
        component: 'webhook-rotation-reminder',
        run: () => {
          ran += 1;
          return Promise.resolve();
        },
      },
    });

    const job = rowFor(WEBHOOK_ROTATION_REMINDER_JOB_TYPE, new Date(NOW_MS));
    const handler = scheduledJobs.handlerFor(WEBHOOK_ROTATION_REMINDER_JOB_TYPE);
    await handler(job);
    await handler(job);
    await handler(job);

    expect(ran, 'the sweep itself runs per delivery').toBe(3);
    expect(
      scheduledJobs.pendingOfType(WEBHOOK_ROTATION_REMINDER_JOB_TYPE),
      'but only one successor exists',
    ).toBe(1);
  });

  it('CRITICAL a restart does NOT push the next run another day out. The boot enqueue dedups against ALL pending rows, so a row left by a previous boot keeps its original runAt — this is the whole difference from setInterval, where every restart discarded the pending tick and began the 24 hours again.', async () => {
    const scheduledJobs = new FakeScheduledJobs();
    const sweep = {
      jobType: WEBHOOK_SECRET_PREV_CLEANUP_JOB_TYPE,
      component: 'webhook-secret-prev-cleanup',
      run: () => Promise.resolve(),
    };

    // First boot arms the chain 24h out.
    await wireDailyMaintenanceSweep({
      scheduledJobs: asService(scheduledJobs),
      logger: captureLogger,
      nowFn: () => NOW_MS,
      sweep,
    });
    const armedFor = scheduledJobs.jobs[0]!.runAt.getTime();
    expect(armedFor).toBe(NOW_MS + DAILY_MAINTENANCE_INTERVAL_MS);

    // Restart 23 hours later — one hour before the run was due.
    const restartMs = NOW_MS + 23 * 60 * 60 * 1000;
    await wireDailyMaintenanceSweep({
      scheduledJobs: asService(scheduledJobs),
      logger: captureLogger,
      nowFn: () => restartMs,
      sweep,
    });

    expect(
      scheduledJobs.pendingOfType(WEBHOOK_SECRET_PREV_CLEANUP_JOB_TYPE),
      'the restart adds no second row',
    ).toBe(1);
    expect(
      scheduledJobs.jobs[0]!.runAt.getTime(),
      'and the original due time is untouched — the sweep still runs in an hour, not in another 24',
    ).toBe(armedFor);
  });

  it('CRITICAL the re-arm ignores its own cohort but defers to a committed future successor. Passing the current runAt as the dedup boundary is what lets a redelivered job re-arm at all while still collapsing to one chain; deduping against every pending row would make a handler that runs late never re-arm.', async () => {
    const scheduledJobs = new FakeScheduledJobs();
    const jobType = BYOK_ANTHROPIC_ROTATION_REMINDER_JOB_TYPE;

    // A pending row at the CURRENT run time — the job being executed.
    await enqueueNextDailyMaintenance({
      scheduledJobs: asService(scheduledJobs),
      jobType,
      nowFn: () => NOW_MS - DAILY_MAINTENANCE_INTERVAL_MS,
    });
    expect(scheduledJobs.jobs[0]!.runAt.getTime()).toBe(NOW_MS);

    // The re-arm passes runAt=NOW, so the row AT now does not suppress it.
    await enqueueNextDailyMaintenance({
      scheduledJobs: asService(scheduledJobs),
      jobType,
      nowFn: () => NOW_MS,
      currentRunAt: new Date(NOW_MS),
    });
    expect(scheduledJobs.pendingOfType(jobType), 'the successor was created').toBe(2);

    // A second re-arm now DOES see a strictly-later successor and no-ops.
    await enqueueNextDailyMaintenance({
      scheduledJobs: asService(scheduledJobs),
      jobType,
      nowFn: () => NOW_MS,
      currentRunAt: new Date(NOW_MS),
    });
    expect(scheduledJobs.pendingOfType(jobType), 'and is not duplicated').toBe(2);
  });

  it('CRITICAL wireDailyMaintenanceSweep both registers AND enqueues. Registering alone leaves a handler nothing ever delivers to: no pending row means the liveness gauge reports 0 forever, which is indistinguishable from the dead chain it is supposed to detect.', async () => {
    const scheduledJobs = new FakeScheduledJobs();
    await wireDailyMaintenanceSweep({
      scheduledJobs: asService(scheduledJobs),
      logger: captureLogger,
      nowFn: () => NOW_MS,
      sweep: {
        jobType: WEBHOOK_GRACE_EXPIRING_NOTICE_JOB_TYPE,
        component: 'webhook-grace-expiring-notice',
        run: () => Promise.resolve(),
      },
    });

    expect(scheduledJobs.handlers.has(WEBHOOK_GRACE_EXPIRING_NOTICE_JOB_TYPE)).toBe(true);
    expect(scheduledJobs.pendingOfType(WEBHOOK_GRACE_EXPIRING_NOTICE_JOB_TYPE)).toBe(1);
  });

  it('CRITICAL the kill-switch roster names the four chains a disabled deployment omits, and does NOT include the status-subscriber purge. Omitting the purge would hide a privacy §3.10 sweep behind an unrelated flag; including it in the reminder set is exactly how that would happen.', () => {
    expect([...ROTATION_REMINDER_JOB_TYPES].sort()).toEqual(
      [
        BYOK_ANTHROPIC_ROTATION_REMINDER_JOB_TYPE,
        WEBHOOK_GRACE_EXPIRING_NOTICE_JOB_TYPE,
        WEBHOOK_ROTATION_REMINDER_JOB_TYPE,
        WEBHOOK_SECRET_PREV_CLEANUP_JOB_TYPE,
      ].sort(),
    );
    expect(ROTATION_REMINDER_JOB_TYPES).not.toContain(STATUS_SUBSCRIBER_PURGE_JOB_TYPE);
  });

  it('CRITICAL the cadence is unchanged from the intervals these replaced. The conversion is about durability, not about sweeping more often — a shorter period would mean more customer rotation-nag email than the previous behaviour.', () => {
    expect(DAILY_MAINTENANCE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
