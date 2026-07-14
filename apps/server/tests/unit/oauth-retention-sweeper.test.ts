import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type {
  EnqueueScheduledJobInput,
  ScheduledJobHandler,
  ScheduledJobRow,
  ScheduledJobsService,
} from '../../src/services/scheduled-jobs.js';
import {
  OAUTH_RETENTION_SWEEP_INTERVAL_MS,
  OAUTH_RETENTION_SWEEP_JOB_TYPE,
  OAuthRetentionSweeperService,
  enqueueNextOAuthRetentionSweep,
  registerOAuthRetentionSweepJob,
} from '../../src/services/oauth-retention-sweeper.js';

function schedulerHarness(): {
  scheduler: Pick<ScheduledJobsService, 'register' | 'enqueue'>;
  handler: () => ScheduledJobHandler;
  enqueued: EnqueueScheduledJobInput[];
} {
  let registered: ScheduledJobHandler | undefined;
  const enqueued: EnqueueScheduledJobInput[] = [];
  const scheduler: Pick<ScheduledJobsService, 'register' | 'enqueue'> = {
    register(jobType, handler) {
      expect(jobType).toBe(OAUTH_RETENTION_SWEEP_JOB_TYPE);
      registered = handler;
    },
    enqueue(input) {
      enqueued.push(input);
      return Promise.resolve({ enqueued: true });
    },
  };
  return {
    scheduler,
    handler: () => {
      if (registered === undefined) throw new Error('handler not registered');
      return registered;
    },
    enqueued,
  };
}

function job(): ScheduledJobRow {
  return {
    id: 'job-oauth-retention',
    jobType: OAUTH_RETENTION_SWEEP_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(0),
    attempts: 1,
    maxAttempts: 3,
  };
}

describe('OAuth provider retention sweeper', () => {
  it('passes the exact clock to the store and reports deletion counts', async () => {
    const pruneExpired = vi.fn().mockResolvedValue({ authorizations: 2, codes: 3, tokens: 4 });
    const sweeper = new OAuthRetentionSweeperService({ pruneExpired });
    const now = new Date('2026-07-14T10:00:00.000Z');
    await expect(sweeper.tickOnce(now)).resolves.toEqual({
      authorizations: 2,
      codes: 3,
      tokens: 4,
    });
    expect(pruneExpired).toHaveBeenCalledOnce();
    expect(pruneExpired).toHaveBeenCalledWith(now.getTime());
  });

  it('bootstrap enqueue deduplicates and schedules exactly one hour later', async () => {
    const harness = schedulerHarness();
    const now = Date.parse('2026-07-14T10:00:00.000Z');
    await enqueueNextOAuthRetentionSweep({
      scheduledJobs: harness.scheduler,
      nowFn: () => now,
    });
    expect(harness.enqueued).toEqual([
      expect.objectContaining({
        jobType: OAUTH_RETENTION_SWEEP_JOB_TYPE,
        accountId: null,
        payload: {},
        runAt: new Date(now + OAUTH_RETENTION_SWEEP_INTERVAL_MS),
        dedupOnAccountAndType: true,
      }),
    ]);
  });

  it('logs bounded counts and re-arms with retry-safe current-row exclusion', async () => {
    const harness = schedulerHarness();
    const now = Date.parse('2026-07-14T10:00:00.000Z');
    const sweeper = new OAuthRetentionSweeperService({
      pruneExpired: vi.fn().mockResolvedValue({ authorizations: 1, codes: 2, tokens: 3 }),
    });
    const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;
    registerOAuthRetentionSweepJob({
      scheduledJobs: harness.scheduler,
      sweeper,
      logger,
      nowFn: () => now,
    });

    await expect(harness.handler()(job())).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizations: 1,
        codes: 2,
        tokens: 3,
        total: 6,
      }),
      'OAuth retention sweep complete',
    );
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]).toMatchObject({
      runAt: new Date(now + OAUTH_RETENTION_SWEEP_INTERVAL_MS),
      dedupOnAccountAndType: true,
      dedupAfterRunAt: new Date(0),
    });
  });

  it('does not expose thrown text, does not retry-fan-out, and still re-arms once', async () => {
    const harness = schedulerHarness();
    const now = Date.parse('2026-07-14T10:00:00.000Z');
    const sweeper = new OAuthRetentionSweeperService({
      pruneExpired: vi.fn().mockRejectedValue(new TypeError('postgres://user:secret@host')),
    });
    const error = vi.fn();
    const logger = { info: vi.fn(), error } as unknown as Logger;
    registerOAuthRetentionSweepJob({
      scheduledJobs: harness.scheduler,
      sweeper,
      logger,
      nowFn: () => now,
    });

    await expect(harness.handler()(job())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'oauth_retention_sweep_failed',
        error_type: 'TypeError',
      }),
      'OAuth retention sweep failed — re-arming for the next tick',
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]).toMatchObject({
      dedupOnAccountAndType: true,
      dedupAfterRunAt: new Date(0),
    });
  });
});
