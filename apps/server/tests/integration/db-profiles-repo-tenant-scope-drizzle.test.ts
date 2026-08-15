// Tenant isolation for SINGLE-ROW profile operations, against real Postgres.
//
// The service does not re-check ownership. `ProfilesService.get` is
// `const row = await this.repo.findById(args); if (row === null) throw NotFound`,
// so the `eq(profiles.accountId, …)` predicate in the repo's WHERE clause IS the
// isolation boundary — not a second line of defence behind one.
//
// What existed before this file:
//   - `cross-account-profile-isolation.test.ts` drives HTTP routes through
//     `buildTestApp`, which wires **InMemory** repos. It proves the RULE against a
//     double that re-implements the same filtering by hand, and never executes a
//     line of the shipped SQL.
//   - `db-profiles-repo-keyset-drizzle` seeds two accounts and does exercise the
//     LIST predicates on real Postgres.
//
// Measured, not assumed: neutralising the account predicate on `findById` leaves
// every one of those green — the route-level isolation test, the keyset test, the
// restore-quota, in-use-concurrency, terminated-account-purge and
// snapshot-restore-dek tests. The list path is covered on real SQL; the
// single-row paths were not covered by anything that runs the real SQL.
//
// So a refactor that rewrote one WHERE clause could hand account A account B's
// profile — the cookies and storage of somebody else's browser session — with a
// fully green suite. These arms run the shipped Drizzle repo against Postgres.
//
// `recordSave` is included deliberately even though it returns void: a
// wrong-account call is a SILENT no-op, so the only way to catch a leak there is
// to read the row back and prove it did not move.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

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
    await client`SELECT 1 FROM profiles LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleProfilesRepo single-row tenant scoping (real Postgres)',
  () => {
    it('CRITICAL a profile is unreachable, unmodifiable and untouchable from another account — the repo WHERE clause is the isolation boundary, since the service throws NotFound purely on a null row and never re-checks ownership itself', async () => {
      if (!dbReachable || !client) {
        // Same contract as the sibling real-PG tests: quiet skip locally, hard
        // failure in CI. A vacuous pass on a tenant-isolation test is worse than
        // no test — it reports the boundary as proven when nothing ran.
        if (process.env.CI) {
          throw new Error(
            'real-PG tenant-scope test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);
      await client`INSERT INTO accounts (id, email) VALUES (${owner}, ${`tenant-owner-${owner}@test.local`})`;
      await client`INSERT INTO accounts (id, email) VALUES (${stranger}, ${`tenant-stranger-${stranger}@test.local`})`;
      const [created] = await client`
        INSERT INTO profiles (account_id, name) VALUES (${owner}, ${`tenant-scope-${owner}`})
        RETURNING id`;
      const profileId = created?.id as string;
      expect(profileId).toBeTruthy();

      // Positive control first: the owner CAN read it. Without this the arms
      // below could pass because the fixture was never visible to anyone.
      const mine = await repo.findById({ id: profileId, accountId: owner });
      expect(mine?.id).toBe(profileId);

      // READ — the IDOR case. A row that exists, asked for by the wrong account.
      const theirs = await repo.findById({ id: profileId, accountId: stranger });
      expect(theirs, "another account's profile must not be readable by id").toBeNull();

      // WRITE — update matches no row for a stranger, and the repo turns "no row
      // returned" into a throw rather than silently reporting success.
      await expect(
        repo.update({ id: profileId, accountId: stranger, updates: { note: 'stolen' } }),
      ).rejects.toThrow(/no row returned/);

      // The write must not have landed anyway. Asserted by reading the row back
      // as the OWNER: a test that only checked the rejection would still pass if
      // the UPDATE had touched the row before failing to return it.
      const afterUpdate = await repo.findById({ id: profileId, accountId: owner });
      expect(afterUpdate?.note ?? null).toBeNull();

      // SILENT PATH — recordSave returns void, so a wrong-account call cannot be
      // caught by its return value. Read the column back directly.
      await repo.recordSave({
        id: profileId,
        accountId: stranger,
        at: new Date(),
        sizeBytes: 4242,
      });
      const [row] = await client`
        SELECT last_saved_at, size_bytes FROM profiles WHERE id = ${profileId}`;
      expect(row?.last_saved_at ?? null, 'a stranger must not stamp a save').toBeNull();
      expect(row?.size_bytes ?? null).toBeNull();

      // And the owner CAN, so the arm above is a boundary and not a broken call.
      await repo.recordSave({ id: profileId, accountId: owner, at: new Date(), sizeBytes: 4242 });
      const [mineAfter] = await client`
        SELECT last_saved_at, size_bytes FROM profiles WHERE id = ${profileId}`;
      expect(mineAfter?.last_saved_at ?? null).not.toBeNull();
      expect(Number(mineAfter?.size_bytes)).toBe(4242);
    });
  },
);
