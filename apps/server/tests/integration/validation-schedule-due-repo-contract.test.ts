// V-1234 — one contract for validation-schedule due selection, against BOTH implementations of
// `ValidationSchedulesRepo`.
//
// The twenty-fourth of the twenty-nine. These schedules drive the recurring archetype-validation
// runs, and two properties decide whether the scheduler behaves or misbehaves forever.
//
//   Drizzle  WHERE enabled = true AND next_run_at <= $now  ORDER BY next_run_at ASC  LIMIT $n
//            markRun: SET next_run_at = $now + cadence_seconds
//
//   double   filter(r => r.enabled && r.nextRunAt <= now).sort(by nextRunAt).slice(0, limit)
//            markRun: nextRunAt = now + cadenceSeconds * 1000
//
// DISABLED IS A SAFETY SWITCH, not a filter on a list. An operator turning a schedule off is saying
// "stop running this", usually because it is producing bad results — so a `findDue` that ignored the
// flag would keep executing precisely the validation someone disabled, and the row would look
// correctly disabled the whole time.
//
// `markRun` ADVANCING IS WHAT ENDS THE TICK. It is not a claim and returns void, but if it failed to
// move `next_run_at` forward the schedule would satisfy `next_run_at <= now` on the very next sweep
// and every sweep after that — a schedule that fires forever, at whatever interval the sweeper runs
// at rather than its own cadence. The arm asserts the schedule stops being due at the same instant,
// which is the observable consequence.
//
// The boundary is `<=`, inclusive: a schedule due exactly now IS due. `upsert` derives `next_run_at`
// from the cadence and RETURNS the row, so the test reads the stamp back and queries at exactly that
// instant — the technique from V-1231, and the reason this is testable through the shared interface.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { ValidationSchedulesRepo } from '../../src/services/validation-harness.js';
import { DrizzleValidationSchedulesRepo } from '../../src/db/validation-schedules-repo.js';
import { InMemoryValidationSchedulesRepo } from './_helpers/in-memory-validation-schedules-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const CADENCE = 60;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM validation_schedules LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const a of seeded) {
      await client`DELETE FROM validation_schedules WHERE archetype_id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: ValidationSchedulesRepo;
  archetype: () => string;
  /** `findDue` is queue-wide and takes no filter, so every arm scopes to its own archetypes. */
  mine: (rows: { archetypeId: string }[], ids: string[]) => string[];
}

function makeScope(track: boolean): Pick<Subject, 'archetype' | 'mine'> {
  return {
    archetype: () => {
      const id = `contract-${randomUUID().slice(0, 12)}`;
      if (track) seeded.push(id);
      return id;
    },
    mine: (rows, ids) => rows.filter((r) => ids.includes(r.archetypeId)).map((r) => r.archetypeId),
  };
}

function inMemorySubject(): Subject {
  return { repo: new InMemoryValidationSchedulesRepo(), ...makeScope(false) };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleValidationSchedulesRepo({ client: c, db, close: async () => {} }),
    ...makeScope(true),
  };
}

async function schedule(s: Subject, archetypeId: string, enabled: boolean, cadence = CADENCE) {
  return s.repo.upsert({ archetypeId, cadenceSeconds: cadence, enabled });
}

function scheduleDueContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`ValidationSchedulesRepo due contract — ${label}`, () => {
    it('CRITICAL a DISABLED schedule is never due, even once its next_run_at has passed, in both. Disabling is a safety switch — an operator saying "stop running this", usually because it is producing bad results — so a due-query ignoring the flag keeps executing exactly the validation someone turned off, while the row reads as correctly disabled the whole time.', async () => {
      if (!enabled()) return;
      const s = make();
      const id = s.archetype();
      const row = await schedule(s, id, false);
      const wellPast = new Date(row.nextRunAt.getTime() + 60_000);

      const due = await s.repo.findDue(wellPast, 100);
      expect(s.mine(due, [id]), 'a disabled schedule was selected to run').toEqual([]);
    });

    it('CRITICAL an ENABLED schedule at the same instant IS due, in both. Without this the arm above is satisfied by a due-query that returns nothing at all, which is a scheduler that never runs anything.', async () => {
      if (!enabled()) return;
      const s = make();
      const id = s.archetype();
      const row = await schedule(s, id, true);
      const wellPast = new Date(row.nextRunAt.getTime() + 60_000);

      const due = await s.repo.findDue(wellPast, 100);
      expect(s.mine(due, [id]), 'an enabled, overdue schedule was not selected').toEqual([id]);
    });

    it('CRITICAL the due boundary is INCLUSIVE — a schedule due exactly now is due, in both. `<` instead of `<=` defers every schedule by one sweep interval, which is invisible except as everything running slightly late forever.', async () => {
      if (!enabled()) return;
      const s = make();
      const id = s.archetype();
      const row = await schedule(s, id, true);

      const due = await s.repo.findDue(row.nextRunAt, 100);
      expect(s.mine(due, [id]), 'a schedule due exactly at `now` was not selected').toEqual([id]);
    });

    it('CRITICAL a schedule whose next_run_at is still ahead is NOT due, in both. Otherwise the cadence means nothing and every schedule runs on every sweep.', async () => {
      if (!enabled()) return;
      const s = make();
      const id = s.archetype();
      const row = await schedule(s, id, true);
      const justBefore = new Date(row.nextRunAt.getTime() - 1);

      const due = await s.repo.findDue(justBefore, 100);
      expect(s.mine(due, [id]), 'a schedule ran before it was due').toEqual([]);
    });

    it('CRITICAL markRun ADVANCES next_run_at so the schedule stops being due, in both. It returns void and is not a claim, but a markRun that failed to move the timestamp would leave the schedule satisfying next_run_at <= now on the very next sweep and every sweep after — firing forever at the sweeper interval instead of its own cadence.', async () => {
      if (!enabled()) return;
      const s = make();
      const id = s.archetype();
      const row = await schedule(s, id, true);
      const at = new Date(row.nextRunAt.getTime() + 1_000);
      expect(s.mine(await s.repo.findDue(at, 100), [id]), 'it was not due before the run').toEqual([
        id,
      ]);

      await s.repo.markRun(id, randomUUID(), at);

      expect(
        s.mine(await s.repo.findDue(at, 100), [id]),
        'the schedule is still due at the same instant — markRun did not advance next_run_at',
      ).toEqual([]);
    });
  });
}

scheduleDueContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'ValidationSchedulesRepo due contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    scheduleDueContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
