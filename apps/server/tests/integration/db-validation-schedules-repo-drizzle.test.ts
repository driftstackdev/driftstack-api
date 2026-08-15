// Drizzle-backed integration test for DrizzleValidationSchedulesRepo.
//
// Sixth of the zero-coverage repos (item 5e), and the first one where the
// coverage hole had a guard sitting right next to it:
//
//   tests/unit/db-validation-schedules-repo-v218-cross-source-invariant.test.ts
//
// That file readFileSync's this repo and regex-matches the source. It never
// executes a line of it, which is why the coverage report reads zero even
// though the repo looks guarded. The distinction matters more than usual here,
// because the pin's own header claims a property no arm of it tests:
//
//   "upsert onConflictDoUpdate target = archetypeId; SET excludes nextRunAt
//    (preserved)."
//
// Nothing asserts the exclusion. Add `nextRunAt,` to that `set:` block and the
// pin stays green — see the mutation ledger below, where that is proved rather
// than asserted. The pin does match the explanatory COMMENT above the block, so
// the prose is frozen while the behaviour it describes is free to change. That
// is the more dangerous half of the pair: a reviewer reading the guard list sees
// the property named twice and reasonably concludes it is covered.
//
// What the preserved nextRunAt is worth: the schedule drives the validation
// harness. An operator editing a cadence or typing a reason must not push the
// next run out — if the upsert reset nextRunAt, every edit would silently defer
// validation by a full cadence, and an operator repeatedly tuning a schedule
// would keep it from ever running while watching a row that looks correct.
//
// The other property with teeth is findDue's ordering. It takes `limit` rows
// ordered by next_run_at ASC, so the MOST overdue run first. Reverse it and the
// most overdue schedule is never selected while enough others are due — not a
// delay but permanent starvation, and the row still reads enabled and due.
//
// Shared-database discipline: findDue and list are global queries with no target
// column, so every arm filters results to archetype ids unique to this run and
// asserts relative order or membership. Asserting a global count or a head-of-
// list position would pass alone and fail in a full run.
//
// MUTATION-PROVED against validation-schedules-repo.ts. Each mutation applied
// alone against a pristine snapshot; BOTH this file and the source pin were run,
// then the source restored. Controls: 13/13 here, 9/9 on the pin.
//
//                                                          here        the pin
//   upsert's set: block also resets nextRunAt              1 red        GREEN
//   findDue drops the enabled predicate                    1 red        1 red
//   findDue drops the due-time predicate                   2 red        1 red
//   findDue orders LEAST overdue first                     6 red        1 red
//   markRun never advances nextRunAt                       1 red        GREEN
//   markRun loses its missing-schedule guard               1 red        1 red
//   remove always claims success                           1 red        1 red
//   findByArchetype drops its predicate                    5 red        GREEN
//   list returns rows in storage order                     1 red        GREEN
//   a new schedule is created already due                  2 red        1 red
//
// The pin is blind to four, and they are not the harmless four:
//
//   - resetting nextRunAt on update defers validation by a cadence per edit —
//     the property the pin's own header claims ("SET excludes nextRunAt
//     (preserved)") and never asserts;
//   - markRun not advancing nextRunAt leaves the schedule due forever, so the
//     harness re-runs that archetype every tick without limit. The pin does
//     assert /nextRunAt,/ for markRun, but that substring is ALSO present in
//     upsert's insert values, so a DIFFERENT occurrence keeps it green — a
//     non-unique anchor satisfied somewhere other than where it was aimed;
//   - findByArchetype without its predicate returns whichever row sorts first,
//     so an operator edits one archetype and changes another;
//   - list unordered reshuffles the admin table on every edit.
//
// None of that is an argument against the pin, which catches the six textual
// changes it was aimed at. It is the reason a text pin is not coverage: it
// records what the source SAYS, and four of these mutations leave the source
// saying the same thing while the behaviour inverts.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleValidationSchedulesRepo } from '../../src/db/validation-schedules-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Unique per run so the global findDue/list queries can be filtered to this file. */
const RUN = randomUUID().slice(0, 8);
/** Prefix shared by every archetype id this run seeds. */
const RUN_PREFIX = `sched-${RUN}-`;
const arch = (name: string): string => `${RUN_PREFIX}${name}`;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleValidationSchedulesRepo | null = null;
const seeded: string[] = [];

/** Upsert through the repo, remembering the id for cleanup. */
async function seed(
  archetypeId: string,
  cadenceSeconds: number,
  enabled: boolean,
  reason: string | null = null,
): Promise<void> {
  if (!repo) throw new Error('no repo');
  if (!seeded.includes(archetypeId)) seeded.push(archetypeId);
  await repo.upsert({ archetypeId, cadenceSeconds, enabled, reason });
}

/**
 * Force next_run_at directly.
 *
 * The repo deliberately computes next_run_at from `new Date()` and never accepts
 * one, so a due/overdue row cannot be produced through the public surface — the
 * soonest any upsert can schedule is one cadence into the future. Writing the
 * column is the only way to exercise findDue at all.
 */
async function setNextRunAt(archetypeId: string, at: Date): Promise<void> {
  if (!client) throw new Error('no client');
  // `.toISOString()}::timestamptz` rather than the bare Date: postgres.js cannot
  // infer the parameter type here and throws on the raw object. Every sibling
  // db-* test writes timestamps this way.
  await client`
    UPDATE validation_schedules SET next_run_at = ${at.toISOString()}::timestamptz
    WHERE archetype_id = ${archetypeId}`;
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM validation_schedules LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleValidationSchedulesRepo({
    client,
    db: drizzle(client, { schema }),
    close: async () => {},
  });
});

afterAll(async () => {
  if (client) {
    for (const a of seeded) {
      await client`DELETE FROM validation_schedules WHERE archetype_id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleValidationSchedulesRepo (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and the table present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL a new schedule is created with next_run_at one cadence into the future. This is the insert path of the upsert, and a schedule created already-due would run the instant it was registered rather than after its first interval.', async () => {
      if (!dbReachable || !repo) return;
      const a = arch('insert');
      const before = Date.now();
      await seed(a, 3600, true, 'first');
      const after = Date.now();

      const row = await repo.findByArchetype(a);
      expect(row, 'the schedule exists').not.toBeNull();
      expect(row?.cadenceSeconds, 'cadence stored').toBe(3600);
      expect(row?.enabled, 'enabled stored').toBe(true);
      expect(row?.reason, 'reason stored').toBe('first');
      expect(row?.lastRunAt, 'never run yet').toBeNull();
      expect(row?.lastRunId, 'and no run id').toBeNull();

      const next = row?.nextRunAt.getTime() ?? 0;
      expect(next, 'next run is at least one cadence out').toBeGreaterThanOrEqual(
        before + 3600 * 1000,
      );
      expect(next, 'and not more than one cadence plus the call itself').toBeLessThanOrEqual(
        after + 3600 * 1000,
      );
    });

    it('CRITICAL re-upserting an existing schedule PRESERVES next_run_at while updating everything else. This is the property the neighbouring source pin names in its header and never tests: its `set:` block omits nextRunAt on purpose, and the pin matches only the comment saying so. If an edit reset the timer, an operator tuning a cadence or typing a reason would defer the next validation run by a full cadence each time — and one who kept adjusting would keep it from ever running, while the row on screen looks perfectly correct.', async () => {
      if (!dbReachable || !repo) return;
      const a = arch('preserve');
      await seed(a, 7200, true, 'original');
      const first = await repo.findByArchetype(a);
      const pinned = first?.nextRunAt.getTime() ?? 0;
      expect(pinned, 'a next run was scheduled').toBeGreaterThan(0);

      // A different cadence, so a reset would land somewhere clearly different
      // rather than coincidentally near the original.
      await repo.upsert({ archetypeId: a, cadenceSeconds: 60, enabled: false, reason: 'edited' });

      const second = await repo.findByArchetype(a);
      expect(second?.id, 'the same row, not a second one').toBe(first?.id);
      expect(second?.cadenceSeconds, 'cadence updated').toBe(60);
      expect(second?.enabled, 'enabled updated').toBe(false);
      expect(second?.reason, 'reason updated').toBe('edited');
      expect(second?.nextRunAt.getTime(), 'but the pending run is NOT rescheduled').toBe(pinned);
    });

    it('CRITICAL a disabled schedule is never due, however overdue its timestamp. Disabling is how an operator stops a misbehaving archetype; a findDue that ignored the flag would keep running exactly the schedule someone deliberately switched off, and the row would still read disabled while it ran.', async () => {
      if (!dbReachable || !repo) return;
      const off = arch('disabled');
      await seed(off, 60, false);
      await setNextRunAt(off, new Date(Date.now() - 60 * 60 * 1000));

      const due = await repo.findDue(new Date(), 500);
      expect(
        due.some((r) => r.archetypeId === off),
        'the disabled schedule stayed out of the due set',
      ).toBe(false);
    });

    it('CRITICAL a schedule whose next run is still in the future is not due. Without the timestamp predicate every enabled schedule would be selected on every tick, so the harness would re-run each archetype continuously instead of at its cadence.', async () => {
      if (!dbReachable || !repo) return;
      const later = arch('future');
      await seed(later, 86_400, true);

      const due = await repo.findDue(new Date(), 500);
      expect(
        due.some((r) => r.archetypeId === later),
        'a schedule an hour out is not due now',
      ).toBe(false);
    });

    it('CRITICAL an enabled, overdue schedule IS due. The two arms above prove exclusion; without this one they would both pass against a findDue that returned nothing at all.', async () => {
      if (!dbReachable || !repo) return;
      const ready = arch('ready');
      await seed(ready, 60, true);
      await setNextRunAt(ready, new Date(Date.now() - 5 * 60 * 1000));

      const due = await repo.findDue(new Date(), 500);
      expect(
        due.some((r) => r.archetypeId === ready),
        'the overdue enabled schedule was selected',
      ).toBe(true);
    });

    it('CRITICAL the due set is ordered MOST overdue first. findDue takes only `limit` rows, so the ordering decides who gets dropped when more schedules are due than the harness can run. Ascending by next_run_at means the longest-waiting goes first; reversed, the most overdue schedule is never picked while enough others stay due — permanent starvation rather than delay, on a row that reads enabled and due the whole time.', async () => {
      if (!dbReachable || !repo) return;
      const older = arch('overdue-older');
      const newer = arch('overdue-newer');
      // Seeded newest-first so insertion order disagrees with the expected order
      // and an unordered query cannot pass by accident.
      await seed(newer, 60, true);
      await seed(older, 60, true);
      await setNextRunAt(newer, new Date(Date.now() - 10 * 60 * 1000));
      await setNextRunAt(older, new Date(Date.now() - 90 * 60 * 1000));

      const due = await repo.findDue(new Date(), 500);
      const iOlder = due.findIndex((r) => r.archetypeId === older);
      const iNewer = due.findIndex((r) => r.archetypeId === newer);
      expect(iOlder, 'the longest-waiting schedule is in the due set').toBeGreaterThanOrEqual(0);
      expect(iNewer, 'and so is the other').toBeGreaterThanOrEqual(0);
      // Relative position only — other rows in a shared database may sort between.
      expect(iOlder, 'longest-waiting is selected before the more recent one').toBeLessThan(iNewer);
    });

    it('CRITICAL findDue honours its limit. The harness sizes this to what it can run in one tick, and a limit that leaked would start every due archetype at once.', async () => {
      if (!dbReachable || !repo) return;
      const a = arch('limit-a');
      const b = arch('limit-b');
      await seed(a, 60, true);
      await seed(b, 60, true);
      await setNextRunAt(a, new Date(Date.now() - 30 * 60 * 1000));
      await setNextRunAt(b, new Date(Date.now() - 20 * 60 * 1000));

      expect((await repo.findDue(new Date(), 1)).length, 'at most one row').toBeLessThanOrEqual(1);
      expect((await repo.findDue(new Date(), 2)).length, 'at most two rows').toBeLessThanOrEqual(2);
    });

    it('CRITICAL markRun advances next_run_at by the CURRENT cadence and stamps the run. The schedule is re-read for its cadence rather than trusting a caller, so a cadence edited since the run was picked up takes effect immediately. If next_run_at did not advance the schedule would stay due forever — the harness would re-run that archetype every tick, without limit.', async () => {
      if (!dbReachable || !repo) return;
      const a = arch('markrun');
      await seed(a, 60, true);
      await setNextRunAt(a, new Date(Date.now() - 60 * 60 * 1000));
      expect(
        (await repo.findDue(new Date(), 500)).some((r) => r.archetypeId === a),
        'due before the run',
      ).toBe(true);

      const runId = `run-${RUN}`;
      const at = new Date();
      await repo.markRun(a, runId, at);

      const row = await repo.findByArchetype(a);
      expect(row?.lastRunId, 'the run id is recorded').toBe(runId);
      expect(row?.lastRunAt?.getTime(), 'and when it ran').toBe(at.getTime());
      expect(row?.nextRunAt.getTime(), 'next run is one cadence past this run').toBe(
        at.getTime() + 60 * 1000,
      );
      expect(
        (await repo.findDue(new Date(), 500)).some((r) => r.archetypeId === a),
        'and it is no longer due',
      ).toBe(false);
    });

    it('CRITICAL markRun on an archetype with no schedule is a silent no-op. The harness can finish a run after an operator deleted the schedule, and the guard for that returns early — without it the update would touch nothing but the read of a missing cadence would throw inside the completion path, turning a deleted schedule into an error on an otherwise successful run.', async () => {
      if (!dbReachable || !repo) return;
      const gone = arch('vanished');
      await expect(repo.markRun(gone, 'run-x', new Date())).resolves.toBeUndefined();
      expect(await repo.findByArchetype(gone), 'and nothing was created').toBeNull();
    });

    it('CRITICAL remove reports whether it actually deleted anything. The admin route turns this boolean into 200 vs 404, so a remove that always claimed success would tell an operator a schedule was deleted when no such archetype existed — and hide a typo in the id they meant to disable.', async () => {
      if (!dbReachable || !repo) return;
      const a = arch('remove');
      await seed(a, 60, true);
      expect(await repo.remove(a), 'the existing schedule was deleted').toBe(true);
      expect(await repo.findByArchetype(a), 'and is gone').toBeNull();
      expect(await repo.remove(a), 'deleting it again reports nothing removed').toBe(false);
      expect(await repo.remove(arch('never-existed')), 'as does an unknown archetype').toBe(false);
    });

    it('CRITICAL findByArchetype is scoped to its archetype. It is the read behind both markRun and the admin detail view, and a missing predicate would return whichever schedule happened to be first — so an operator would edit one archetype and change another.', async () => {
      if (!dbReachable || !repo) return;
      const mine = arch('scope-mine');
      const theirs = arch('scope-theirs');
      await seed(mine, 111, true, 'mine');
      await seed(theirs, 222, true, 'theirs');

      expect((await repo.findByArchetype(mine))?.cadenceSeconds, 'my own row').toBe(111);
      expect((await repo.findByArchetype(theirs))?.cadenceSeconds, 'and theirs').toBe(222);
    });

    it('CRITICAL list returns schedules ordered by archetype id. It backs the admin table, and rows arriving in storage order would reshuffle the list on every edit.', async () => {
      if (!dbReachable || !repo) return;
      const first = arch('zz-list-a');
      const second = arch('zz-list-b');
      // Inserted in reverse so insertion order disagrees with the sort.
      await seed(second, 60, true);
      await seed(first, 60, true);

      const ids = (await repo.list())
        .map((r) => r.archetypeId)
        .filter((id) => id.startsWith(RUN_PREFIX));
      const sorted = [...ids].sort();
      expect(ids, 'the rows this run seeded come back in archetype order').toEqual(sorted);
      expect(ids.includes(first) && ids.includes(second), 'and both are present').toBe(true);
    });
  },
);
