// V-996 — the last two account-scoped DELETEs on the cold list, and the one with a
// blast radius wider than a single row.
//
// Seventh and eighth of the tenant-scope sweep, from V-993's list of 19 account-scoped
// `src/db` functions no integration test executes.
//
//   `DrizzleProfilesRepo.purgeTrashed({ id, accountId })`
//       where and(eq(id), eq(accountId), isNotNull(deletedAt))   — one row, by id
//
//   `DrizzleRateLimitOverridesRepo.clear(accountId, bucketKey)`
//       where and(eq(accountId), eq(bucketKey))                  — NOT keyed by id
//
// The second is the one that matters most on this list. `clear` identifies its row by
// (account, bucket) rather than by id, so the account predicate is not protecting one
// customer's row from another — it is the only thing bounding the statement at all.
// Without it, clearing ONE account's override deletes **every** account's override for
// that bucket, silently returning true, and every affected customer reverts to their
// tier default. That is the shape V-994 found in MFA: a mass delete wearing a
// single-tenant signature.
//
// V-998 — the actor is STAFF, not a customer. `services/rate-limit-overrides.ts:119` has
// exactly one route caller, `routes/admin-accounts.ts:396`, so this is an operator
// clearing a named account's override. The blast radius is unchanged and the predicate
// is still the only bound; what is wrong in an earlier draft of this header is who
// pulls the trigger. A staff action that quietly reconfigures every OTHER account is
// arguably worse to discover late, because nobody is looking at the accounts it hit.
//
// What existed before this file:
//   • `purgeTrashed` appears in the test corpus only as a FAKE
//     (`purgeTrashed: () => Promise.resolve(false)` in the profiles and
//     profile-snapshots service tests). Nothing drives the shipped SQL.
//   • `rate_limit_overrides` has two real-Postgres files — `…-upsert-drizzle` and
//     `…-repo-keyset-drizzle` — and neither calls `.clear(`.
//
// The `isNotNull(deletedAt)` half of purgeTrashed is pinned here too: it is what keeps
// a purge from reaching a LIVE profile, and it sits in the same WHERE.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import { DrizzleRateLimitOverridesRepo } from '../../src/db/rate-limit-overrides-repo.js';
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
    await client`SELECT 1 FROM rate_limit_overrides LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM rate_limit_overrides WHERE account_id = ${accountId}`.catch(
        () => {},
      );
      await client`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
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
  'account-scoped purge and clear predicates (real Postgres)',
  () => {
    it("CRITICAL purgeTrashed will not purge another account's trashed profile by id, and will not reach a LIVE profile of the caller's own. Both predicates sit in one WHERE and neither is driven by anything today — the method appears in the corpus only as a fake returning false.", async () => {
      if (unusable('profiles purge')) return;
      const sql = client as ReturnType<typeof postgres>;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client: sql, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);
      for (const [id, who] of [
        [owner, 'owner'],
        [stranger, 'stranger'],
      ] as const) {
        await sql`INSERT INTO accounts (id, email) VALUES (${id}, ${`purge-${who}-${id}@test.local`})`;
      }
      const [ownerTrashed] = await sql`
        INSERT INTO profiles (account_id, name, deleted_at) VALUES (${owner}, 'owner trashed', now()) RETURNING id`;
      const [ownerLive] = await sql`
        INSERT INTO profiles (account_id, name) VALUES (${owner}, 'owner live') RETURNING id`;
      const [strangerTrashed] = await sql`
        INSERT INTO profiles (account_id, name, deleted_at) VALUES (${stranger}, 'stranger trashed', now()) RETURNING id`;

      // The tenant boundary.
      expect(
        await repo.purgeTrashed({ accountId: owner, id: strangerTrashed?.id as string }),
        "purging another account's trashed profile must report nothing purged",
      ).toBe(false);
      const [strangerSurvives] =
        await sql`SELECT count(*)::int AS n FROM profiles WHERE id = ${strangerTrashed?.id as string}`;
      expect(strangerSurvives?.n, "the stranger's trashed profile must still exist").toBe(1);

      // The trashed-only boundary, same WHERE clause.
      expect(
        await repo.purgeTrashed({ accountId: owner, id: ownerLive?.id as string }),
        'purge must not reach a live profile',
      ).toBe(false);
      const [liveSurvives] =
        await sql`SELECT count(*)::int AS n FROM profiles WHERE id = ${ownerLive?.id as string}`;
      expect(liveSurvives?.n, 'the live profile must still exist').toBe(1);

      // Positive control: the call works on the row it is for.
      expect(
        await repo.purgeTrashed({ accountId: owner, id: ownerTrashed?.id as string }),
        'the owner purges their own trashed profile',
      ).toBe(true);
      const [gone] =
        await sql`SELECT count(*)::int AS n FROM profiles WHERE id = ${ownerTrashed?.id as string}`;
      expect(gone?.n, "the owner's trashed profile is gone").toBe(0);
    });

    it('CRITICAL clear removes only the asking account\'s override for that bucket. This one is not keyed by id: without the account predicate the statement is "delete every override for this bucket", so an operator clearing ONE account\'s limit would silently revert every other account on that bucket to its tier default and still return true.', async () => {
      if (unusable('rate-limit overrides')) return;
      const sql = client as ReturnType<typeof postgres>;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRateLimitOverridesRepo({ client: sql, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      const keyOwner = randomUUID();
      const keyStranger = randomUUID();
      seeded.push(owner, stranger);
      const BUCKET = 'sessions:create';
      for (const [acct, keyId, who] of [
        [owner, keyOwner, 'owner'],
        [stranger, keyStranger, 'stranger'],
      ] as const) {
        await sql`INSERT INTO accounts (id, email) VALUES (${acct}, ${`rlo-${who}-${acct}@test.local`})`;
        await sql`INSERT INTO api_keys (id, account_id, key_prefix, key_hash, name)
                  VALUES (${keyId}, ${acct}, ${`ds_${who.slice(0, 4)}${acct.slice(0, 6)}`}, 'hash', ${`${who} key`})`;
        await sql`
          INSERT INTO rate_limit_overrides
            (account_id, bucket_key, capacity, refill_per_second_centi, expires_at, set_by_key_id)
          VALUES (${acct}, ${BUCKET}, 100, 100, now() + interval '1 day', ${keyId})`;
      }

      const countFor = async (acct: string): Promise<number> => {
        const [r] =
          await sql`SELECT count(*)::int AS n FROM rate_limit_overrides WHERE account_id = ${acct} AND bucket_key = ${BUCKET}`;
        return (r?.n as number) ?? 0;
      };

      expect(await countFor(owner), 'the owner override was seeded').toBe(1);
      expect(await countFor(stranger), 'the stranger override was seeded').toBe(1);

      expect(await repo.clear(owner, BUCKET), 'the owner clears their own override').toBe(true);

      expect(await countFor(owner), "the owner's override is gone").toBe(0);
      // The boundary — and the whole point of this arm.
      expect(
        await countFor(stranger),
        "another account's override on the same bucket must survive — this statement is bounded by the account predicate alone",
      ).toBe(1);
    });
  },
);
