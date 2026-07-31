// V-553.B-29 — unit tests for ScheduledJobsService.
//
// Surface under test:
//   - register / enqueue pass-through
//   - processTick:
//     - empty due queue → processed=0, no handler calls
//     - happy path: handler runs, markComplete called
//     - missing handler → markFailed with diagnostic message
//     - retryable failure → markRetry with exponential-backoff nextRunAt
//     - attempts-exhausted failure → markFailed with last error
//     - concurrent batch: all jobs in the batch are dispatched in parallel

import { describe, expect, it } from 'vitest';
import {
  ScheduledJobsService,
  type EnqueueScheduledJobInput,
  type ScheduledJobRow,
  type ScheduledJobsRepo,
} from '../../src/services/scheduled-jobs.js';
import type { Logger } from '../../src/lib/logger.js';

function makeRepo(initialDue: ScheduledJobRow[] = []): {
  repo: ScheduledJobsRepo;
  state: {
    completed: string[];
    retried: Array<{ id: string; lastError: string; nextRunAt: Date }>;
    failed: Array<{ id: string; lastError: string }>;
    enqueues: EnqueueScheduledJobInput[];
  };
} {
  const state = {
    completed: [] as string[],
    retried: [] as Array<{ id: string; lastError: string; nextRunAt: Date }>,
    failed: [] as Array<{ id: string; lastError: string }>,
    enqueues: [] as EnqueueScheduledJobInput[],
  };
  let due = [...initialDue];
  const repo: ScheduledJobsRepo = {
    jobTypesWithPendingWork: () => Promise.resolve([]),
    enqueue: (input) => {
      state.enqueues.push(input);
      return Promise.resolve({ enqueued: true });
    },
    claimDue: () => {
      const batch = due;
      due = [];
      return Promise.resolve(batch);
    },
    markComplete: (jobId) => {
      state.completed.push(jobId);
      return Promise.resolve();
    },
    markRetry: (jobId, opts) => {
      state.retried.push({ id: jobId, lastError: opts.lastError, nextRunAt: opts.nextRunAt });
      return Promise.resolve();
    },
    markFailed: (jobId, opts) => {
      state.failed.push({ id: jobId, lastError: opts.lastError });
      return Promise.resolve();
    },
    pruneFinished: () => Promise.resolve(0),
  };
  return { repo, state };
}

function makeLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

function row(overrides: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: 'job_1',
    jobType: 'trial.expire',
    accountId: 'acc_a',
    payload: {},
    runAt: new Date(),
    attempts: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

const NOW = new Date('2026-05-11T12:00:00Z');

describe('V-553.B-29 ScheduledJobsService.enqueue', () => {
  it('forwards the input to the repo', async () => {
    const { repo, state } = makeRepo();
    const svc = new ScheduledJobsService(repo, makeLogger(), { workerId: 'w' });
    await svc.enqueue({
      jobType: 'trial.expire',
      accountId: 'acc_a',
      payload: { foo: 1 },
      runAt: NOW,
      dedupOnAccountAndType: true,
    });
    expect(state.enqueues).toHaveLength(1);
    expect(state.enqueues[0]?.jobType).toBe('trial.expire');
    expect(state.enqueues[0]?.dedupOnAccountAndType).toBe(true);
  });
});

describe('V-553.B-29 ScheduledJobsService.processTick', () => {
  it('returns processed=0 when no jobs are due', async () => {
    const { repo } = makeRepo();
    const svc = new ScheduledJobsService(repo, makeLogger(), { workerId: 'w' });
    const out = await svc.processTick(NOW);
    expect(out.processed).toBe(0);
  });

  it('runs the handler + marks complete on success', async () => {
    const { repo, state } = makeRepo([row({ id: 'j1' })]);
    const svc = new ScheduledJobsService(repo, makeLogger(), { workerId: 'w' });
    let handlerCalls = 0;
    svc.register('trial.expire', () => {
      handlerCalls += 1;
      return Promise.resolve();
    });
    const out = await svc.processTick(NOW);
    expect(out.processed).toBe(1);
    expect(handlerCalls).toBe(1);
    expect(state.completed).toEqual(['j1']);
    expect(state.retried).toEqual([]);
    expect(state.failed).toEqual([]);
  });

  it('marks failed (not retried) when no handler is registered', async () => {
    const { repo, state } = makeRepo([row({ id: 'j_unknown', jobType: 'nope' })]);
    const svc = new ScheduledJobsService(repo, makeLogger(), { workerId: 'w' });
    await svc.processTick(NOW);
    expect(state.failed).toHaveLength(1);
    expect(state.failed[0]?.id).toBe('j_unknown');
    expect(state.failed[0]?.lastError).toContain('no handler registered');
    expect(state.completed).toEqual([]);
  });

  it('marks retry with exponential backoff when handler throws + attempts < max', async () => {
    const { repo, state } = makeRepo([row({ id: 'j_retry', attempts: 1, maxAttempts: 3 })]);
    const svc = new ScheduledJobsService(repo, makeLogger(), {
      workerId: 'w',
      retryBackoffBaseMs: 60_000,
    });
    svc.register('trial.expire', () => Promise.reject(new Error('transient')));
    await svc.processTick(NOW);
    expect(state.retried).toHaveLength(1);
    expect(state.retried[0]?.lastError).toBe('transient');
    // attempts=1 → backoff = base * 2^0 = 60s.
    const expectedNext = new Date(NOW.getTime() + 60_000);
    expect(state.retried[0]?.nextRunAt.getTime()).toBe(expectedNext.getTime());
    expect(state.failed).toEqual([]);
  });

  it('uses doubled backoff on subsequent attempts (2^(attempts-1))', async () => {
    const { repo, state } = makeRepo([row({ id: 'j_retry_2', attempts: 3, maxAttempts: 5 })]);
    const svc = new ScheduledJobsService(repo, makeLogger(), {
      workerId: 'w',
      retryBackoffBaseMs: 60_000,
    });
    svc.register('trial.expire', () => Promise.reject(new Error('flaky')));
    await svc.processTick(NOW);
    // attempts=3 → 60_000 * 2^2 = 240_000ms.
    const expectedNext = new Date(NOW.getTime() + 240_000);
    expect(state.retried[0]?.nextRunAt.getTime()).toBe(expectedNext.getTime());
  });

  it('marks permanently failed when attempts >= maxAttempts', async () => {
    const { repo, state } = makeRepo([row({ id: 'j_done', attempts: 3, maxAttempts: 3 })]);
    const svc = new ScheduledJobsService(repo, makeLogger(), { workerId: 'w' });
    svc.register('trial.expire', () => Promise.reject(new Error('last gasp')));
    await svc.processTick(NOW);
    expect(state.failed).toHaveLength(1);
    expect(state.failed[0]?.lastError).toBe('last gasp');
    expect(state.retried).toEqual([]);
  });

  it('dispatches the whole batch in parallel + counts processed correctly', async () => {
    const { repo, state } = makeRepo([
      row({ id: 'a', jobType: 'h_a' }),
      row({ id: 'b', jobType: 'h_b' }),
      row({ id: 'c', jobType: 'h_c' }),
    ]);
    const svc = new ScheduledJobsService(repo, makeLogger(), { workerId: 'w' });
    svc.register('h_a', () => Promise.resolve());
    svc.register('h_b', () => Promise.resolve());
    svc.register('h_c', () => Promise.resolve());
    const out = await svc.processTick(NOW);
    expect(out.processed).toBe(3);
    expect(state.completed.sort()).toEqual(['a', 'b', 'c']);
  });

  it('coerces non-Error throws to string in lastError', async () => {
    const { repo, state } = makeRepo([row({ id: 'j_string_err', attempts: 1, maxAttempts: 3 })]);
    const svc = new ScheduledJobsService(repo, makeLogger(), { workerId: 'w' });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    svc.register('trial.expire', () => Promise.reject('not-an-error-object'));
    await svc.processTick(NOW);
    expect(state.retried[0]?.lastError).toBe('not-an-error-object');
  });

  it('bounds and redacts credential-bearing handler failures before persistence', async () => {
    const { repo, state } = makeRepo([row({ id: 'j_secret_err', attempts: 1, maxAttempts: 3 })]);
    const svc = new ScheduledJobsService(repo, makeLogger(), { workerId: 'w' });
    svc.register('trial.expire', () =>
      Promise.reject(
        new Error(
          `provider failed https://api.invalid/x?access_token=ACCESS_SECRET Authorization: Bearer BEARER_SECRET ${'x'.repeat(5_000)}`,
        ),
      ),
    );
    await svc.processTick(NOW);

    const persisted = state.retried[0]?.lastError ?? '';
    expect(persisted.length).toBeLessThanOrEqual(500);
    expect(persisted).toContain('[redacted]');
    expect(persisted).not.toContain('ACCESS_SECRET');
    expect(persisted).not.toContain('BEARER_SECRET');
  });

  it('fails safely when a thrown non-Error cannot be stringified', async () => {
    const { repo, state } = makeRepo([row({ id: 'j_hostile_err', attempts: 1, maxAttempts: 3 })]);
    const svc = new ScheduledJobsService(repo, makeLogger(), { workerId: 'w' });
    const hostile = {
      toString(): string {
        throw new Error('stringification failed');
      },
    };
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    svc.register('trial.expire', () => Promise.reject(hostile));
    await svc.processTick(NOW);

    expect(state.retried[0]?.lastError).toBe('scheduled job failed');
  });
});
