// Drizzle-backed integration test for DrizzleRateLimitOverridesRepo.listAll
// keyset pagination — same-timestamp completeness against a REAL Postgres.
//
// Completes the cursor-class real-PG guard family (account-audit / admin-
// audit / sessions / api-keys). listAll is the admin override list; it
// pages on a compound (createdAt, id) keyset and (by default) excludes
// expired rows. Overrides written in a batch share a created_at, so a
// timestamp-only cursor would drop the tie-group overflow at a page
// boundary. Validates this repo's specific keyset SQL on real PG. Seeded
// rows use distinct bucket_keys (the table is unique on
// (account_id, bucket_key)) + a future expiry (so the default exclude-
// expired filter keeps them) + an accountId scope for determinism.
//
// Run scope: CI postgres:17-alpine (always); skips locally without
// DATABASE_URL.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleRateLimitOverridesRepo } from '../../src/db/rate-limit-overrides-repo.js';
import { assertStableUnderMidWalkInserts } from './_helpers/keyset-stable-under-inserts.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// (accountId, apiKeyId) — cleaned in FK order: overrides → api_keys → accounts.
const seeded: Array<{ accountId: string; apiKeyId: string }> = [];

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
    await client`SELECT 1 FROM rate_limit_overrides LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const { accountId, apiKeyId } of seeded) {
      await client`DELETE FROM rate_limit_overrides WHERE account_id = ${accountId}`.catch(
        () => {},
      );
      await client`DELETE FROM api_keys WHERE id = ${apiKeyId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleRateLimitOverridesRepo.listAll keyset (Drizzle path against real Postgres)',
  () => {
    it('pages a same-timestamp tie group larger than the page size WITHOUT dropping rows (accountId-scoped, deterministic)', async () => {
      if (!dbReachable || !client) {
        // Local dev without DATABASE_URL: skip quietly. In CI the DB
        // service + migrate step are part of the job — an unreachable or
        // unmigrated DB must FAIL the test, not vacuous-pass (this exact
        // silent skip hid a from-birth Date-bind crash in every one of
        // these tests until 2026-06-12).
        if (process.env.CI) {
          throw new Error(
            'real-PG keyset test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRateLimitOverridesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      const apiKeyId = randomUUID();
      seeded.push({ accountId, apiKeyId });
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-rlo-${accountId}@test.local`})`;
      await client`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${apiKeyId}, ${accountId}, 'keyset-probe', ${`dsk_${apiKeyId.slice(0, 8)}`}, ${`hash_${apiKeyId}`})`;

      const future = new Date(Date.UTC(2027, 0, 1)); // not expired → kept by default filter
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      const groups: Array<{ ts: Date; n: number }> = [
        { ts: new Date(base + 2000), n: 2 },
        { ts: new Date(base + 1000), n: 5 },
        { ts: new Date(base), n: 2 },
      ];
      const inserted: string[] = [];
      let bucketN = 0;
      for (const g of groups) {
        for (let i = 0; i < g.n; i++) {
          const bucket = `keyset-bucket-${bucketN++}`; // distinct: unique (account_id, bucket_key)
          const [row] = await client`
            INSERT INTO rate_limit_overrides
              (account_id, bucket_key, capacity, refill_per_second_centi, expires_at, set_by_key_id, created_at)
            VALUES (${accountId}, ${bucket}, 100, 100, ${future.toISOString()}, ${apiKeyId}, ${g.ts.toISOString()})
            RETURNING id`;
          inserted.push(row?.id as string);
        }
      }
      expect(inserted).toHaveLength(9);

      const collected: Array<{ id: string; createdAt: Date }> = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await repo.listAll(
          cursor === undefined ? { limit: 2, accountId } : { limit: 2, accountId, cursor },
        );
        collected.push(...page.items.map((r) => ({ id: r.id, createdAt: r.createdAt })));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // Completeness: every seeded override returned exactly once.
      expect(collected).toHaveLength(9);
      expect(new Set(collected.map((r) => r.id)).size).toBe(9);
      expect([...collected].map((r) => r.id).sort()).toEqual([...inserted].sort());

      // Ordering: non-increasing createdAt (desc) across the full walk.
      for (let i = 1; i < collected.length; i++) {
        expect(collected[i]!.createdAt.getTime()).toBeLessThanOrEqual(
          collected[i - 1]!.createdAt.getTime(),
        );
      }
    });

    // The case above pages a fixed set. This one adds overrides WHILE the walk
    // is in progress. See _helpers/keyset-stable-under-inserts.ts for why this
    // belongs against real Postgres rather than the in-memory twin.
    // V-1317 — the walk above ends on a SHORT final page (nine rows at limit two
    // leaves one), so it cannot tell `rows.length > limit` apart from `>=`. The
    // off-by-one only surfaces when the last page is exactly full, and then the
    // repo offers a cursor onto a page that is not there.
    it('CRITICAL reports NO further pages when the final page is exactly full. The walk above always ends short, so nothing distinguished the overfetch boundary — past it the caller follows a cursor to an empty page.', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG keyset test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRateLimitOverridesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      const apiKeyId = randomUUID();
      seeded.push({ accountId, apiKeyId });
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`boundary-rlo-${accountId}@test.local`})`;
      await client`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${apiKeyId}, ${accountId}, 'boundary-probe', ${`dsk_${apiKeyId.slice(0, 8)}`}, ${`hash_${apiKeyId}`})`;

      // Exactly four unexpired overrides, each on its own instant and its own
      // bucket key (the table is unique on (account_id, bucket_key)).
      const future = new Date(Date.UTC(2027, 0, 1));
      const base = Date.UTC(2026, 0, 2, 0, 0, 0);
      for (let i = 0; i < 4; i++) {
        await client`
          INSERT INTO rate_limit_overrides
            (account_id, bucket_key, capacity, refill_per_second_centi, expires_at, set_by_key_id, created_at)
          VALUES (${accountId}, ${`boundary-bucket-${i}`}, 100, 100, ${future.toISOString()}, ${apiKeyId}, ${new Date(base + i * 1000).toISOString()})`;
      }

      const exact = await repo.listAll({ limit: 4, accountId });
      expect(exact.items, 'the full population came back in one page').toHaveLength(4);
      expect(
        exact.nextCursor,
        'a full final page must not offer a cursor — it leads to an empty page',
      ).toBeNull();

      const first = await repo.listAll({ limit: 2, accountId });
      expect(first.items, 'first page is full').toHaveLength(2);
      expect(first.nextCursor, 'four rows at limit two: there IS a second page').not.toBeNull();

      const second = await repo.listAll({ limit: 2, accountId, cursor: first.nextCursor! });
      expect(second.items, 'the second page is also exactly full').toHaveLength(2);
      expect(second.nextCursor, 'and it is the last one').toBeNull();
    });

    it('CRITICAL a cursor from another account cannot anchor an account-filtered page', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG keyset test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRateLimitOverridesRepo({ client, db, close: async () => {} });
      const future = new Date(Date.UTC(2027, 0, 1));

      const seedOverride = async (at: Date): Promise<{ accountId: string; overrideId: string }> => {
        const accountId = randomUUID();
        const apiKeyId = randomUUID();
        seeded.push({ accountId, apiKeyId });
        await client!`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-own-${accountId}@test.local`})`;
        await client!`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
          VALUES (${apiKeyId}, ${accountId}, 'ownership-probe', ${`dsk_${apiKeyId.slice(0, 8)}`}, ${`hash_${apiKeyId}`})`;
        const [row] = await client!`
          INSERT INTO rate_limit_overrides
            (account_id, bucket_key, capacity, refill_per_second_centi, expires_at, set_by_key_id, created_at)
          VALUES (${accountId}, 'ownership-bucket', 100, 100, ${future.toISOString()}, ${apiKeyId}, ${at.toISOString()})
          RETURNING id`;
        return { accountId, overrideId: row?.id as string };
      };

      // Theirs is OLDER than mine, deliberately. The keyset pages strictly
      // backwards from the anchor, so a foreign row resolving as one filters my
      // newer row out entirely. Ordered the other way this arm passes either way.
      const theirs = await seedOverride(new Date(Date.UTC(2026, 0, 1)));
      const mine = await seedOverride(new Date(Date.UTC(2026, 0, 2)));

      const page = await repo.listAll({
        limit: 50,
        accountId: mine.accountId,
        cursor: theirs.overrideId,
      });
      expect(
        page.items.map((r) => r.id),
        'an override id from a different account resolved as the page anchor. The listing is ' +
          'filtered to one account, so the anchor lookup has to be filtered the same way or the ' +
          'page is positioned by a row the filter excludes and comes back wrong',
      ).toEqual([mine.overrideId]);
    });

    it('does not repeat or drop an override when overrides are created mid-walk (the documented concurrent-insert promise)', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG concurrent-insert test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const sql = client;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRateLimitOverridesRepo({ client: sql, db, close: async () => {} });

      const accountId = randomUUID();
      const apiKeyId = randomUUID();
      seeded.push({ accountId, apiKeyId });
      await sql`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`midwalk-rlo-${accountId}@test.local`})`;
      await sql`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${apiKeyId}, ${accountId}, 'midwalk', ${`dsk_${apiKeyId.slice(0, 8)}`}, ${`hash_${apiKeyId}`})`;

      const base = Date.UTC(2026, 4, 1, 0, 0, 0);
      const expires = new Date(Date.UTC(2030, 0, 1));
      let n = 0;
      await assertStableUnderMidWalkInserts({
        noun: 'override',
        seed: async (offsetMs) => {
          const [row] = await sql`
            INSERT INTO rate_limit_overrides
              (account_id, bucket_key, capacity, refill_per_second_centi, expires_at, set_by_key_id, created_at)
            VALUES (${accountId}, ${`midwalk-bucket-${n++}`}, 100, 100, ${expires.toISOString()}, ${apiKeyId}, ${new Date(base + offsetMs).toISOString()})
            RETURNING id`;
          return row?.id as string;
        },
        list: async ({ limit, cursor }) => {
          const page = await repo.listAll(cursor === undefined ? { limit } : { limit, cursor });
          return { ids: page.items.map((r) => r.id), nextCursor: page.nextCursor };
        },
      });
    });
  },
);
