// 6.g — free-tier session-duration auto-destroy sweep safety test.
//
// LOAD-BEARING: a query bug that auto-destroys PAID sessions would be
// catastrophic (a paying customer's live session killed mid-flight). These
// cases pin the four corners of the eligibility predicate against the
// in-memory repo (which mirrors the Drizzle accounts-join semantics) driven
// through the real SessionsService destroy mechanics.
//
//   1. FREE session created >20 min ago (active)  → destroyed
//   2. FREE session created <20 min ago (active)  → NOT destroyed
//   3. PAID session created >20 min ago (active)  → NOT destroyed (cap=null)
//   4. already-destroyed / errored session        → left alone
//
// Time is driven by an injectable `nowFn` clock passed to tickOnce so no
// real waits are needed.

import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_DURATION_SWEEP_INTERVAL_MS,
  SESSION_DURATION_SWEEP_JOB_TYPE,
  SessionDurationSweeperService,
  type DurationSweepTickResult,
  durationCutoffsFor,
  enqueueNextSessionDurationSweep,
  registerSessionDurationSweepJob,
} from '../../src/services/session-duration-sweeper.js';
import { SessionsService } from '../../src/services/sessions.js';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';
import type { Driver } from '../../src/drivers/types.js';
import type { Logger } from '../../src/lib/logger.js';
import type {
  EnqueueScheduledJobInput,
  ScheduledJobHandler,
  ScheduledJobsService,
} from '../../src/services/scheduled-jobs.js';

const NOW = new Date('2026-05-27T12:00:00.000Z');
const MIN = 60 * 1000;

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

/** Records driver.destroy calls so we can assert which sessions were torn down. */
function stubDriver(): { driver: Driver; destroyed: string[] } {
  const destroyed: string[] = [];
  const driver = {
    destroy(sessionId: string): Promise<void> {
      destroyed.push(sessionId);
      return Promise.resolve();
    },
  } as unknown as Driver;
  return { driver, destroyed };
}

function build() {
  const repo = new InMemorySessionsRepo();
  const { driver, destroyed } = stubDriver();
  const sessions = new SessionsService({ repo, driver });
  const sweeper = new SessionDurationSweeperService({ repo, sessions, logger: silentLogger });
  return { repo, sweeper, destroyed };
}

describe('SessionDurationSweeperService — free-tier auto-destroy safety', () => {
  it('1. destroys a FREE session created >20 min ago (active)', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-free', 'free');
    const s = repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      // 21 min ago — past the 20-min free cap.
      createdAt: new Date(NOW.getTime() - 21 * MIN),
      driverSessionId: 'drv-1',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.destroyed).toBe(1);
    expect(repo.getSession(s.id)?.status).toBe('destroyed');
    expect(destroyed).toContain('drv-1');
  });

  it('2. leaves a FREE session created <20 min ago alone', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-free', 'free');
    const s = repo.seedSession({
      accountId: 'acc-free',
      status: 'busy',
      // 19 min ago — still under the 20-min cap.
      createdAt: new Date(NOW.getTime() - 19 * MIN),
      driverSessionId: 'drv-2',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.destroyed).toBe(0);
    expect(repo.getSession(s.id)?.status).toBe('busy');
    expect(destroyed).toHaveLength(0);
  });

  it('3. CRITICAL: never destroys a PAID (solo_manual) session, even created >20 min ago', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-paid', 'solo_manual');
    const s = repo.seedSession({
      accountId: 'acc-paid',
      status: 'ready',
      // 10 HOURS ago — paid cap is null (unlimited), so still safe.
      createdAt: new Date(NOW.getTime() - 600 * MIN),
      driverSessionId: 'drv-3',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.candidates).toBe(0);
    expect(result.destroyed).toBe(0);
    expect(repo.getSession(s.id)?.status).toBe('ready');
    expect(destroyed).toHaveLength(0);
  });

  it('4. leaves already-destroyed and errored sessions alone (terminal status excluded)', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-free', 'free');
    const ago = new Date(NOW.getTime() - 60 * MIN);
    const destroyedSession = repo.seedSession({
      accountId: 'acc-free',
      status: 'destroyed',
      createdAt: ago,
      driverSessionId: 'drv-destroyed',
    });
    const erroredSession = repo.seedSession({
      accountId: 'acc-free',
      status: 'errored',
      createdAt: ago,
      driverSessionId: 'drv-errored',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.candidates).toBe(0);
    expect(result.destroyed).toBe(0);
    // Status untouched; driver.destroy never re-fired on terminal rows.
    expect(repo.getSession(destroyedSession.id)?.status).toBe('destroyed');
    expect(repo.getSession(erroredSession.id)?.status).toBe('errored');
    expect(destroyed).toHaveLength(0);
  });

  it('TOCTOU: a candidate manually destroyed AFTER the list query is not double-processed (fresh-read guard)', async () => {
    // The sweeper lists candidates then destroys them serially (each awaiting
    // driver.destroy), so a customer can manually destroy a session in that
    // window. autoDestroyExpired must re-read current status rather than trust
    // the stale listed record — otherwise it redundantly driver.destroys,
    // overwrites destroyedAt, and re-fires the session.completed webhook +
    // destroyed event.
    const repo = new InMemorySessionsRepo();
    const { driver, destroyed } = stubDriver();
    const sessions = new SessionsService({ repo, driver });
    repo.setAccountTier('acc-free', 'free');
    const listed = repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      createdAt: new Date(NOW.getTime() - 21 * MIN),
      driverSessionId: 'drv-toctou',
    });
    // Customer destroys it between the sweeper's list query and this call.
    await repo.updateSessionStatus(listed.id, 'destroyed', { destroyedAt: NOW });

    // Sweeper invokes autoDestroyExpired with the STALE 'ready' record.
    const result = await sessions.autoDestroyExpired(
      { ...listed, status: 'ready' },
      { maxMinutes: 20 },
    );

    expect(result.destroyed).toBe(false);
    expect(destroyed).toHaveLength(0); // no redundant driver.destroy
    expect(repo.getSession(listed.id)?.status).toBe('destroyed');
  });

  it('mixed batch: destroys only the expired FREE session out of a free-expired / free-recent / paid-expired / destroyed set', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-free', 'free');
    repo.setAccountTier('acc-paid', 'enterprise');

    const freeExpired = repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      createdAt: new Date(NOW.getTime() - 30 * MIN),
      driverSessionId: 'drv-free-expired',
    });
    const freeRecent = repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      createdAt: new Date(NOW.getTime() - 5 * MIN),
      driverSessionId: 'drv-free-recent',
    });
    const paidExpired = repo.seedSession({
      accountId: 'acc-paid',
      status: 'ready',
      createdAt: new Date(NOW.getTime() - 999 * MIN),
      driverSessionId: 'drv-paid-expired',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.destroyed).toBe(1);
    expect(repo.getSession(freeExpired.id)?.status).toBe('destroyed');
    expect(repo.getSession(freeRecent.id)?.status).toBe('ready');
    expect(repo.getSession(paidExpired.id)?.status).toBe('ready');
    expect(destroyed).toEqual(['drv-free-expired']);
  });

  it('records an auto-destroyed event with the cap on the destroyed FREE session', async () => {
    const { repo, sweeper } = build();
    repo.setAccountTier('acc-free', 'free');
    repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      createdAt: new Date(NOW.getTime() - 25 * MIN),
      driverSessionId: 'drv-evt',
    });

    await sweeper.tickOnce(NOW);

    const destroyEvent = repo.getEvents().find((e) => e.type === 'destroyed');
    expect(destroyEvent).toBeDefined();
    expect(destroyEvent?.payload).toMatchObject({
      auto_destroyed: true,
      reason: 'auto-destroyed: free-tier session duration cap',
      max_session_minutes: 20,
    });
  });

  it('durationCutoffsFor: only emits cutoffs for capped tiers (free); paid tiers (null cap) are absent', () => {
    const cutoffs = durationCutoffsFor(NOW);
    const tiers = cutoffs.map((c) => c.tier);
    expect(tiers).toEqual(['free']);
    // free cutoff = now - 20 min.
    expect(cutoffs[0]!.expiredBefore.toISOString()).toBe(
      new Date(NOW.getTime() - 20 * MIN).toISOString(),
    );
  });

  it('boundary: a FREE session created EXACTLY 20 min ago is NOT destroyed (strict less-than cutoff)', async () => {
    const { repo, sweeper } = build();
    repo.setAccountTier('acc-free', 'free');
    const s = repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      // Exactly 20 min ago → createdAt == cutoff, not strictly before.
      createdAt: new Date(NOW.getTime() - 20 * MIN),
      driverSessionId: 'drv-boundary',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.destroyed).toBe(0);
    expect(repo.getSession(s.id)?.status).toBe('ready');
  });

  it('job type is sessions.duration_sweep + cadence is 2 minutes', () => {
    expect(SESSION_DURATION_SWEEP_JOB_TYPE).toBe('sessions.duration_sweep');
    expect(SESSION_DURATION_SWEEP_INTERVAL_MS).toBe(2 * 60 * 1000);
  });
});

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

describe('SessionDurationSweeperService — re-arm survives an in-flight job', () => {
  // PINS THE RE-ARM-SURVIVES-IN-FLIGHT-JOB CONTRACT. This is the test that
  // SHOULD have caught the staging bug where the sweep only ran once per
  // bootstrap. The real poller runs `await handler(job)` BEFORE
  // `await markComplete(job)`, so when the handler re-arms, the current job
  // is still present + non-completed. A dedup:true re-arm would see it as a
  // pending duplicate and no-op — the chain dies. The re-arm MUST use
  // dedup:false so the next run is always enqueued. FAILS pre-fix
  // (re-arm with dedup:true → no second job); PASSES post-fix.
  it('re-arms a SECOND sweep job even while the current job is still in-flight', async () => {
    const scheduledJobs = new FakeScheduledJobs() as unknown as ScheduledJobsService;
    const fake = scheduledJobs as unknown as FakeScheduledJobs;

    // tickOnce is a no-op — this test only exercises the scheduling chain,
    // not the destroy logic (covered by the cases above).
    const sweeper = {
      tickOnce: () => Promise.resolve({ destroyed: 0, candidates: 0 }),
    } as unknown as SessionDurationSweeperService;

    registerSessionDurationSweepJob({ scheduledJobs, sweeper, logger: silentLogger });

    // (a) bootstrap-enqueue one sweep job (default dedup:true) → 1 pending.
    await enqueueNextSessionDurationSweep({ scheduledJobs });
    expect(fake.pendingOfType(SESSION_DURATION_SWEEP_JOB_TYPE)).toBe(1);

    // (b) run the handler WHILE that bootstrap job is still present +
    //     non-completed (the poller has not called markComplete yet),
    //     mimicking runOne's handler-before-markComplete ordering.
    const handler = fake.getHandler(SESSION_DURATION_SWEEP_JOB_TYPE);
    await handler({
      id: 'job-1',
      jobType: SESSION_DURATION_SWEEP_JOB_TYPE,
      accountId: null,
      payload: {},
      runAt: NOW,
      attempts: 1,
      maxAttempts: 5,
    });

    // (c) the chain re-armed: a SECOND sweep job exists despite the first
    //     still being in-flight.
    expect(fake.pendingOfType(SESSION_DURATION_SWEEP_JOB_TYPE)).toBe(2);
  });

  // PINS THE CHAIN-SURVIVES-A-THROWING-TICK CONTRACT. If tickOnce throws and
  // the re-arm is skipped, the poller retries the job and, once maxAttempts is
  // exhausted, markFailed leaves NO pending sweep row — the self-re-arming
  // chain is dead until a process restart and free sessions over their cap are
  // never auto-destroyed again. The handler MUST swallow the throw (log it) and
  // re-arm exactly once. FAILS pre-fix (throw propagates out of the handler and
  // no re-arm is enqueued); PASSES post-fix.
  it('re-arms exactly once and does NOT reject when tickOnce throws', async () => {
    const scheduledJobs = new FakeScheduledJobs() as unknown as ScheduledJobsService;
    const fake = scheduledJobs as unknown as FakeScheduledJobs;

    // Local vi.fn so we can assert call shape without referencing obj.method as
    // a value (@typescript-eslint/unbound-method).
    const tickOnce = vi.fn<() => Promise<DurationSweepTickResult>>(() =>
      Promise.reject(new Error('boom: repo unavailable')),
    );
    const sweeper = { tickOnce } as unknown as SessionDurationSweeperService;

    registerSessionDurationSweepJob({ scheduledJobs, sweeper, logger: silentLogger });

    const handler = fake.getHandler(SESSION_DURATION_SWEEP_JOB_TYPE);

    // The handler must RESOLVE even though tickOnce rejected (swallow-not-rethrow).
    await expect(
      handler({
        id: 'job-throw',
        jobType: SESSION_DURATION_SWEEP_JOB_TYPE,
        accountId: null,
        payload: {},
        runAt: NOW,
        attempts: 1,
        maxAttempts: 5,
      }),
    ).resolves.toBeUndefined();

    expect(tickOnce).toHaveBeenCalledTimes(1);
    // Exactly one re-arm was enqueued (dedup:false) despite the throw — the
    // chain survives. No bootstrap enqueue here, so exactly 1 pending.
    expect(fake.pendingOfType(SESSION_DURATION_SWEEP_JOB_TYPE)).toBe(1);
  });
});
