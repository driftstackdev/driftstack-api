// V-995 — two more account-scoped DELETEs whose predicate nothing executable held.
//
// Fifth and sixth of the tenant-scope sweep, found the same way as V-994's: both are
// on the list of 19 account-scoped `src/db` functions that no integration test
// executes (V-993 measured 81 cold of 730).
//
//   `DrizzleRecipesRepo.deleteById`        where and(eq(id), eq(accountId))
//   `DrizzleProfileSnapshotsRepo.delete`   where and(eq(id), eq(accountId))
//
// Both delete BY ID, so the account predicate is what stops a caller removing another
// customer's row by naming its id. Ids are uuid/text rather than sequential, which
// raises the cost of guessing one — it does not make the predicate optional, and the
// repo's anti-enumeration posture exists precisely because ids do leak.
//
// **What existed before this file, which is the part worth stating.** Both rules ARE
// tested — against doubles:
//
//   • `recipes-inmemory.test.ts` has "deleteById removes the owner row (true) and is a
//     no-op for cross-account / missing (false)" — on `InMemoryRecipesRepo`.
//   • `recipes-routes.test.ts` drives HTTP DELETE through `buildTestApp`, which wires
//     **InMemory** repos.
//   • No integration file constructs `DrizzleProfileSnapshotsRepo` and calls `.delete`
//     at all: the two that touch profile snapshots on real Postgres drive restore and
//     the terminated-account purge.
//
// So the rule is proven against a hand-written re-implementation of the filtering,
// and the shipped SQL never runs — the exact shape `db-profiles-repo-tenant-scope`
// names in its own header ("a double that re-implements the same filtering by hand,
// and never executes a line of the shipped SQL").
//
// Measured before writing: neutralising either account predicate leaves the whole
// recipes and profile-snapshot test surface green.
//
// V-999 CORRECTION — that sentence is right for recipes and WRONG for profile
// snapshots. Re-measured by mutation against the EXISTING suite rather than by
// grepping for pins: unscoping `deleteById` leaves 120 tests over 8 recipes files
// green, but unscoping the snapshot delete REDS
// `db-profile-snapshots-repo-content-parity`, which freezes that method's entire
// body including the WHERE. So the snapshot arm here is defence-in-depth, not a
// closed hole. It still earns its place — a regex over source is broken by any
// reformat of the expression it pins, and prettier reflows these files constantly —
// but the gap it closes is narrower than this header first claimed.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleRecipesRepo } from '../../src/db/recipes-repo.js';
import { DrizzleProfileSnapshotsRepo } from '../../src/db/profile-snapshots-repo.js';
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
    await client`SELECT 1 FROM recipes LIMIT 0`;
    await client`SELECT 1 FROM profile_snapshots LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM recipes WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM profile_snapshots WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

/** Hard-fail in CI, quiet skip locally — a vacuous pass would report a boundary as proven. */
function unusable(what: string): boolean {
  if (dbReachable && client) return false;
  if (process.env.CI) {
    throw new Error(`real-PG ${what} tenant-scope test: database unreachable/unmigrated in CI`);
  }
  return true;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'account-scoped DELETE predicates (real Postgres)',
  () => {
    it("CRITICAL DrizzleRecipesRepo.deleteById refuses to delete another account's recipe by id. The account predicate is the whole boundary — the id alone identifies the row. Today this rule is proven only against InMemoryRecipesRepo and through routes that wire in-memory repos, so the shipped SQL's predicate has never run.", async () => {
      if (unusable('recipes')) return;
      const sql = client as ReturnType<typeof postgres>;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRecipesRepo({ client: sql, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);
      for (const [id, who] of [
        [owner, 'owner'],
        [stranger, 'stranger'],
      ] as const) {
        await sql`INSERT INTO accounts (id, email) VALUES (${id}, ${`rec-${who}-${id}@test.local`})`;
      }
      const ownerRecipe = `rcp_owner_${owner.slice(0, 8)}`;
      const strangerRecipe = `rcp_stranger_${stranger.slice(0, 8)}`;
      // intent_log is jsonb NOT NULL with no default; a literal avoids the
      // JSON.stringify-into-jsonb double-encoding trap.
      await sql`INSERT INTO recipes (id, account_id, label, intent_log)
                VALUES (${ownerRecipe}, ${owner}, 'owner recipe', '[]'::jsonb)`;
      await sql`INSERT INTO recipes (id, account_id, label, intent_log)
                VALUES (${strangerRecipe}, ${stranger}, 'stranger recipe', '[]'::jsonb)`;

      // The boundary: the owner names the stranger's id.
      const stolen = await repo.deleteById({ accountId: owner, id: strangerRecipe });
      expect(stolen, "deleting another account's recipe by id must report nothing deleted").toBe(
        false,
      );
      const [survives] =
        await sql`SELECT count(*)::int AS n FROM recipes WHERE id = ${strangerRecipe}`;
      expect(survives?.n, "the stranger's recipe must still exist").toBe(1);

      // Positive control: the same call on the owner's OWN row must work, or the
      // assertion above would pass against a delete that never deletes anything.
      const own = await repo.deleteById({ accountId: owner, id: ownerRecipe });
      expect(own, 'the owner deletes their own recipe').toBe(true);
      const [gone] = await sql`SELECT count(*)::int AS n FROM recipes WHERE id = ${ownerRecipe}`;
      expect(gone?.n, "the owner's recipe is gone").toBe(0);
    });

    it("CRITICAL DrizzleProfileSnapshotsRepo.delete refuses to delete another account's snapshot by id. No integration file constructs this repo and calls delete at all — the two that touch snapshots on real Postgres drive restore and the terminated-account purge instead.", async () => {
      if (unusable('profile snapshots')) return;
      const sql = client as ReturnType<typeof postgres>;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfileSnapshotsRepo({ client: sql, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);
      for (const [id, who] of [
        [owner, 'owner'],
        [stranger, 'stranger'],
      ] as const) {
        await sql`INSERT INTO accounts (id, email) VALUES (${id}, ${`snap-${who}-${id}@test.local`})`;
      }
      const [ownerSnap] = await sql`
        INSERT INTO profile_snapshots (account_id, label, parent_archetype, parent_name)
        VALUES (${owner}, 'owner snap', 'arch', 'name') RETURNING id`;
      const [strangerSnap] = await sql`
        INSERT INTO profile_snapshots (account_id, label, parent_archetype, parent_name)
        VALUES (${stranger}, 'stranger snap', 'arch', 'name') RETURNING id`;

      const stolen = await repo.delete({ accountId: owner, id: strangerSnap?.id as string });
      expect(stolen, "deleting another account's snapshot by id must report nothing deleted").toBe(
        false,
      );
      const [survives] =
        await sql`SELECT count(*)::int AS n FROM profile_snapshots WHERE id = ${strangerSnap?.id as string}`;
      expect(survives?.n, "the stranger's snapshot must still exist").toBe(1);

      const own = await repo.delete({ accountId: owner, id: ownerSnap?.id as string });
      expect(own, 'the owner deletes their own snapshot').toBe(true);
      const [gone] =
        await sql`SELECT count(*)::int AS n FROM profile_snapshots WHERE id = ${ownerSnap?.id as string}`;
      expect(gone?.n, "the owner's snapshot is gone").toBe(0);
    });
  },
);
