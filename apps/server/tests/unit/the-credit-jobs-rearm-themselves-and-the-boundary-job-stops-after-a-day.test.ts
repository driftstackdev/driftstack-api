// The credit jobs re-arm themselves, and the boundary job stops looking after a
// day.
//
// Two sweeps and one per-account job keep monthly credits granted with nobody
// asking. None has an external scheduler: a sweep exists only as long as each
// tick enqueues the next, so a tick that THROWS must still re-arm, exactly once,
// or that is the last tick that ever runs — silently. And each walks accounts
// from a cursor carried in its own payload, so a full batch comes back soon for
// the rest and a short one starts over.
//
// The boundary job is the one with a decision in it. It fires when an account's
// window ends, to grant the next month at once. But a renewal is usually paid a
// little AFTER its period starts, and nothing is granted before it is paid, so
// "nothing to grant yet" is the ordinary answer at the boundary. The job then
// looks again every 5 minutes — and after 24 hours it stops, because a plan that
// simply ended must not leave a job polling for ever. Stopping loses nothing: the
// paid invoice's own event, and the coverage sweep, still grant it whenever it
// is paid.

import { describe, expect, it } from 'vitest';
import {
  CREDITS_COVERAGE_SWEEP_INTERVAL_MS,
  CREDITS_COVERAGE_SWEEP_JOB_TYPE,
  CREDITS_EXPIRY_SWEEP_INTERVAL_MS,
  CREDITS_EXPIRY_SWEEP_JOB_TYPE,
  CREDITS_SWEEP_BACKLOG_DELAY_MS,
  CREDITS_SWEEP_BATCH_LIMIT,
  CREDITS_WINDOW_BOUNDARY_GIVE_UP_MS,
  CREDITS_WINDOW_BOUNDARY_JOB_TYPE,
  CREDITS_WINDOW_BOUNDARY_RETRY_MS,
  enqueueNextCreditsCoverageSweep,
  enqueueNextCreditsWindowBoundary,
  readSweepCursor,
  registerCreditsCoverageSweepJob,
  registerCreditsExpirySweepJob,
  registerCreditsWindowBoundaryJob,
  type CreditGrantJobsTarget,
} from '../../src/services/credit-grant-jobs.js';
import type { CreditsRefreshResult, CreditSweepResult } from '../../src/services/credit-grants.js';
import type {
  EnqueueScheduledJobInput,
  ScheduledJobRow,
  ScheduledJobsService,
} from '../../src/services/scheduled-jobs.js';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const ACCOUNT = '3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b';
const LAST = '9c8b7a6f-1e2d-4c3b-8a9f-0e1d2c3b4a5f';

function fakeJobs(): {
  service: ScheduledJobsService;
  enqueued: EnqueueScheduledJobInput[];
  run: (type: string, job?: Partial<ScheduledJobRow>) => Promise<void>;
} {
  const enqueued: EnqueueScheduledJobInput[] = [];
  const handlers = new Map<string, (job: ScheduledJobRow) => Promise<void>>();
  const service = {
    register: (type: string, fn: (job: ScheduledJobRow) => Promise<void>) => {
      handlers.set(type, fn);
    },
    enqueue: (args: EnqueueScheduledJobInput) => {
      enqueued.push(args);
      return Promise.resolve({ enqueued: true });
    },
  } as unknown as ScheduledJobsService;
  return {
    service,
    enqueued,
    run: async (type, job = {}) => {
      const handler = handlers.get(type);
      if (handler === undefined) throw new Error(`no handler registered for ${type}`);
      await handler({
        id: 'job-1',
        jobType: type,
        accountId: null,
        payload: {},
        runAt: new Date(NOW),
        attempts: 1,
        maxAttempts: 5,
        ...job,
      });
    },
  };
}

const SWEPT_NOTHING: CreditSweepResult = {
  visited: 0,
  granted: 0,
  expired: 0,
  failed: 0,
  nextAfterAccountId: null,
};

function refreshed(currentWindowEnd: string | null): CreditsRefreshResult {
  return { expired: [], window: { outcome: 'none' }, level: null, repaid: [], currentWindowEnd };
}

function target(over: Partial<CreditGrantJobsTarget>): CreditGrantJobsTarget {
  return {
    refreshCredits: () => Promise.reject(new Error('refreshCredits was not expected')),
    sweepCoverage: () => Promise.reject(new Error('sweepCoverage was not expected')),
    sweepExpiry: () => Promise.reject(new Error('sweepExpiry was not expected')),
    ...over,
  };
}

describe('the two sweeps', () => {
  const sweeps = [
    {
      name: 'coverage',
      type: CREDITS_COVERAGE_SWEEP_JOB_TYPE,
      interval: CREDITS_COVERAGE_SWEEP_INTERVAL_MS,
      register: registerCreditsCoverageSweepJob,
      method: 'sweepCoverage' as const,
    },
    {
      name: 'expiry',
      type: CREDITS_EXPIRY_SWEEP_JOB_TYPE,
      interval: CREDITS_EXPIRY_SWEEP_INTERVAL_MS,
      register: registerCreditsExpirySweepJob,
      method: 'sweepExpiry' as const,
    },
  ];

  it('the coverage sweep runs every 15 minutes and the expiry sweep every hour', () => {
    expect(CREDITS_COVERAGE_SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(CREDITS_EXPIRY_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  for (const sweep of sweeps) {
    it(`the ${sweep.name} sweep walks from the start with the batch limit, and re-arms ONCE, a full interval on, deduplicated against a later successor only`, async () => {
      const calls: unknown[] = [];
      const jobs = fakeJobs();
      sweep.register({
        scheduledJobs: jobs.service,
        nowFn: () => NOW,
        grants: target({
          [sweep.method]: (opts: unknown) => {
            calls.push(opts);
            return Promise.resolve(SWEPT_NOTHING);
          },
        }),
      });
      await jobs.run(sweep.type);

      expect(calls).toEqual([{ afterAccountId: null, limit: CREDITS_SWEEP_BATCH_LIMIT }]);
      expect(jobs.enqueued).toEqual([
        {
          jobType: sweep.type,
          accountId: null,
          payload: {},
          runAt: new Date(NOW + sweep.interval),
          dedupOnAccountAndType: true,
          dedupAfterRunAt: new Date(NOW),
        },
      ]);
    });

    it(`a FULL ${sweep.name} batch comes back in seconds for the rest, carrying where it stopped — and the next tick resumes from there`, async () => {
      const calls: Array<{ afterAccountId: string | null }> = [];
      const jobs = fakeJobs();
      sweep.register({
        scheduledJobs: jobs.service,
        nowFn: () => NOW,
        grants: target({
          [sweep.method]: (opts: { afterAccountId: string | null }) => {
            calls.push(opts);
            return Promise.resolve({ ...SWEPT_NOTHING, visited: 200, nextAfterAccountId: LAST });
          },
        }),
      });
      await jobs.run(sweep.type);
      expect(jobs.enqueued[0]).toMatchObject({
        payload: { after_account_id: LAST },
        runAt: new Date(NOW + CREDITS_SWEEP_BACKLOG_DELAY_MS),
      });

      await jobs.run(sweep.type, { payload: jobs.enqueued[0]?.payload ?? {} });
      expect(calls.map((c) => c.afterAccountId)).toEqual([null, LAST]);
    });

    it(`CRITICAL a ${sweep.name} tick that THROWS is swallowed and still re-arms, exactly once, from the start — or it is the last tick that ever runs`, async () => {
      const jobs = fakeJobs();
      sweep.register({
        scheduledJobs: jobs.service,
        nowFn: () => NOW,
        grants: target({ [sweep.method]: () => Promise.reject(new Error('the database blinked')) }),
      });
      await expect(
        jobs.run(sweep.type, { payload: { after_account_id: LAST } }),
      ).resolves.toBeUndefined();
      expect(jobs.enqueued).toHaveLength(1);
      expect(jobs.enqueued[0]).toMatchObject({
        jobType: sweep.type,
        payload: {},
        runAt: new Date(NOW + sweep.interval),
        dedupAfterRunAt: new Date(NOW),
      });
    });
  }

  it('bootstrap’s first enqueue passes no run time, so it is deduplicated against EVERY pending row: a restart keeps the chain it finds rather than starting a second one', async () => {
    const jobs = fakeJobs();
    await enqueueNextCreditsCoverageSweep({ scheduledJobs: jobs.service, nowFn: () => NOW });
    expect(jobs.enqueued[0]).toEqual({
      jobType: CREDITS_COVERAGE_SWEEP_JOB_TYPE,
      accountId: null,
      payload: {},
      runAt: new Date(NOW + CREDITS_COVERAGE_SWEEP_INTERVAL_MS),
      dedupOnAccountAndType: true,
    });
  });

  it('a cursor is an account id or it is nothing: a payload that holds anything else starts the walk over rather than reaching a uuid column', () => {
    expect(readSweepCursor({ after_account_id: LAST })).toBe(LAST);
    for (const bad of [
      {},
      { after_account_id: 7 },
      { after_account_id: '-'.repeat(36) },
      { after_account_id: `${LAST}x` },
    ]) {
      expect(readSweepCursor(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the window-boundary job', () => {
  const WINDOW_END = '2026-10-19T12:00:00.000250Z';

  function boundary(
    grants: Partial<CreditGrantJobsTarget>,
    now = NOW,
  ): ReturnType<typeof fakeJobs> {
    const jobs = fakeJobs();
    registerCreditsWindowBoundaryJob({
      scheduledJobs: jobs.service,
      nowFn: () => now,
      grants: target(grants),
    });
    return jobs;
  }

  it('it looks again every 5 minutes, for 24 hours', () => {
    expect(CREDITS_WINDOW_BOUNDARY_RETRY_MS).toBe(5 * 60 * 1000);
    expect(CREDITS_WINDOW_BOUNDARY_GIVE_UP_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('CRITICAL when the refresh leaves a window current, the NEXT boundary is armed for that window’s end: one pending row for the account, due at the first millisecond at or after the end', async () => {
    const refreshedAccounts: string[] = [];
    const jobs = boundary({
      refreshCredits: (accountId) => {
        refreshedAccounts.push(accountId);
        return Promise.resolve(refreshed(WINDOW_END));
      },
    });
    await jobs.run(CREDITS_WINDOW_BOUNDARY_JOB_TYPE, { accountId: ACCOUNT });

    expect(refreshedAccounts).toEqual([ACCOUNT]);
    expect(jobs.enqueued).toEqual([
      {
        jobType: CREDITS_WINDOW_BOUNDARY_JOB_TYPE,
        accountId: ACCOUNT,
        payload: { boundary_at: '2026-10-19T12:00:00.001Z' },
        runAt: new Date('2026-10-19T12:00:00.001Z'),
        dedupOnAccountAndType: true,
        dedupAfterRunAt: new Date(NOW),
      },
    ]);
  });

  it('CRITICAL when the next month is not paid for yet it looks again in 5 minutes — and the retry remembers WHEN THE WINDOW ENDED, not when it last looked, so the 24 hours are counted from the boundary', async () => {
    const endedAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const jobs = boundary({ refreshCredits: () => Promise.resolve(refreshed(null)) });
    await jobs.run(CREDITS_WINDOW_BOUNDARY_JOB_TYPE, {
      accountId: ACCOUNT,
      payload: { boundary_at: endedAt },
    });
    expect(jobs.enqueued).toEqual([
      {
        jobType: CREDITS_WINDOW_BOUNDARY_JOB_TYPE,
        accountId: ACCOUNT,
        payload: { boundary_at: endedAt },
        runAt: new Date(NOW + CREDITS_WINDOW_BOUNDARY_RETRY_MS),
        dedupOnAccountAndType: true,
        dedupAfterRunAt: new Date(NOW),
      },
    ]);
  });

  it('CRITICAL 24 hours after the window ended it STOPS: one second short it still looks again, at 24 hours it arms nothing', async () => {
    const stillLooking = boundary({ refreshCredits: () => Promise.resolve(refreshed(null)) });
    await stillLooking.run(CREDITS_WINDOW_BOUNDARY_JOB_TYPE, {
      accountId: ACCOUNT,
      payload: {
        boundary_at: new Date(NOW - CREDITS_WINDOW_BOUNDARY_GIVE_UP_MS + 1_000).toISOString(),
      },
    });
    expect(stillLooking.enqueued).toHaveLength(1);

    const gaveUp = boundary({ refreshCredits: () => Promise.resolve(refreshed(null)) });
    await gaveUp.run(CREDITS_WINDOW_BOUNDARY_JOB_TYPE, {
      accountId: ACCOUNT,
      payload: { boundary_at: new Date(NOW - CREDITS_WINDOW_BOUNDARY_GIVE_UP_MS).toISOString() },
    });
    expect(gaveUp.enqueued).toEqual([]);
  });

  it('a row with no readable boundary counts its 24 hours from its own due time — and WRITES that time into the row it arms next, so the count is not restarted by every retry and a malformed payload cannot make the job immortal', async () => {
    const first = boundary({ refreshCredits: () => Promise.resolve(refreshed(null)) });
    await first.run(CREDITS_WINDOW_BOUNDARY_JOB_TYPE, {
      accountId: ACCOUNT,
      payload: { boundary_at: 'not a time' },
    });
    expect(first.enqueued[0]?.payload).toEqual({ boundary_at: new Date(NOW).toISOString() });

    const jobs = boundary({ refreshCredits: () => Promise.resolve(refreshed(null)) });
    await jobs.run(CREDITS_WINDOW_BOUNDARY_JOB_TYPE, {
      accountId: ACCOUNT,
      payload: { boundary_at: 'not a time' },
      runAt: new Date(NOW - CREDITS_WINDOW_BOUNDARY_GIVE_UP_MS),
    });
    expect(jobs.enqueued).toEqual([]);
  });

  it('CRITICAL a refresh that THROWS is swallowed and counts as "nothing yet": it looks again in 5 minutes rather than ending the account’s chain on one bad tick', async () => {
    const jobs = boundary({
      refreshCredits: () => Promise.reject(new Error('the database blinked')),
    });
    await expect(
      jobs.run(CREDITS_WINDOW_BOUNDARY_JOB_TYPE, { accountId: ACCOUNT }),
    ).resolves.toBeUndefined();
    expect(jobs.enqueued).toHaveLength(1);
    expect(jobs.enqueued[0]?.runAt).toEqual(new Date(NOW + CREDITS_WINDOW_BOUNDARY_RETRY_MS));
  });

  it('a boundary row that names no account does nothing at all', async () => {
    const jobs = boundary({});
    await jobs.run(CREDITS_WINDOW_BOUNDARY_JOB_TYPE, { accountId: null });
    expect(jobs.enqueued).toEqual([]);
  });

  it('the first arming, from a grant, passes no run time: it is deduplicated against ANY pending row for the account, so an account never has two', async () => {
    const jobs = fakeJobs();
    await enqueueNextCreditsWindowBoundary({
      scheduledJobs: jobs.service,
      accountId: ACCOUNT,
      windowEnd: '2026-10-01T00:00:00.000000Z',
    });
    expect(jobs.enqueued).toEqual([
      {
        jobType: CREDITS_WINDOW_BOUNDARY_JOB_TYPE,
        accountId: ACCOUNT,
        payload: { boundary_at: '2026-10-01T00:00:00.000Z' },
        runAt: new Date('2026-10-01T00:00:00.000Z'),
        dedupOnAccountAndType: true,
      },
    ]);
  });
});
