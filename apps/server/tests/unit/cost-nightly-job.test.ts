// V-541.E — unit tests for the nightly cost-recompute job wiring.

import { describe, expect, it, vi } from 'vitest';
import {
  COST_NIGHTLY_JOB_TYPE,
  cycleAnchorForTick,
  enqueueNextNightlyRun,
  nextMidnightUtc,
  registerCostNightlyJob,
} from '../../src/services/cost-nightly-job.js';
import { billingCycleFromDate } from '../../src/services/cost-monitoring.js';
import {
  CostAlertDispatcher,
  type AlertSink,
  type CostAlertPayload,
} from '../../src/services/cost-alert-dispatcher.js';
import { CostMonitoringService, type UsageAggregator } from '../../src/services/cost-monitoring.js';
import {
  ScheduledJobsService,
  type ScheduledJobHandler,
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
  pruneFinished(): Promise<number> {
    return Promise.resolve(0);
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

// Minimal fake that models the REAL repo dedup semantics so the re-arm
// chain can be exercised without a database. `enqueue` no-ops when
// `dedupOnAccountAndType` is true AND a non-completed job with the same
// (jobType, accountId) already exists — exactly the predicate
// (`completed_at IS NULL AND failed_at IS NULL`) the poller leaves the
// in-flight, still-locked current job in while it runs the handler.
class FakeScheduledJobs {
  /** Enqueued jobs; `completed` flips when a job is marked complete. */
  readonly jobs: Array<{ jobType: string; accountId: string | null; completed: boolean }> = [];
  private readonly handlers = new Map<string, ScheduledJobHandler>();

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
    this.jobs.push({ jobType: input.jobType, accountId: input.accountId, completed: false });
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

describe('V-541.E registerCostNightlyJob — re-arm survives an in-flight job', () => {
  // PINS THE RE-ARM-SURVIVES-IN-FLIGHT-JOB CONTRACT (same bug class fixed
  // for sessions.duration_sweep in abcf76e7). The real poller runs
  // `await handler(job)` BEFORE `await markComplete(job)`, so when the
  // handler re-arms, the current job is still present + non-completed. A
  // dedup:true re-arm would see it as a pending duplicate and no-op — the
  // nightly chain dies after one run (only the bootstrap-on-restart
  // enqueue would ever fire). The re-arm MUST use dedup:false so the next
  // run is always enqueued. FAILS pre-fix (re-arm with dedup:true → no
  // second job); PASSES post-fix. Covers BOTH the populated-accounts
  // re-arm and the zero-accounts re-arm branch.
  function makeFakeStack(accountIds: readonly string[]): {
    fake: FakeScheduledJobs;
    scheduledJobs: ScheduledJobsService;
    dispatcher: CostAlertDispatcher;
    service: CostMonitoringService;
    accounts: { listAllAccountIds: () => Promise<readonly string[]> };
    logger: Logger;
  } {
    const aggregator: UsageAggregator = {
      aggregateForAccount: () => Promise.resolve(EMPTY_USAGE),
    };
    const service = new CostMonitoringService({
      aggregator,
      rates: RATES,
      tierThresholds: { solo_manual: { softCents: 100, hardCents: 200 } },
      resolveTier: () => Promise.resolve('solo_manual'),
    });
    const dispatcher = new CostAlertDispatcher({ service, sendAlert: () => Promise.resolve() });
    const fake = new FakeScheduledJobs();
    return {
      fake,
      scheduledJobs: fake as unknown as ScheduledJobsService,
      dispatcher,
      service,
      accounts: { listAllAccountIds: () => Promise.resolve(accountIds) },
      logger: makeLogger(),
    };
  }

  async function runReArmScenario(accountIds: readonly string[]): Promise<FakeScheduledJobs> {
    const stack = makeFakeStack(accountIds);
    registerCostNightlyJob({
      scheduledJobs: stack.scheduledJobs,
      service: stack.service,
      dispatcher: stack.dispatcher,
      accounts: stack.accounts,
      logger: stack.logger,
      nowFn: () => new Date('2026-05-11T23:30:00Z').getTime(),
    });

    // (a) bootstrap-enqueue one nightly job (default dedup:true) → 1 pending.
    await enqueueNextNightlyRun({ scheduledJobs: stack.scheduledJobs });
    expect(stack.fake.pendingOfType(COST_NIGHTLY_JOB_TYPE)).toBe(1);

    // (b) run the handler WHILE that bootstrap job is still present +
    //     non-completed (the poller has not called markComplete yet),
    //     mimicking runOne's handler-before-markComplete ordering.
    const handler = stack.fake.getHandler(COST_NIGHTLY_JOB_TYPE);
    await handler({
      id: 'job-1',
      jobType: COST_NIGHTLY_JOB_TYPE,
      accountId: null,
      payload: {},
      runAt: new Date('2026-05-12T00:00:00Z'),
      attempts: 1,
      maxAttempts: 3,
    });
    return stack.fake;
  }

  it('re-arms a SECOND nightly job even while the current job is in-flight (populated accounts)', async () => {
    const fake = await runReArmScenario(['a', 'b']);
    expect(fake.pendingOfType(COST_NIGHTLY_JOB_TYPE)).toBe(2);
  });

  it('re-arms a SECOND nightly job even while the current job is in-flight (zero-accounts branch)', async () => {
    const fake = await runReArmScenario([]);
    expect(fake.pendingOfType(COST_NIGHTLY_JOB_TYPE)).toBe(2);
  });
});

describe('V-541.E registerCostNightlyJob — re-arm survives a throwing tick (chain never dies)', () => {
  // PINS THE CHAIN-SURVIVAL CONTRACT (same bug class as the crypto entitlement
  // sweeper). If the tick's work throws (e.g. listAllAccountIds or
  // dispatcher.evaluate fails), the handler must SWALLOW the error and still
  // re-arm exactly once — otherwise the poller retries to maxAttempts, then
  // markFailed leaves NO pending nightly row and cost alerting silently stops
  // forever until a process restart. It must NOT re-throw-and-re-arm (fan-out).
  // FAILS pre-fix (throw propagates, no re-arm); PASSES post-fix. Covers both
  // the listAllAccountIds throw and the dispatcher.evaluate throw.
  function makeThrowingStack(mode: 'accounts' | 'dispatcher'): {
    fake: FakeScheduledJobs;
    dispatcher: CostAlertDispatcher;
    service: CostMonitoringService;
    accounts: { listAllAccountIds: () => Promise<readonly string[]> };
    logger: Logger;
  } {
    const service = new CostMonitoringService({
      aggregator: { aggregateForAccount: () => Promise.resolve(EMPTY_USAGE) },
      rates: RATES,
      tierThresholds: { solo_manual: { softCents: 100, hardCents: 200 } },
      resolveTier: () => Promise.resolve('solo_manual'),
    });
    const dispatcher = new CostAlertDispatcher({ service, sendAlert: () => Promise.resolve() });
    if (mode === 'dispatcher') {
      vi.spyOn(dispatcher, 'evaluate').mockRejectedValue(new Error('evaluate boom'));
    }
    const accounts = {
      listAllAccountIds: (): Promise<readonly string[]> =>
        mode === 'accounts' ? Promise.reject(new Error('list boom')) : Promise.resolve(['a', 'b']),
    };
    return { fake: new FakeScheduledJobs(), dispatcher, service, accounts, logger: makeLogger() };
  }

  async function runThrowingHandler(mode: 'accounts' | 'dispatcher'): Promise<FakeScheduledJobs> {
    const stack = makeThrowingStack(mode);
    registerCostNightlyJob({
      scheduledJobs: stack.fake as unknown as ScheduledJobsService,
      service: stack.service,
      dispatcher: stack.dispatcher,
      accounts: stack.accounts,
      logger: stack.logger,
      nowFn: () => new Date('2026-05-11T23:30:00Z').getTime(),
    });
    const handler = stack.fake.getHandler(COST_NIGHTLY_JOB_TYPE);
    // The handler must RESOLVE (swallow) despite the throwing tick.
    await expect(handler(FAKE_JOB)).resolves.toBeUndefined();
    return stack.fake;
  }

  it('swallows a listAllAccountIds failure and re-arms exactly once (dedup:false)', async () => {
    const fake = await runThrowingHandler('accounts');
    expect(fake.pendingOfType(COST_NIGHTLY_JOB_TYPE)).toBe(1);
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0]).toMatchObject({ jobType: COST_NIGHTLY_JOB_TYPE, accountId: null });
  });

  it('swallows a dispatcher.evaluate failure and re-arms exactly once (dedup:false)', async () => {
    const fake = await runThrowingHandler('dispatcher');
    expect(fake.pendingOfType(COST_NIGHTLY_JOB_TYPE)).toBe(1);
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0]).toMatchObject({ jobType: COST_NIGHTLY_JOB_TYPE, accountId: null });
  });
});

describe('C12 — cycleAnchorForTick evaluates the day that just ended', () => {
  const cycle = (iso: string): string => billingCycleFromDate(cycleAnchorForTick(new Date(iso)));

  it('month rollover: a run at 00:00 on the 1st evaluates the PREVIOUS month', () => {
    expect(cycle('2026-08-01T00:00:00.000Z')).toBe('2026-07');
  });
  it('a late tick minutes after midnight still evaluates the previous month on the 1st', () => {
    expect(cycle('2026-08-01T00:07:33.000Z')).toBe('2026-07');
  });
  it('mid-month is unchanged (same YYYY-MM as the tick)', () => {
    expect(cycle('2026-07-15T00:00:00.000Z')).toBe('2026-07');
  });
  it('year rollover Dec→Jan resolves to the previous December', () => {
    expect(cycle('2027-01-01T00:00:00.000Z')).toBe('2026-12');
  });
  it('a leap-day tick stays within the same month', () => {
    expect(cycle('2028-02-29T00:00:00.000Z')).toBe('2028-02');
  });
  it('the anchor is the last instant of the previous UTC day', () => {
    expect(cycleAnchorForTick(new Date('2026-08-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-07-31T23:59:59.999Z',
    );
  });
});

describe('C12 — the nightly handler evaluates the just-ended cycle', () => {
  it('a month-rollover tick passes the previous month to dispatcher.evaluate', async () => {
    const stack = makeStack(new Map([['a', { ...EMPTY_USAGE, sessionMinutes: 10 }]]), ['a']);
    const spy = vi.spyOn(stack.dispatcher, 'evaluate');
    registerCostNightlyJob({
      scheduledJobs: stack.scheduledJobs,
      service: makeStackService(stack),
      dispatcher: stack.dispatcher,
      accounts: stack.accounts,
      logger: stack.logger,
      nowFn: () => new Date('2026-08-01T00:05:00Z').getTime(),
    });
    await invokeHandler(stack.scheduledJobs, COST_NIGHTLY_JOB_TYPE, FAKE_JOB);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].billingCycle).toBe('2026-07');
  });
});
