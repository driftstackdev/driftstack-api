// V-541.E — unit tests for the nightly cost-recompute job wiring.

import { describe, expect, it, vi } from 'vitest';
import {
  COST_NIGHTLY_JOB_TYPE,
  enqueueNextNightlyRun,
  nextMidnightUtc,
  registerCostNightlyJob,
} from '../../src/services/cost-nightly-job.js';
import {
  CostAlertDispatcher,
  type AlertSink,
  type CostAlertPayload,
} from '../../src/services/cost-alert-dispatcher.js';
import { CostMonitoringService, type UsageAggregator } from '../../src/services/cost-monitoring.js';
import {
  ScheduledJobsService,
  type ScheduledJobRow,
  type ScheduledJobsRepo,
  type EnqueueScheduledJobInput,
} from '../../src/services/scheduled-jobs.js';
import type { CostRates, UsageInputs } from '../../src/lib/cost-estimator.js';
import type { Logger } from '../../src/lib/logger.js';

const RATES: CostRates = {
  computeCentsPerMinute: 1,
  storageCentsPerGbMonth: 2,
  egressCentsPerGb: 5,
  emailCentsPerSend: 1,
  llmCentsPer1kInputTokens: 30,
  llmCentsPer1kOutputTokens: 150,
};

class StubScheduledJobsRepo implements ScheduledJobsRepo {
  enqueues: EnqueueScheduledJobInput[] = [];
  enqueue(input: EnqueueScheduledJobInput): Promise<{ enqueued: boolean }> {
    this.enqueues.push(input);
    return Promise.resolve({ enqueued: true });
  }
  claimDue(): Promise<ScheduledJobRow[]> {
    return Promise.resolve([]);
  }
  markComplete(): Promise<void> {
    return Promise.resolve();
  }
  markRetry(): Promise<void> {
    return Promise.resolve();
  }
  markFailed(): Promise<void> {
    return Promise.resolve();
  }
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

function makeStack(
  usageByAccount: Map<string, UsageInputs>,
  accountIds: readonly string[],
): {
  scheduledJobs: ScheduledJobsService;
  repo: StubScheduledJobsRepo;
  dispatcher: CostAlertDispatcher;
  capturedAlerts: CostAlertPayload[];
  logger: Logger;
  accounts: { listAllAccountIds: () => Promise<readonly string[]> };
} {
  const aggregator: UsageAggregator = {
    aggregateForAccount: ({ accountId }) => Promise.resolve(usageByAccount.get(accountId) ?? null),
  };
  const service = new CostMonitoringService({
    aggregator,
    rates: RATES,
    tierThresholds: { solo_manual: { softCents: 100, hardCents: 200 } },
    resolveTier: () => Promise.resolve('solo_manual'),
  });
  const capturedAlerts: CostAlertPayload[] = [];
  const sink: AlertSink = (alert) => {
    capturedAlerts.push(alert);
    return Promise.resolve();
  };
  const dispatcher = new CostAlertDispatcher({ service, sendAlert: sink });
  const logger = makeLogger();
  const repo = new StubScheduledJobsRepo();
  const scheduledJobs = new ScheduledJobsService(repo, logger, {
    workerId: 'test-worker',
  });
  return {
    scheduledJobs,
    repo,
    dispatcher,
    capturedAlerts,
    logger,
    accounts: { listAllAccountIds: () => Promise.resolve(accountIds) },
  };
}

const EMPTY_USAGE: UsageInputs = {
  sessionMinutes: 0,
  storageGbMonths: 0,
  egressGb: 0,
  emailSends: 0,
  llmInputTokens: 0,
  llmOutputTokens: 0,
};

const FAKE_JOB: ScheduledJobRow = {
  id: 'job-1',
  jobType: COST_NIGHTLY_JOB_TYPE,
  accountId: null,
  payload: {},
  runAt: new Date('2026-05-12T00:00:00Z'),
  attempts: 1,
  maxAttempts: 3,
};

describe('V-541.E nextMidnightUtc', () => {
  it('returns the next UTC midnight strictly after now', () => {
    expect(nextMidnightUtc(new Date('2026-05-11T12:00:00Z')).toISOString()).toBe(
      '2026-05-12T00:00:00.000Z',
    );
  });

  it('returns the following day even when called at midnight exactly', () => {
    expect(nextMidnightUtc(new Date('2026-05-11T00:00:00Z')).toISOString()).toBe(
      '2026-05-12T00:00:00.000Z',
    );
  });
});

describe('V-541.E enqueueNextNightlyRun', () => {
  it('enqueues a row at the next UTC midnight with dedup flag', async () => {
    const stack = makeStack(new Map(), []);
    await enqueueNextNightlyRun({
      scheduledJobs: stack.scheduledJobs,
      nowFn: () => new Date('2026-05-11T12:00:00Z').getTime(),
    });
    expect(stack.repo.enqueues).toHaveLength(1);
    const row = stack.repo.enqueues[0];
    expect(row?.jobType).toBe(COST_NIGHTLY_JOB_TYPE);
    expect(row?.accountId).toBeNull();
    expect(row?.dedupOnAccountAndType).toBe(true);
    expect(row?.runAt.toISOString()).toBe('2026-05-12T00:00:00.000Z');
  });
});

describe('V-541.E registerCostNightlyJob — handler execution', () => {
  it('evaluates dispatcher for every account and re-enqueues next run', async () => {
    const usage = new Map<string, UsageInputs>([
      ['a', { ...EMPTY_USAGE, sessionMinutes: 1_000 }],
      ['b', { ...EMPTY_USAGE, sessionMinutes: 50 }],
    ]);
    const stack = makeStack(usage, ['a', 'b']);
    registerCostNightlyJob({
      scheduledJobs: stack.scheduledJobs,
      service: makeStackService(stack),
      dispatcher: stack.dispatcher,
      accounts: stack.accounts,
      logger: stack.logger,
      nowFn: () => new Date('2026-05-11T23:30:00Z').getTime(),
    });
    // Invoke the registered handler directly via processTick after
    // enqueueing a synthetic job — simpler than going through the
    // full claim/dispatch cycle.
    await invokeHandler(stack.scheduledJobs, COST_NIGHTLY_JOB_TYPE, FAKE_JOB);
    // One critical alert for account 'a' (over-hard); zero for 'b' (under-soft skip).
    expect(stack.capturedAlerts).toHaveLength(1);
    expect(stack.capturedAlerts[0]?.account_id).toBe('a');
    expect(stack.capturedAlerts[0]?.severity).toBe('critical');
    // Re-arm: a new enqueue at the next midnight.
    expect(stack.repo.enqueues).toHaveLength(1);
    expect(stack.repo.enqueues[0]?.runAt.toISOString()).toBe('2026-05-12T00:00:00.000Z');
  });

  it('skips evaluation when account list is empty but still re-enqueues', async () => {
    const stack = makeStack(new Map(), []);
    registerCostNightlyJob({
      scheduledJobs: stack.scheduledJobs,
      service: makeStackService(stack),
      dispatcher: stack.dispatcher,
      accounts: stack.accounts,
      logger: stack.logger,
      nowFn: () => new Date('2026-05-11T23:30:00Z').getTime(),
    });
    await invokeHandler(stack.scheduledJobs, COST_NIGHTLY_JOB_TYPE, FAKE_JOB);
    expect(stack.capturedAlerts).toHaveLength(0);
    expect(stack.repo.enqueues).toHaveLength(1);
  });

  it('handler logs the alert outcome on every run', async () => {
    const stack = makeStack(new Map([['a', { ...EMPTY_USAGE, sessionMinutes: 1_000 }]]), ['a']);
    registerCostNightlyJob({
      scheduledJobs: stack.scheduledJobs,
      service: makeStackService(stack),
      dispatcher: stack.dispatcher,
      accounts: stack.accounts,
      logger: stack.logger,
    });
    await invokeHandler(stack.scheduledJobs, COST_NIGHTLY_JOB_TYPE, FAKE_JOB);
    expect(stack.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'cost-nightly', alerts_fired: 1 }),
      expect.stringContaining('cost nightly recompute complete'),
    );
  });
});

// ─── helpers ───────────────────────────────────────────────────────

function makeStackService(stack: ReturnType<typeof makeStack>): CostMonitoringService {
  // Re-export the dispatcher's internal service so the test handler
  // wiring matches the production composition.
  // The dispatcher holds a private service reference; for testing we
  // just construct a parallel one that reads from the same aggregator.
  const aggregator: UsageAggregator = {
    aggregateForAccount: () => Promise.resolve(null),
  };
  return new CostMonitoringService({
    aggregator,
    rates: RATES,
    tierThresholds: { solo_manual: { softCents: 100, hardCents: 200 } },
    resolveTier: () => Promise.resolve('solo_manual'),
  });
  void stack;
}

async function invokeHandler(
  scheduledJobs: ScheduledJobsService,
  jobType: string,
  job: ScheduledJobRow,
): Promise<void> {
  // The handlers map is private; we reach in via the registered name
  // through ScheduledJobsService.register returning void. Workaround:
  // expose via processTick is too heavy. Use a private-property cast.
  const handlers = (
    scheduledJobs as unknown as {
      handlers: Map<string, (j: ScheduledJobRow) => Promise<void>>;
    }
  ).handlers;
  const handler = handlers.get(jobType);
  if (!handler) throw new Error('no handler registered');
  await handler(job);
}
