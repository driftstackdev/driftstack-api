// Drizzle-backed integration test for DrizzleProbesRepo.
//
// Fifth of the zero-coverage repos (item 5e). These rows are what the PUBLIC
// status page reports, so an aggregation error here is a false uptime claim —
// either an outage we do not admit to, or a failure we invent for a target that
// never failed.
//
// Two properties in `countByTargetSince` carry that risk and both are raw SQL:
//
//   count(*) filter (where ok = true|false)        the ok/fail split
//   max(probed_at) filter (where ok = false)       lastFailureAt
//
// The FILTER on lastFailureAt is the one worth executing. Drop it and the column
// collapses to max(probed_at) — identical to lastProbeAt — so a target that has
// never failed reports a failure timestamp, and the status page shows a recent
// incident for a service that was healthy throughout.
//
// The counts are equally quiet: Postgres returns count(*) as a STRING, and the
// repo casts with Number(). Without the cast, "2" > "10" lexicographically, and
// any threshold comparison downstream silently inverts.
//
// Shared-database discipline: `countByTargetSince` groups over the whole table,
// so every arm uses a target name unique to this run and filters the result to
// it. Asserting on the full grouping would pass alone and fail in a full run.
//
// MUTATION-PROVED against health-probes-repo.ts — control 8/8 green, then each
// mutation applied alone and reverted (arms red / 8):
//
//   lastFailureAt loses its `filter (where ok = false)`            2 red
//   Number() cast dropped, counts stay Postgres strings            3 red
//   `where(gte(probedAt, since))` dropped                          1 red
//   `desc(probedAt)` -> ascending                                  1 red
//   pruneOlderThan's `lt(probedAt, before)` dropped                1 red
//   recentForTarget's `eq(target)` predicate dropped               2 red
//   recordProbe forces `ok: true` on the stored row                3 red
//
// Seven of the eight arms discriminate; the eighth is the reachability guard,
// which is vacuity protection by construction and has nothing to mutate.
//
// The first attempt at the lastFailureAt mutation matched ZERO sites (shell
// interpolation ate the `${}` in the SQL template) and the second matched TWO
// (`filter (where ok = false)` is also failCount's clause). Both aborted on the
// count assertion instead of applying nothing and printing a pass — which is
// the whole reason that assertion exists.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProbesRepo } from '../../src/db/health-probes-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Unique per run so the grouped aggregation can be filtered to this file. */
const TARGET = `https://probe-${randomUUID().slice(0, 8)}.test`;

const T0 = new Date('2026-08-16T10:00:00.000Z');
const T1 = new Date('2026-08-16T10:05:00.000Z');
const T2 = new Date('2026-08-16T10:10:00.000Z');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleProbesRepo | null = null;
const usedTargets: string[] = [];

async function probe(target: string, ok: boolean, probedAt: Date): Promise<void> {
  if (!repo) throw new Error('no repo');
  if (!usedTargets.includes(target)) usedTargets.push(target);
  await repo.recordProbe({
    target,
    ok,
    latencyMs: ok ? 42 : null,
    httpStatus: ok ? 200 : 503,
    errorMessage: ok ? null : 'probe failed',
    probedAt,
  });
}

beforeAll(async () => {
  const p = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await p`SELECT 1`;
    dbReachable = true;
    await p.end({ timeout: 1 });
  } catch {
    await p.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM system_health_probes LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleProbesRepo({ client, db: drizzle(client, { schema }), close: async () => {} });
});

afterAll(async () => {
  if (client) {
    for (const t of usedTargets) {
      await client`DELETE FROM system_health_probes WHERE target = ${t}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleProbesRepo (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and the table present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL recordProbe returns the row it stored. The status page renders these fields directly, so a returned record disagreeing with what was written would show a latency or status the probe never observed.', async () => {
      if (!dbReachable || !repo) return;
      const t = `${TARGET}/record`;
      usedTargets.push(t);
      const row = await repo.recordProbe({
        target: t,
        ok: false,
        latencyMs: null,
        httpStatus: 503,
        errorMessage: 'boom',
        probedAt: T1,
      });
      expect(row.ok, 'failure recorded as failure').toBe(false);
      expect(row.httpStatus, 'status round-trips').toBe(503);
      expect(row.errorMessage, 'error round-trips').toBe('boom');
      expect(row.probedAt.getTime(), 'timestamp round-trips').toBe(T1.getTime());
    });

    it('CRITICAL recentForTarget returns newest-first, honours the limit, and is scoped to its target. The status page reads the head of this list, so reversed ordering would present the oldest probe as current state.', async () => {
      if (!dbReachable || !repo) return;
      const t = `${TARGET}/recent`;
      const other = `${TARGET}/recent-other`;
      usedTargets.push(t, other);
      await probe(t, true, T0);
      await probe(t, true, T2);
      await probe(t, false, T1);
      await probe(other, true, T2);

      const rows = await repo.recentForTarget(t, 2);
      expect(rows.length, 'limit honoured').toBe(2);
      expect(rows[0]?.probedAt.getTime(), 'newest first').toBe(T2.getTime());
      expect(rows[1]?.probedAt.getTime(), 'then the next newest').toBe(T1.getTime());
      expect(
        rows.every((r) => r.target === t),
        "another target's probes do not appear",
      ).toBe(true);
    });

    it('CRITICAL a target with NO failures reports lastFailureAt as null. The FILTER on that aggregate is the only thing separating it from max(probed_at) — without it a perfectly healthy target reports a failure timestamp equal to its last probe, and the status page shows an incident that never happened.', async () => {
      if (!dbReachable || !repo) return;
      const t = `${TARGET}/healthy`;
      usedTargets.push(t);
      await probe(t, true, T0);
      await probe(t, true, T2);

      const mine = (await repo.countByTargetSince(T0)).find((r) => r.target === t);
      expect(mine?.failCount, 'no failures counted').toBe(0);
      expect(mine?.lastFailureAt, 'and no failure timestamp invented').toBeNull();
      expect(mine?.lastProbeAt.getTime(), 'last probe is the newest').toBe(T2.getTime());
    });

    it('CRITICAL a target WITH a failure reports the failure time, not merely the last probe time. The two differ whenever a service recovered — the newest probe is a success and the newest FAILURE is older, which is exactly the state a status page must render correctly.', async () => {
      if (!dbReachable || !repo) return;
      const t = `${TARGET}/recovered`;
      usedTargets.push(t);
      await probe(t, false, T0);
      await probe(t, true, T2);

      const mine = (await repo.countByTargetSince(T0)).find((r) => r.target === t);
      expect(mine?.okCount, 'one success').toBe(1);
      expect(mine?.failCount, 'one failure').toBe(1);
      expect(mine?.lastProbeAt.getTime(), 'last probe is the recovery').toBe(T2.getTime());
      expect(mine?.lastFailureAt?.getTime(), 'last FAILURE is the earlier one').toBe(T0.getTime());
    });

    it('CRITICAL the counts are numbers, not the strings Postgres returns. count(*) comes back as text and the repo casts it; without that cast "2" > "10" lexicographically and any threshold comparison downstream silently inverts.', async () => {
      if (!dbReachable || !repo) return;
      const t = `${TARGET}/types`;
      usedTargets.push(t);
      await probe(t, true, T0);
      await probe(t, false, T1);

      const mine = (await repo.countByTargetSince(T0)).find((r) => r.target === t);
      expect(typeof mine?.okCount, 'okCount is a number').toBe('number');
      expect(typeof mine?.failCount, 'failCount is a number').toBe('number');
      expect(mine?.lastProbeAt instanceof Date, 'lastProbeAt is a Date').toBe(true);
    });

    it('CRITICAL probes older than `since` are excluded from the window. The status page reports a rolling period; counting probes from before it would dilute a current outage with historical successes.', async () => {
      if (!dbReachable || !repo) return;
      const t = `${TARGET}/window`;
      usedTargets.push(t);
      await probe(t, true, T0);
      await probe(t, false, T2);

      const mine = (await repo.countByTargetSince(T1)).find((r) => r.target === t);
      expect(mine?.okCount, 'the older success is outside the window').toBe(0);
      expect(mine?.failCount, 'only the in-window failure counts').toBe(1);
    });

    it('CRITICAL pruneOlderThan deletes only what predates the cutoff and reports how many. Retention runs on this; deleting too much loses uptime history, and reporting a count that does not match what was removed makes the sweep unauditable.', async () => {
      if (!dbReachable || !repo) return;
      const t = `${TARGET}/prune`;
      usedTargets.push(t);
      await probe(t, true, T0);
      await probe(t, true, T2);

      const before = (await repo.recentForTarget(t, 10)).length;
      expect(before, 'two probes stored').toBe(2);

      const deleted = await repo.pruneOlderThan(T1);
      expect(deleted, 'at least the one older probe was removed').toBeGreaterThanOrEqual(1);

      const after = await repo.recentForTarget(t, 10);
      expect(after.length, 'the newer probe survives').toBe(1);
      expect(after[0]?.probedAt.getTime(), 'and it is the newer one').toBe(T2.getTime());
    });
  },
);
