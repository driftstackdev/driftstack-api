// V-1213 — one contract, executed against BOTH implementations of `ScheduledJobsRepo`.
//
// The seventh of the twenty-nine, and a third instance of the truncate-before-ordering class that
// V-1210 named. Here it is the worst of the three, because the list it truncates is a work queue:
//
//   DrizzleScheduledJobsRepo  SELECT id … WHERE run_at <= $now ORDER BY run_at ASC LIMIT $batchSize
//   InMemoryScheduledJobsRepo for (const r of this.rows.values()) { if (due.length >= batchSize) break; … }
//                             due.sort((a, b) => a.runAt - b.runAt)   // AFTER truncating
//
// The double sorts — its comment even says "for deterministic order" — but it sorts the batch it
// already chose. What the contract asserts is therefore the SET of jobs claimed, not the order they
// come back in: the real repo's `ORDER BY` decides which rows get locked, and its `RETURNING` hands
// them back newest-first, which is an accident of the statement rather than a promise.
//
// Under a backlog, where more jobs are due than one batch can hold, the real repo takes the OLDEST
// due jobs and the double took an arbitrary subset and ordered that. A job the Map iteration keeps
// passing over is not merely served late; nothing advances it, so it can starve while the queue
// drains around it.
//
// WHY THE ARM ENQUEUES FOUR AND CLAIMS TWO. With `batchSize >= due` every implementation returns the
// same set and the assertion cannot separate them. Four due jobs and a batch of two makes the answer
// a CHOICE, and the jobs are enqueued newest-run_at FIRST so write order and run_at order disagree —
// enqueueing them oldest-first makes Map order coincide with due order and the arm passes against an
// implementation that never orders. Fourth time this session the fixture's direction decided whether
// an ordering arm could fail at all.
//
// The dedup arms cover the NULL-account branch specifically. The double's own comment records that
// the real repo uses `isNull()` for that branch and `eq()` otherwise, and that a mock which skipped
// null dedup would mask a real bug — platform-wide recurring jobs all carry `accountId: null`, so
// that branch is the one every self-rearming sweep in this codebase relies on.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { ScheduledJobsRepo } from '../../src/services/scheduled-jobs.js';
import {
  DrizzleScheduledJobsRepo,
  SCHEDULED_JOB_STALE_LOCK_MS,
} from '../../src/db/scheduled-jobs-repo.js';
import { InMemoryScheduledJobsRepo } from './_helpers/in-memory-scheduled-jobs-repo.js';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/**
 * This file's clock. Every `runAt` and every `claimDue({ now })` in it is
 * `NOW ± delta`, so the arms' semantics depend only on the offsets.
 *
 * ✅ RESOLVED 2026-09-17 — the contention documented at length below is GONE,
 * because this file now runs against its own database (see ISOLATED_DB_NAME).
 * No other file's rows exist in what `claimDue` sees, so the date is no longer
 * load-bearing isolation and no date has to win a race. The history is kept
 * because it cost two blocked pushes and because the trap it records — moving
 * the clock to "fix" the flake makes it WORSE — is still true for anyone who
 * reaches for that lever again.
 *
 * ⛔ THE DATE ITSELF IS ISOLATION, not flavour. The drizzle subject shares ONE
 * `scheduled_jobs` table with every other file in the run, and `claimDue` takes
 * the OLDEST `batchSize` due rows — so at a present-day `NOW` this file's jobs
 * queue up BEHIND another file's and can be crowded out of a `batchSize: 10`
 * claim entirely. The arm then fails with "the first worker claimed nothing",
 * about a repo that behaved perfectly.
 *
 * MEASURED 2026-09-15 06:24, in a full-suite run, and the same file passed in
 * isolation seconds later — the signature of contention, not of a defect. A
 * reproduction is scriptable: seed thirty rows due at this `NOW` and the arms
 * fail; they pass with the clock below.
 *
 * ⚠️ Fixed by ORDERING rather than by raising `batchSize`, which only moves the
 * threshold and claims more of other files' rows on the way.
 *
 * ⛔⛔ STILL FLAKY, AND THE REMAINING MECHANISM IS KNOWN — read this before
 * "fixing" the clock again, because the obvious fix is a trap that was tried and
 * measured on 2026-09-17.
 *
 * The 1990 date buys READ isolation and nothing else. This file's own
 * `claimDue({ now: NOW })` selects `run_at <= 1990`, which no other suite's rows
 * satisfy, so its claims see only its own jobs. But the WRITE side is wide open:
 * `tests/integration/db-scheduled-jobs-repo-drizzle.test.ts` shares this table and
 * claims with a PRESENT-DAY clock (`batchSize: 50` at its :204, `16` at :166). A
 * 1990 row is due at any present-day `now` AND sorts first, so that file claims
 * these jobs and stamps its own `locked_by` on them. This file's next claim then
 * finds none of its own and fails — on 2026-09-17 as "the null-account duplicate
 * was enqueued anyway", about a repo that deduped perfectly. Both files had
 * independently reasoned their way to "be the oldest"; each is the other's crowd,
 * and the older one always loses.
 *
 * ⛔ MOVING THE CLOCK TO THE FUTURE DOES NOT FIX IT — measured, not assumed. At
 * 2190 no present-day claimer can take these rows (`run_at <= now` excludes
 * them), but this file's own claim at `now: NOW` then sees the WHOLE table, its
 * rows sort LAST under `ORDER BY run_at ASC`, and `LIMIT batchSize` crowds them
 * out — which is the exact failure the 1990 date was introduced to fix. The two
 * properties are in direct conflict on a shared, unfiltered queue: oldest is
 * claimable by everyone, newest is crowded out by everyone, and raising
 * `batchSize` only makes THIS file the antisocial one by locking other files'
 * rows. There is no date that is both.
 *
 * ⚠️ The real fix is isolation, not arithmetic: give this file its own table or
 * schema, or merge it with the sibling file above so the two can never interleave.
 * Until then this arm can fail under full-suite contention while passing in
 * isolation — that signature means contention, NOT a repo defect, and the repo
 * should not be changed on the strength of it.
 *
 * ⚠️ Safe because the repo NEVER mixes in the wall clock: `claimDue` writes
 * `locked_at = ${now}` from the value passed here, and the stale-lock arms
 * compare against `NOW + SCHEDULED_JOB_STALE_LOCK_MS`. Shifting the clock moves
 * every side of every comparison together. A repo that stamped `now()` in SQL
 * would make this change wrong, so check that before moving it again.
 */
const NOW = new Date('1990-01-01T12:00:00.000Z');
const MIN = 60 * 1000;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seededTypes: string[] = [];

/** ⛔ THIS FILE GETS ITS OWN DATABASE. `claimDue` is a GLOBAL SWEEP: it takes the
 *  oldest `batchSize` due rows with NO job-type filter, so on a shared database
 *  its answer depends on rows belonging to whichever other file happens to be
 *  running — exactly the class `_helpers/isolated-database.ts` was written for.
 *  `driftstack_iso_scheduled_jobs_contract` is this file's alone. */
const ISOLATED_DB_NAME = 'driftstack_iso_scheduled_jobs_contract';

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return; // no reachable Postgres: the in-memory half still runs
  const probe = postgres(isolated, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM scheduled_jobs LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(isolated, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const t of seededTypes) {
      await client`DELETE FROM scheduled_jobs WHERE job_type = ${t}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: ScheduledJobsRepo;
  /** Unique per arm — `scheduled_jobs` is global, and claimDue takes no filter at all. */
  jobType: string;
  /** claimDue is queue-wide, so every assertion scopes to the rows this arm enqueued. */
  mine: (rows: { jobType: string; id: string }[]) => string[];
}

function makeScope(): Pick<Subject, 'jobType' | 'mine'> {
  const jobType = `contract.${randomUUID().slice(0, 12)}`;
  seededTypes.push(jobType);
  return { jobType, mine: (rows) => rows.filter((r) => r.jobType === jobType).map((r) => r.id) };
}

function inMemorySubject(): Subject {
  return { repo: new InMemoryScheduledJobsRepo(), ...makeScope() };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleScheduledJobsRepo({ client: c, db, close: async () => {} }),
    ...makeScope(),
  };
}

async function enqueue(s: Subject, runAt: Date, dedup = false): Promise<void> {
  await s.repo.enqueue({
    jobType: s.jobType,
    accountId: null,
    payload: {},
    runAt,
    ...(dedup ? { dedupOnAccountAndType: true } : {}),
  });
}

function scheduledJobsContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`ScheduledJobsRepo contract — ${label}`, () => {
    it('CRITICAL a lock held LONGER than the stale window is reclaimable, in both. This is crash recovery: a worker that dies mid-job leaves locked_by set forever, and without the override that job is never worked again. The window is imported rather than written as five minutes here, so widening it moves this arm with it instead of leaving a third copy behind.', async () => {
      if (!enabled()) return;
      const s = make();
      await enqueue(s, new Date(NOW.getTime() - 1 * MIN));

      const first = await s.repo.claimDue({ batchSize: 10, now: NOW, workerId: 'dead-worker' });
      expect(
        first.filter((r) => r.jobType === s.jobType).length,
        'the job was not claimable to begin with',
      ).toBe(1);

      // `dead-worker` never finishes. Past the stale window, another worker may take it.
      const past = new Date(NOW.getTime() + SCHEDULED_JOB_STALE_LOCK_MS + 1_000);
      const second = await s.repo.claimDue({ batchSize: 10, now: past, workerId: 'w2' });
      expect(
        second.filter((r) => r.jobType === s.jobType).length,
        'a lock held past the stale window was never reclaimed — a crashed worker strands the job',
      ).toBe(1);
    });

    it('CRITICAL a lock held for LESS than the stale window is NOT reclaimable, in both. Without this the arm above is satisfied by an implementation that ignores locks entirely, which is two workers running the same job at once — the failure the lock exists to prevent.', async () => {
      if (!enabled()) return;
      const s = make();
      await enqueue(s, new Date(NOW.getTime() - 1 * MIN));

      await s.repo.claimDue({ batchSize: 10, now: NOW, workerId: 'w1' });

      const within = new Date(NOW.getTime() + SCHEDULED_JOB_STALE_LOCK_MS - 1_000);
      const second = await s.repo.claimDue({ batchSize: 10, now: within, workerId: 'w2' });
      expect(
        second.filter((r) => r.jobType === s.jobType).length,
        'a job still inside its lock window was claimed by a second worker',
      ).toBe(0);
    });

    it('CRITICAL under a backlog claimDue takes the OLDEST due jobs, in both. The real repo orders by run_at before applying the batch limit; the double truncated Map iteration and sorted what was left, so a job the iteration keeps passing over is not served late — nothing advances it, and it can starve while the queue drains around it.', async () => {
      if (!enabled()) return;
      const s = make();
      // Enqueued newest-first on purpose: enqueueing oldest-first makes write order and run_at
      // order coincide, and the arm then passes against an implementation that never orders.
      await enqueue(s, new Date(NOW.getTime() - 1 * MIN));
      await enqueue(s, new Date(NOW.getTime() - 2 * MIN));
      await enqueue(s, new Date(NOW.getTime() - 3 * MIN));
      await enqueue(s, new Date(NOW.getTime() - 4 * MIN));

      const claimed = await s.repo.claimDue({ batchSize: 2, now: NOW, workerId: 'w1' });
      const mine = claimed.filter((r) => r.jobType === s.jobType);

      expect(mine.length, 'the batch limit was not honoured for this job type').toBe(2);
      // The SET, not the array order. `ORDER BY run_at ASC LIMIT n` governs WHICH rows are locked;
      // the outer `UPDATE … RETURNING` makes no promise about the order it hands them back, and the
      // real repo does return them newest-first. Asserting the returned order would pin an
      // accident of the driver rather than the property that decides which work gets done.
      expect(
        mine.map((r) => r.runAt.getTime()).sort((a, b) => a - b),
        'claimDue did not take the two oldest due jobs',
      ).toEqual([NOW.getTime() - 4 * MIN, NOW.getTime() - 3 * MIN]);
    });

    it('CRITICAL a job whose runAt is still in the future is never claimed, in both. This is the whole meaning of scheduling, and an off-by-one runs work before the moment it was deferred to.', async () => {
      if (!enabled()) return;
      const s = make();
      await enqueue(s, new Date(NOW.getTime() + 5 * MIN));

      const claimed = await s.repo.claimDue({ batchSize: 10, now: NOW, workerId: 'w1' });
      expect(s.mine(claimed), 'a future job was claimed').toEqual([]);
    });

    it('CRITICAL a claimed job is not handed to a second worker, in both. Two workers running the same job is the failure this lock exists to prevent, and the double holding a lock the real repo would too is the only reason a unit test can speak to it.', async () => {
      if (!enabled()) return;
      const s = make();
      await enqueue(s, new Date(NOW.getTime() - MIN));

      const first = await s.repo.claimDue({ batchSize: 10, now: NOW, workerId: 'w1' });
      const second = await s.repo.claimDue({ batchSize: 10, now: NOW, workerId: 'w2' });

      expect(s.mine(first).length, 'the first worker claimed nothing').toBe(1);
      expect(s.mine(second), 'a second worker claimed the same job').toEqual([]);
    });

    it('CRITICAL dedupOnAccountAndType suppresses a duplicate for a NULL account, in both. Every platform-wide recurring sweep enqueues with accountId null, so the real repo takes an isNull() branch there rather than eq(); a double that deduped only non-null accounts would let a self-rearming job pile up a queue of itself.', async () => {
      if (!enabled()) return;
      const s = make();
      await enqueue(s, new Date(NOW.getTime() - MIN), true);
      await enqueue(s, new Date(NOW.getTime() - MIN), true);

      const claimed = await s.repo.claimDue({ batchSize: 10, now: NOW, workerId: 'w1' });
      expect(s.mine(claimed).length, 'the null-account duplicate was enqueued anyway').toBe(1);
    });

    it('CRITICAL markComplete only succeeds for the worker holding the lock, in both. The worker id is what stops a straggler from marking a job done that another worker has since taken over.', async () => {
      if (!enabled()) return;
      const s = make();
      await enqueue(s, new Date(NOW.getTime() - MIN));
      const [job] = await s.repo.claimDue({ batchSize: 10, now: NOW, workerId: 'w1' });
      expect(job, 'nothing was claimed, so this arm checked nothing').toBeDefined();

      expect(
        await s.repo.markComplete(job?.id ?? '', NOW, 'w2'),
        'a worker that never held the lock completed the job',
      ).toBe(false);
      expect(
        await s.repo.markComplete(job?.id ?? '', NOW, 'w1'),
        'the lock holder could not complete its own job',
      ).toBe(true);
    });
  });
}

scheduledJobsContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'ScheduledJobsRepo contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    scheduledJobsContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
