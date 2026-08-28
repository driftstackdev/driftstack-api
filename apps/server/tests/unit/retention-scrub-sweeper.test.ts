// V-759 — the retention scrub's failure behaviour, which is where a compliance sweep goes
// quiet rather than loud.
//
// The DB-backed guards (tests/integration/db-retention-scrub-drizzle.test.ts) prove the SQL
// touches the right rows. These prove the things that make the sweep keep running at all:
//
//  1. One failing step must not strand the other two. Sessions and keys are independent, and
//     a transient error on one is not a reason to hold personal data past its window on the
//     others.
//  2. A failed step must ALARM. This is the specific way a retention promise dies silently —
//     the rows stay, nothing throws, the suite is green, and nobody finds out until a
//     regulator or a customer asks.
//  3. A tick that throws must still RE-ARM. A chain that stops re-arming stops enforcing a
//     disclosed window permanently, until someone happens to restart the process.
//  4. A no-op tick must stay quiet, so that a line in the log genuinely means personal data
//     was touched.

import { describe, expect, it, vi } from 'vitest';
import {
  RetentionScrubSweeperService,
  registerRetentionScrubJob,
  enqueueNextRetentionScrub,
  RETENTION_SCRUB_JOB_TYPE,
  RETENTION_SCRUB_INTERVAL_MS,
} from '../../src/services/retention-scrub-sweeper.js';
import {
  RETENTION_WINDOW_DAYS,
  type RetentionScrubRepo,
} from '../../src/db/retention-scrub-repo.js';
import type { ScheduledJobsService, ScheduledJobRow } from '../../src/services/scheduled-jobs.js';

const NOW = new Date('2026-08-12T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

type Outcome = { affected: number; capped: boolean };
const ok = (affected: number, capped = false): Promise<Outcome> =>
  Promise.resolve({ affected, capped });

function makeRepo(over: Partial<RetentionScrubRepo> = {}): RetentionScrubRepo {
  return {
    deleteExpiredSessionOperations: () => ok(0),
    scrubExpiredSessionMetadata: () => ok(0),
    scrubExpiredRevokedApiKeys: () => ok(0),
    scrubExpiredWebSessionIdentifiers: () => ok(0),
    ...over,
  };
}

function makeLogger(): {
  logger: NonNullable<ConstructorParameters<typeof RetentionScrubSweeperService>[0]['logger']>;
  infos: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
} {
  const infos: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  return {
    logger: {
      info: (obj: Record<string, unknown>) => void infos.push(obj),
      error: (obj: Record<string, unknown>) => void errors.push(obj),
    },
    infos,
    errors,
  };
}

describe('retention scrub sweeper (V-759)', () => {
  it('applies the disclosed 90-day window, measured back from the tick time', async () => {
    const seen: Date[] = [];
    const capture = (args: { olderThan: Date; limit: number }): Promise<Outcome> => {
      seen.push(args.olderThan);
      return ok(0);
    };
    const svc = new RetentionScrubSweeperService({
      repo: makeRepo({
        deleteExpiredSessionOperations: capture,
        scrubExpiredSessionMetadata: capture,
        scrubExpiredRevokedApiKeys: capture,
        scrubExpiredWebSessionIdentifiers: capture,
      }),
    });

    await svc.tickOnce(NOW);

    // The window is a published number, so it is asserted against the constant rather than
    // a literal — a change to one that does not change the other is the drift that matters.
    const expected = new Date(NOW.getTime() - RETENTION_WINDOW_DAYS * DAY_MS);
    // Every step, not a hardcoded three: a count that excludes a new member is how a
    // fourth step inherits the claim without being checked by it.
    expect(seen).toHaveLength(4);
    expect(seen.every((d) => d.getTime() === expected.getTime())).toBe(true);
  });

  it('CRITICAL one failing step does NOT strand the other two — holding data past its window on sessions is not a reason to hold it on keys', async () => {
    const { logger, errors } = makeLogger();
    const keys = vi.fn(() => ok(4));
    const ops = vi.fn(() => ok(2));
    const svc = new RetentionScrubSweeperService({
      repo: makeRepo({
        deleteExpiredSessionOperations: ops,
        scrubExpiredSessionMetadata: () => Promise.reject(new Error('deadlock detected')),
        scrubExpiredRevokedApiKeys: keys,
      }),
      logger,
    });

    const result = await svc.tickOnce(NOW);

    expect(ops).toHaveBeenCalledTimes(1);
    expect(keys).toHaveBeenCalledTimes(1);
    expect(result.operationsDeleted).toBe(2);
    expect(result.apiKeysScrubbed).toBe(4);
    // The failed step reports zero rather than a guess.
    expect(result.sessionsScrubbed).toBe(0);

    const alarm = errors.find((e) => e.event === 'retention_scrub_step_failed');
    expect(alarm, 'a failed retention step must alarm, not be swallowed').toBeDefined();
    expect(alarm?.step, 'the alarm must name WHICH step failed').toBe('sessions');
  });

  it('reports capped when ANY step hit its batch limit — a silent cap reads as "nothing left to do"', async () => {
    const svc = new RetentionScrubSweeperService({
      repo: makeRepo({ scrubExpiredRevokedApiKeys: () => ok(500, true) }),
      batchLimit: 500,
    });
    expect((await svc.tickOnce(NOW)).capped).toBe(true);

    const quiet = new RetentionScrubSweeperService({ repo: makeRepo() });
    expect((await quiet.tickOnce(NOW)).capped).toBe(false);
  });

  it('logs a retention event when it touched data, and stays SILENT when it did not', async () => {
    const quiet = makeLogger();
    await new RetentionScrubSweeperService({ repo: makeRepo(), logger: quiet.logger }).tickOnce(
      NOW,
    );
    // A daily no-op line would train an operator to skim past the line that matters.
    expect(quiet.infos).toEqual([]);

    const loud = makeLogger();
    await new RetentionScrubSweeperService({
      repo: makeRepo({ scrubExpiredSessionMetadata: () => ok(3) }),
      logger: loud.logger,
    }).tickOnce(NOW);

    const line = loud.infos.find((e) => e.event === 'retention_scrub_tick');
    expect(
      line,
      'a tick that scrubbed personal data must be attributable afterwards',
    ).toBeDefined();
    expect(line?.sessionsScrubbed).toBe(3);
    expect(line?.window_days).toBe(RETENTION_WINDOW_DAYS);
  });

  it('CRITICAL the job RE-ARMS even when the tick throws — a chain that stops re-arming stops enforcing a published window, permanently and silently', async () => {
    const enqueued: Array<Record<string, unknown>> = [];
    const scheduledJobs = {
      register: (_type: string, handler: (job: ScheduledJobRow) => Promise<void>) => {
        handlers.push(handler);
      },
      enqueue: (args: Record<string, unknown>) => {
        enqueued.push(args);
        return Promise.resolve({ enqueued: true });
      },
    } as unknown as ScheduledJobsService;
    const handlers: Array<(job: ScheduledJobRow) => Promise<void>> = [];
    const { logger, errors } = makeLogger();

    const sweeper = {
      tickOnce: () => Promise.reject(new Error('connection terminated')),
    } as unknown as RetentionScrubSweeperService;
    registerRetentionScrubJob({
      scheduledJobs,
      sweeper,
      logger,
      nowFn: () => NOW.getTime(),
    });

    expect(handlers).toHaveLength(1);
    await handlers[0]!({ runAt: NOW } as ScheduledJobRow);

    expect(errors.find((e) => e.event === 'retention_scrub_tick_failed')).toBeDefined();
    expect(enqueued, 'the failed tick must still schedule its successor').toHaveLength(1);
    expect(enqueued[0]?.jobType).toBe(RETENTION_SCRUB_JOB_TYPE);
    expect((enqueued[0]?.runAt as Date).getTime()).toBe(
      NOW.getTime() + RETENTION_SCRUB_INTERVAL_MS,
    );
    // Successor dedup must be anchored to THIS run, or a restart can fan out duplicates.
    expect(enqueued[0]?.dedupAfterRunAt).toEqual(NOW);
  });

  it('enqueues account-less, deduped, one interval out', async () => {
    const enqueued: Array<Record<string, unknown>> = [];
    const scheduledJobs = {
      enqueue: (args: Record<string, unknown>) => {
        enqueued.push(args);
        return Promise.resolve({ enqueued: true });
      },
    } as unknown as ScheduledJobsService;

    await enqueueNextRetentionScrub({ scheduledJobs, nowFn: () => NOW.getTime() });

    expect(enqueued[0]?.accountId, 'a global sweep, not per-account').toBeNull();
    expect(enqueued[0]?.dedupOnAccountAndType).toBe(true);
    // No currentRunAt on the bootstrap enqueue, so no future-successor anchor.
    expect(enqueued[0]).not.toHaveProperty('dedupAfterRunAt');
  });

  // ⛔ This arm exists because adding the web-session step passed the whole file WITHOUT
  // executing it. `makeRepo` takes a Partial and casts to the full interface, so a fake
  // missing a method type-checks; the sweeper's per-step isolation then catches the
  // resulting "not a function" and reports 0. A new step can therefore be dead in the unit
  // suite and green — which is the failure this arm is written against, not the counting.
  it('CRITICAL the web-session step actually RUNS and its count reaches the result. A step whose fake is missing throws, the per-step isolation swallows it, and the tick still reports success — so counting is the only way to tell a step that ran from one that never existed.', async () => {
    const seen: Array<{ olderThan: Date; limit: number }> = [];
    const svc = new RetentionScrubSweeperService({
      repo: makeRepo({
        scrubExpiredWebSessionIdentifiers: (args) => {
          seen.push(args);
          return ok(7);
        },
      }),
    });

    const result = await svc.tickOnce(NOW);

    expect(seen, 'the web-session scrub was invoked exactly once').toHaveLength(1);
    expect(result.webSessionsScrubbed, 'its affected count reaches the tick result').toBe(7);
    // The window is the published constant, asserted the same way the other steps are.
    expect(seen[0]?.olderThan.getTime()).toBe(NOW.getTime() - RETENTION_WINDOW_DAYS * DAY_MS);
  });

  it('a capped web-session batch marks the whole tick capped, so the next tick knows to come back', async () => {
    const svc = new RetentionScrubSweeperService({
      repo: makeRepo({ scrubExpiredWebSessionIdentifiers: () => ok(500, true) }),
    });
    expect((await svc.tickOnce(NOW)).capped).toBe(true);
  });

  // ⛔⛔ The guard that would have caught the real defect. `makeRepo` takes a Partial and
  // casts to the full interface, so a fake missing a method type-checks — and the sweeper's
  // per-step isolation converts the resulting "not a function" into a logged error and a 0.
  // Every other test in this file therefore runs a sweeper with a silently dead step and
  // still passes. This arm fails the moment a step exists that the default fake does not
  // implement, which is the growing-family problem the Partial cast creates.
  it('CRITICAL a default fake implements EVERY step — a tick over the bare fake logs no errors. Without this, adding a step to the sweeper leaves it dead in this suite and green: the missing method throws, per-step isolation swallows it, and the tick reports success.', async () => {
    const { logger, errors } = makeLogger();
    await new RetentionScrubSweeperService({ repo: makeRepo(), logger }).tickOnce(NOW);
    expect(
      errors.map((e) => e.step ?? e),
      'a step threw over the default fake — the fake is missing a method the sweeper calls',
    ).toEqual([]);
  });
});
