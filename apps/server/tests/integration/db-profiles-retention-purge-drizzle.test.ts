// The retention purge's age bound, against real Postgres in an isolated database.
//
// `purgeTrashedBefore(cutoff)` is the only HARD delete in this repo and the only
// one with no account scope at all — by design, it is the retention sweep. Its
// entire safety is two predicates:
//
//   .where(and(isNotNull(profiles.deletedAt), lt(profiles.deletedAt, cutoff)))
//
// Lose the second one and every trashed profile for every customer is destroyed
// the next time the sweeper runs, regardless of age. There is no recycle bin left
// to restore from and no soft-delete to reverse — this is the one path in the repo
// where a wrong WHERE clause is unrecoverable.
//
// Why it had no real-SQL coverage, and why that was RIGHT: four unit tests name
// this method, all against an in-memory repo that re-implements the filter by
// hand. `global-scope-db-tests-are-isolated` deliberately forbids calling a global
// operation from a real-Postgres test on the SHARED database, because a
// whole-table delete depends on rows owned by whatever else is running. So the
// absence was a policy, not an oversight.
//
// `ensureIsolatedDatabase` is that policy's sanctioned escape hatch — the whole
// reason it exists — and the meta-guard skips any file that uses it. This file
// gets its own database, so the sweep sees only rows this test created and the
// property holds by construction.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import type * as schema from '../../src/db/schema.js';

// One distinct name per sweeping file, per the helper's contract.
const ISOLATED_DB_NAME = 'driftstack_iso_profile_retention';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let DB_URL = '';
let client: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  if (!RUN_DB_TESTS) return;
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM profiles LIMIT 0`;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB_TESTS)('profile retention purge (isolated real Postgres)', () => {
  it('CRITICAL hard-deletes ONLY trash older than the cutoff — a live profile and freshly-trashed one both survive. Without the age bound every customer loses their recycle bin on the next sweep, and there is nothing left to restore from.', async () => {
    if (!client) {
      // Quiet skip locally, hard failure in CI: a vacuous pass here would report
      // an unrecoverable delete path as proven when nothing ran.
      if (process.env.CI) {
        throw new Error(
          'real-PG retention-purge test: isolated database unreachable/unmigrated in CI — vacuous pass is forbidden',
        );
      }
      return;
    }
    const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
    const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

    const accountId = randomUUID();
    await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`retention-${accountId}@test.local`})`;

    const cutoff = new Date('2026-06-01T00:00:00.000Z');
    const [live] = await client`
      INSERT INTO profiles (account_id, name) VALUES (${accountId}, 'retention-live')
      RETURNING id`;
    const [staleTrash] = await client`
      INSERT INTO profiles (account_id, name, deleted_at)
      VALUES (${accountId}, 'retention-stale', ${'2026-05-30T00:00:00.000Z'})
      RETURNING id`;
    const [freshTrash] = await client`
      INSERT INTO profiles (account_id, name, deleted_at)
      VALUES (${accountId}, 'retention-fresh', ${'2026-06-02T00:00:00.000Z'})
      RETURNING id`;

    const purged = await repo.purgeTrashedBefore(cutoff);

    // Exact, not a superset. A purge that returned the stale id AND something
    // else would still satisfy a `toContain`, and "something else" is the whole
    // failure mode.
    expect(purged).toEqual([staleTrash?.id as string]);

    const survivors = await client<Array<{ id: string }>>`
      SELECT id FROM profiles WHERE account_id = ${accountId} ORDER BY name`;
    const ids = survivors.map((r) => r.id);
    expect(ids, 'a LIVE profile must never be touched by the retention sweep').toContain(
      live?.id as string,
    );
    expect(ids, 'trash newer than the cutoff must survive — this is the recycle bin').toContain(
      freshTrash?.id as string,
    );
    expect(ids, 'trash older than the cutoff is gone').not.toContain(staleTrash?.id as string);
    expect(ids).toHaveLength(2);
  });
});
