// 2026-05-20 — auth-token sweeper unit test.
//
// Verifies the per-kind delete loop hits all three token tables with
// the correct retention cutoffs.

import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_TOKENS_SWEEP_JOB_TYPE,
  AuthTokensSweeperService,
  enqueueNextAuthTokensSweep,
  nextSweepRunAt,
  registerAuthTokensSweepJob,
} from '../../src/services/auth-flows-sweeper.js';
import type { AuthFlowKind, AuthFlowsRepo } from '../../src/services/auth-flows.js';
import type { Logger } from '../../src/lib/logger.js';
import type {
  EnqueueScheduledJobInput,
  ScheduledJobHandler,
  ScheduledJobsService,
} from '../../src/services/scheduled-jobs.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

function mockRepo(): {
  repo: Pick<AuthFlowsRepo, 'deleteStaleAuthTokens'>;
  calls: Array<{ kind: AuthFlowKind; consumedBefore: Date; expiredBefore: Date }>;
  setResponse: (n: number) => void;
} {
  const calls: Array<{ kind: AuthFlowKind; consumedBefore: Date; expiredBefore: Date }> = [];
  let response = 0;
  return {
    calls,
    setResponse(n: number) {
      response = n;
    },
    repo: {
      deleteStaleAuthTokens(args) {
        calls.push(args);
        return Promise.resolve(response);
      },
    },
  };
}

describe('AuthTokensSweeperService', () => {
  it('sweeps all three token kinds (email_verify / magic_link / password_reset) per tick', async () => {
    const { repo, calls } = mockRepo();
    const svc = new AuthTokensSweeperService({ repo: repo as AuthFlowsRepo });
    const now = new Date('2026-05-20T00:00:00Z');
    await svc.tickOnce(now);

    expect(calls.map((c) => c.kind)).toEqual(['email_verify', 'magic_link', 'password_reset']);
  });

  it('uses 30d consumed-retention + 7d expired-retention by default', async () => {
    const { repo, calls } = mockRepo();
    const svc = new AuthTokensSweeperService({ repo: repo as AuthFlowsRepo });
    const now = new Date('2026-05-20T12:00:00Z');
    await svc.tickOnce(now);

    const first = calls[0]!;
    // 30 days before now.
    expect(first.consumedBefore.toISOString()).toBe('2026-04-20T12:00:00.000Z');
    // 7 days before now.
    expect(first.expiredBefore.toISOString()).toBe('2026-05-13T12:00:00.000Z');
  });

  it('honors injected retention overrides', async () => {
    const { repo, calls } = mockRepo();
    const svc = new AuthTokensSweeperService({
      repo: repo as AuthFlowsRepo,
      consumedRetentionDays: 1,
      expiredRetentionDays: 0,
    });
    const now = new Date('2026-05-20T12:00:00Z');
    await svc.tickOnce(now);

    const first = calls[0]!;
    expect(first.consumedBefore.toISOString()).toBe('2026-05-19T12:00:00.000Z');
    expect(first.expiredBefore.toISOString()).toBe('2026-05-20T12:00:00.000Z');
  });

  it('returns per-kind + total deletion counts', async () => {
    const { repo, setResponse } = mockRepo();
    setResponse(5);
    const svc = new AuthTokensSweeperService({ repo: repo as AuthFlowsRepo });
    const result = await svc.tickOnce(new Date('2026-05-20T00:00:00Z'));

    expect(result.deletedByKind).toEqual({
      email_verify: 5,
      magic_link: 5,
      password_reset: 5,
    });
    expect(result.totalDeleted).toBe(15);
  });

  it("AUTH_TOKENS_SWEEP_JOB_TYPE is 'auth_tokens.sweep' (matches the canonical 'resource.verb' admin-action convention)", () => {
    expect(AUTH_TOKENS_SWEEP_JOB_TYPE).toBe('auth_tokens.sweep');
  });

  it('nextSweepRunAt returns 03:00 UTC strictly after now (rolls to tomorrow when now is past 03:00 today)', () => {
    // 02:30 UTC → today 03:00.
    expect(nextSweepRunAt(new Date('2026-05-20T02:30:00Z')).toISOString()).toBe(
      '2026-05-20T03:00:00.000Z',
    );
    // 03:00 UTC exactly → roll to tomorrow (strictly after).
    expect(nextSweepRunAt(new Date('2026-05-20T03:00:00Z')).toISOString()).toBe(
      '2026-05-21T03:00:00.000Z',
    );
    // 10:00 UTC → tomorrow 03:00.
    expect(nextSweepRunAt(new Date('2026-05-20T10:00:00Z')).toISOString()).toBe(
      '2026-05-21T03:00:00.000Z',
    );
    // 23:59 UTC → tomorrow 03:00.
    expect(nextSweepRunAt(new Date('2026-05-20T23:59:00Z')).toISOString()).toBe(
      '2026-05-21T03:00:00.000Z',
    );
  });
});

// Minimal fake for the repo's future-successor dedup semantics.
class FakeScheduledJobs {
  /** Enqueued jobs; `completed` flips when a job is marked complete. */
  readonly jobs: Array<{
    jobType: string;
    accountId: string | null;
    runAt: Date;
    completed: boolean;
  }> = [];
  private readonly handlers = new Map<string, ScheduledJobHandler>();

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

describe('AuthTokensSweeperService — re-arm survives an in-flight job', () => {
  // PINS THE RE-ARM-SURVIVES-IN-FLIGHT-JOB CONTRACT (same bug class fixed
  // for sessions.duration_sweep in abcf76e7). The real poller runs
  // `await handler(job)` BEFORE `await markComplete(job)`, so when the
  // handler re-arms, the current job is still pending. Future-successor dedup
  // ignores that current cohort, while a replay sees the successor and no-ops.
  it('re-arms a SECOND sweep job even while the current job is still in-flight', async () => {
    const scheduledJobs = new FakeScheduledJobs() as unknown as ScheduledJobsService;
    const fake = scheduledJobs as unknown as FakeScheduledJobs;

    // tickOnce is a no-op stub — this test only exercises the scheduling
    // chain, not the per-kind delete logic (covered by the cases above).
    const sweeper = {
      tickOnce: () =>
        Promise.resolve({
          deletedByKind: { email_verify: 0, magic_link: 0, password_reset: 0 },
          totalDeleted: 0,
        }),
    } as unknown as AuthTokensSweeperService;

    let clock = Date.parse('2026-05-20T02:00:00Z');
    registerAuthTokensSweepJob({
      scheduledJobs,
      sweeper,
      logger: silentLogger,
      nowFn: () => clock,
    });

    // (a) bootstrap-enqueue one sweep job (default dedup:true) → 1 pending.
    await enqueueNextAuthTokensSweep({ scheduledJobs, nowFn: () => clock });
    expect(fake.pendingOfType(AUTH_TOKENS_SWEEP_JOB_TYPE)).toBe(1);
    const currentRunAt = fake.jobs[0]!.runAt;
    clock = currentRunAt.getTime();

    // (b) run the handler WHILE that bootstrap job is still present +
    //     non-completed (the poller has not called markComplete yet),
    //     mimicking runOne's handler-before-markComplete ordering.
    const handler = fake.getHandler(AUTH_TOKENS_SWEEP_JOB_TYPE);
    await handler({
      id: 'job-1',
      jobType: AUTH_TOKENS_SWEEP_JOB_TYPE,
      accountId: null,
      payload: {},
      runAt: currentRunAt,
      attempts: 1,
      maxAttempts: 5,
    });

    // (c) the chain re-armed: a SECOND sweep job exists despite the first
    //     still being in-flight.
    expect(fake.pendingOfType(AUTH_TOKENS_SWEEP_JOB_TYPE)).toBe(2);

    // Handler replay / a legacy duplicate current row cannot create another
    // future successor.
    await handler({
      id: 'job-1-replay',
      jobType: AUTH_TOKENS_SWEEP_JOB_TYPE,
      accountId: null,
      payload: {},
      runAt: currentRunAt,
      attempts: 2,
      maxAttempts: 5,
    });
    expect(fake.pendingOfType(AUTH_TOKENS_SWEEP_JOB_TYPE)).toBe(2);
  });

  // PINS THE RE-ARM-SURVIVES-A-TICK-FAILURE CONTRACT (self-re-arming
  // chain-death bug class). The poller runs `await handler(job)` then, on a
  // throw, retries the job to maxAttempts and finally markFailed leaves NO
  // pending sweep row — so if the handler re-threw instead of swallowing, the
  // chain would DIE until a process restart and stale auth-flow tokens would
  // accumulate forever. The handler must SWALLOW a tickOnce failure (log it)
  // and re-arm exactly once — never re-throw-and-re-arm-in-
  // finally (the poller retry would re-arm each attempt → fan-out). FAILS
  // pre-fix (throw skips the re-arm → 0 re-arms + handler rejects); PASSES
  // post-fix (handler resolves + exactly one re-arm).
  it('re-arms exactly once even when tickOnce throws (chain never dies, no fan-out)', async () => {
    const scheduledJobs = new FakeScheduledJobs() as unknown as ScheduledJobsService;
    const fake = scheduledJobs as unknown as FakeScheduledJobs;

    // A tick that always rejects (e.g. the DELETE query fails). Captured in a
    // LOCAL variable — read off the variable, not the object property, to avoid
    // @typescript-eslint/unbound-method.
    const tickOnce = vi.fn().mockRejectedValue(new Error('db down'));
    const sweeper = { tickOnce } as unknown as AuthTokensSweeperService;

    registerAuthTokensSweepJob({ scheduledJobs, sweeper, logger: silentLogger });

    // No pending jobs yet — invoke the handler directly and assert it RESOLVES
    // (does not reject) despite the failing tick.
    const handler = fake.getHandler(AUTH_TOKENS_SWEEP_JOB_TYPE);
    await expect(
      handler({
        id: 'job-1',
        jobType: AUTH_TOKENS_SWEEP_JOB_TYPE,
        accountId: null,
        payload: {},
        runAt: new Date('2026-05-20T03:00:00Z'),
        attempts: 1,
        maxAttempts: 5,
      }),
    ).resolves.toBeUndefined();

    // Exactly one re-arm enqueued → chain alive, no duplicate parallel chains.
    expect(tickOnce).toHaveBeenCalledTimes(1);
    expect(fake.pendingOfType(AUTH_TOKENS_SWEEP_JOB_TYPE)).toBe(1);
  });
});
