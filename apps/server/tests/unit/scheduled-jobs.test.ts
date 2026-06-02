// V-202d — unit tests for ScheduledJobsService dispatcher behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledJobsService } from '../../src/services/scheduled-jobs.js';
import { InMemoryScheduledJobsRepo } from '../integration/_helpers/in-memory-scheduled-jobs-repo.js';
import { createTestLogger } from '../../src/lib/logger.js';

let repo: InMemoryScheduledJobsRepo;
let service: ScheduledJobsService;

beforeEach(() => {
  repo = new InMemoryScheduledJobsRepo();
  service = new ScheduledJobsService(repo, createTestLogger(), {
    workerId: 'test',
    retryBackoffBaseMs: 1000,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ScheduledJobsService — dispatch', () => {
  it('runs the registered handler for the matching job_type', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    service.register('test.echo', handler);
    await repo.enqueue({
      jobType: 'test.echo',
      accountId: 'acc_1',
      payload: { foo: 'bar' },
      runAt: new Date(2026, 0, 1),
    });
    const result = await service.processTick(new Date(2026, 0, 1, 0, 0, 1));
    expect(result.processed).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const job = handler.mock.calls[0]![0] as { jobType: string; accountId: string | null };
    expect(job.jobType).toBe('test.echo');
    expect(job.accountId).toBe('acc_1');
  });

  it('marks unhandled job_type as failed (operator visibility)', async () => {
    await repo.enqueue({
      jobType: 'unknown.nope',
      accountId: null,
      payload: {},
      runAt: new Date(2026, 0, 1),
    });
    const result = await service.processTick(new Date(2026, 0, 1, 0, 0, 1));
    expect(result.processed).toBe(1);
    const job = repo.all()[0]!;
    expect(job.failedAt).toBeInstanceOf(Date);
    expect(job.lastError).toContain('no handler registered');
  });

  it('skips jobs whose run_at is in the future', async () => {
    service.register('test.future', vi.fn());
    await repo.enqueue({
      jobType: 'test.future',
      accountId: null,
      payload: {},
      runAt: new Date(2027, 0, 1),
    });
    const result = await service.processTick(new Date(2026, 0, 1));
    expect(result.processed).toBe(0);
  });

  it('retries on transient handler failure with backoff', async () => {
    let attempts = 0;
    service.register('test.flaky', () => {
      attempts += 1;
      throw new Error('transient');
    });
    await repo.enqueue({
      jobType: 'test.flaky',
      accountId: 'acc_1',
      payload: {},
      runAt: new Date(2026, 0, 1),
    });

    // First tick: attempt 1 fails → retry scheduled.
    await service.processTick(new Date(2026, 0, 1, 0, 0, 1));
    expect(attempts).toBe(1);
    let job = repo.all()[0]!;
    expect(job.completedAt).toBeNull();
    expect(job.failedAt).toBeNull();
    expect(job.lastError).toBe('transient');
    expect(job.attempts).toBe(1);

    // Tick at the rescheduled time → attempt 2.
    await service.processTick(new Date(job.runAt.getTime() + 1));
    expect(attempts).toBe(2);
    job = repo.all()[0]!;
    expect(job.attempts).toBe(2);

    // Final attempt → marks failed permanently.
    await service.processTick(new Date(job.runAt.getTime() + 10_000_000));
    expect(attempts).toBe(3);
    job = repo.all()[0]!;
    expect(job.failedAt).toBeInstanceOf(Date);
  });

  it('completed job is not re-claimed on subsequent ticks', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    service.register('test.idempotent', handler);
    await repo.enqueue({
      jobType: 'test.idempotent',
      accountId: null,
      payload: {},
      runAt: new Date(2026, 0, 1),
    });
    await service.processTick(new Date(2026, 0, 1, 0, 0, 1));
    expect(handler).toHaveBeenCalledTimes(1);
    await service.processTick(new Date(2026, 0, 1, 0, 0, 2));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dedupOnAccountAndType prevents duplicate pending enqueues', async () => {
    const first = await repo.enqueue({
      jobType: 'test.dedup',
      accountId: 'acc_1',
      payload: {},
      runAt: new Date(2026, 0, 1),
      dedupOnAccountAndType: true,
    });
    expect(first.enqueued).toBe(true);

    const second = await repo.enqueue({
      jobType: 'test.dedup',
      accountId: 'acc_1',
      payload: {},
      runAt: new Date(2026, 0, 1),
      dedupOnAccountAndType: true,
    });
    expect(second.enqueued).toBe(false);

    // Different account: not deduped.
    const otherAccount = await repo.enqueue({
      jobType: 'test.dedup',
      accountId: 'acc_2',
      payload: {},
      runAt: new Date(2026, 0, 1),
      dedupOnAccountAndType: true,
    });
    expect(otherAccount.enqueued).toBe(true);
  });

  it('dedup unblocks once the existing job completes', async () => {
    service.register('test.dedup', vi.fn().mockResolvedValue(undefined));
    await repo.enqueue({
      jobType: 'test.dedup',
      accountId: 'acc_1',
      payload: {},
      runAt: new Date(2026, 0, 1),
      dedupOnAccountAndType: true,
    });
    await service.processTick(new Date(2026, 0, 1, 0, 0, 1));
    // Now an enqueue should succeed (no pending row remains).
    const second = await repo.enqueue({
      jobType: 'test.dedup',
      accountId: 'acc_1',
      payload: {},
      runAt: new Date(2026, 0, 2),
      dedupOnAccountAndType: true,
    });
    expect(second.enqueued).toBe(true);
  });

  it('dedupOnAccountAndType dedups NULL-accountId (global) jobs too — regression for the 2026-05-20 prod incident', async () => {
    // Global jobs (auth_tokens.sweep, cost.recompute_nightly) carry
    // accountId=null. The real DrizzleScheduledJobsRepo dedups them via
    // isNull(); the mock must match or it silently masks the duplicate-
    // accumulation bug (13 pending auth_tokens.sweep rows in prod).
    const first = await repo.enqueue({
      jobType: 'auth_tokens.sweep',
      accountId: null,
      payload: {},
      runAt: new Date(2026, 0, 1),
      dedupOnAccountAndType: true,
    });
    expect(first.enqueued).toBe(true);

    const second = await repo.enqueue({
      jobType: 'auth_tokens.sweep',
      accountId: null,
      payload: {},
      runAt: new Date(2026, 0, 1),
      dedupOnAccountAndType: true,
    });
    expect(second.enqueued).toBe(false);

    // A different global job_type is independent (matched on jobType too).
    const otherType = await repo.enqueue({
      jobType: 'cost.recompute_nightly',
      accountId: null,
      payload: {},
      runAt: new Date(2026, 0, 1),
      dedupOnAccountAndType: true,
    });
    expect(otherType.enqueued).toBe(true);
  });
});

describe('ScheduledJobsService — stale-lock reclaim (crash recovery)', () => {
  // claimDue reclaims a job whose worker locked it but never marked it
  // complete/retry/failed (process crash mid-handler) once the lock is
  // older than the 5-min staleness window. A FRESH lock must NOT be
  // stealable — that is what stops two live workers double-running a job.
  it('does NOT reclaim a job whose lock is still fresh (< 5 min)', async () => {
    await repo.enqueue({
      jobType: 'test.sweep',
      accountId: null,
      payload: {},
      runAt: new Date(2026, 0, 1),
    });
    const t0 = new Date(2026, 0, 1, 0, 0, 1);
    const firstClaim = await repo.claimDue({ batchSize: 10, now: t0, workerId: 'worker-A' });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]!.attempts).toBe(1);

    // 4 minutes later: lock is still fresh → a second worker must NOT steal it.
    const t4 = new Date(t0.getTime() + 4 * 60_000);
    const secondClaim = await repo.claimDue({ batchSize: 10, now: t4, workerId: 'worker-B' });
    expect(secondClaim).toHaveLength(0);

    const row = repo.read(firstClaim[0]!.id)!;
    expect(row.lockedBy).toBe('worker-A'); // lock owner unchanged
    expect(row.attempts).toBe(1); // not re-incremented
  });

  it('reclaims a job whose lock is stale (>= 5 min) and re-increments attempts', async () => {
    await repo.enqueue({
      jobType: 'test.sweep',
      accountId: null,
      payload: {},
      runAt: new Date(2026, 0, 1),
    });
    const t0 = new Date(2026, 0, 1, 0, 0, 1);
    const claimed = await repo.claimDue({ batchSize: 10, now: t0, workerId: 'dead-worker' });
    expect(claimed).toHaveLength(1);

    // 6 minutes later (past the 5-min stale window): a fresh worker reclaims it.
    const t6 = new Date(t0.getTime() + 6 * 60_000);
    const reclaim = await repo.claimDue({ batchSize: 10, now: t6, workerId: 'worker-B' });
    expect(reclaim).toHaveLength(1);
    expect(reclaim[0]!.attempts).toBe(2); // first claim → 1, reclaim → 2

    const row = repo.read(reclaim[0]!.id)!;
    expect(row.lockedBy).toBe('worker-B');
  });

  it('processTick reclaims an orphaned job and runs its handler after the stale window', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    service.register('test.sweep', handler);
    await repo.enqueue({
      jobType: 'test.sweep',
      accountId: null,
      payload: {},
      runAt: new Date(2026, 0, 1),
    });
    // A worker claims it then crashes (never marks complete/retry/failed).
    const t0 = new Date(2026, 0, 1, 0, 0, 1);
    await repo.claimDue({ batchSize: 10, now: t0, workerId: 'dead-worker' });

    // Before the stale window: the live worker (workerId 'test') finds nothing.
    const before = await service.processTick(new Date(t0.getTime() + 4 * 60_000));
    expect(before.processed).toBe(0);
    expect(handler).not.toHaveBeenCalled();

    // After the stale window: the job is reclaimed + the handler runs to completion.
    const after = await service.processTick(new Date(t0.getTime() + 6 * 60_000));
    expect(after.processed).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const row = repo.all()[0]!;
    expect(row.completedAt).toBeInstanceOf(Date);
  });
});
