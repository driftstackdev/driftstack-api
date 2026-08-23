// Drizzle-backed integration test for DrizzleApiKeysRepo.listAllApiKeys
// keyset pagination — same-timestamp completeness against a REAL Postgres.
//
// Part of the cursor-class real-PG guard family (account-audit / admin-
// audit / sessions). listAllApiKeys is the admin cross-account key list;
// it pages on a compound (createdAt, id) keyset. Keys minted in a burst
// share an identical created_at, so a timestamp-only cursor would drop
// the tie-group overflow at a page boundary. This validates the shipped
// Drizzle keyset SQL (this repo's specific columns/filters) on real PG.
// Seeding is scoped to a throwaway account via the accountId filter, so
// it's deterministic regardless of other rows in the CI database.
//
// Run scope: CI postgres:17-alpine (always); skips locally without
// DATABASE_URL.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleApiKeysRepo } from '../../src/db/api-keys-repo.js';
import { assertStableUnderMidWalkInserts } from './_helpers/keyset-stable-under-inserts.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccountIds: string[] = [];

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
    await client`SELECT 1 FROM api_keys LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const id of seededAccountIds) {
      await client`DELETE FROM api_keys WHERE account_id = ${id}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleApiKeysRepo.listAllApiKeys keyset (Drizzle path against real Postgres)',
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
      const repo = new DrizzleApiKeysRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-keys-${accountId}@test.local`})`;

      // 2 newest, 5 in a tie group (> page size), 2 oldest.
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      const groups: Array<{ ts: Date; n: number }> = [
        { ts: new Date(base + 2000), n: 2 },
        { ts: new Date(base + 1000), n: 5 },
        { ts: new Date(base), n: 2 },
      ];
      const inserted: string[] = [];
      for (const g of groups) {
        for (let i = 0; i < g.n; i++) {
          const kid = randomUUID();
          const [row] = await client`
            INSERT INTO api_keys (account_id, name, key_prefix, key_hash, created_at)
            VALUES (${accountId}, 'keyset', ${`dsk_${kid.slice(0, 8)}`}, ${`hash_${kid}`}, ${g.ts.toISOString()})
            RETURNING id`;
          inserted.push(row?.id as string);
        }
      }
      expect(inserted).toHaveLength(9);

      const collected: Array<{ id: string; createdAt: Date }> = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await repo.listAllApiKeys(
          cursor === undefined ? { limit: 2, accountId } : { limit: 2, accountId, cursor },
        );
        collected.push(...page.items.map((r) => ({ id: r.id, createdAt: r.createdAt })));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // Completeness: every seeded key returned exactly once.
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

    // The case above pages a fixed set. This one adds keys WHILE the walk is in
    // progress. See _helpers/keyset-stable-under-inserts.ts for why this
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
      const repo = new DrizzleApiKeysRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`boundary-keys-${accountId}@test.local`})`;

      // Exactly four, each on its own instant so ordering is total. Scoped by
      // accountId because the table is shared with every other suite.
      const base = Date.UTC(2026, 0, 2, 0, 0, 0);
      for (let i = 0; i < 4; i++) {
        const kid = randomUUID();
        await client`
          INSERT INTO api_keys (account_id, name, key_prefix, key_hash, created_at)
          VALUES (${accountId}, 'boundary', ${`dsk_${kid.slice(0, 8)}`}, ${`hash_${kid}`}, ${new Date(base + i * 1000).toISOString()})`;
      }

      const exact = await repo.listAllApiKeys({ limit: 4, accountId });
      expect(exact.items, 'the full population came back in one page').toHaveLength(4);
      expect(
        exact.nextCursor,
        'a full final page must not offer a cursor — it leads to an empty page',
      ).toBeNull();

      const first = await repo.listAllApiKeys({ limit: 2, accountId });
      expect(first.items, 'first page is full').toHaveLength(2);
      expect(first.nextCursor, 'four rows at limit two: there IS a second page').not.toBeNull();

      const second = await repo.listAllApiKeys({ limit: 2, accountId, cursor: first.nextCursor! });
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
      const repo = new DrizzleApiKeysRepo({ client, db, close: async () => {} });

      const seedKey = async (at: Date): Promise<{ accountId: string; keyId: string }> => {
        const accountId = randomUUID();
        seededAccountIds.push(accountId);
        await client!`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-own-${accountId}@test.local`})`;
        const kid = randomUUID();
        const [row] = await client!`
          INSERT INTO api_keys (account_id, name, key_prefix, key_hash, created_at)
          VALUES (${accountId}, 'ownership', ${`dsk_${kid.slice(0, 8)}`}, ${`hash_${kid}`}, ${at.toISOString()})
          RETURNING id`;
        return { accountId, keyId: row?.id as string };
      };

      // Theirs is OLDER than mine, deliberately. The keyset pages strictly
      // backwards from the anchor, so a foreign row resolving as one filters my
      // newer key out entirely. Ordered the other way this arm passes either way.
      const theirs = await seedKey(new Date(Date.UTC(2026, 0, 1)));
      const mine = await seedKey(new Date(Date.UTC(2026, 0, 2)));

      const page = await repo.listAllApiKeys({
        limit: 50,
        accountId: mine.accountId,
        cursor: theirs.keyId,
      });
      expect(
        page.items.map((k) => k.id),
        'a key id from a different account resolved as the page anchor. The listing is filtered to ' +
          'one account, so the anchor lookup has to be filtered the same way or the page is ' +
          'positioned by a row the filter excludes and comes back wrong',
      ).toEqual([mine.keyId]);
    });

    it('does not repeat or drop a key when api keys are created mid-walk (the documented concurrent-insert promise)', async () => {
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
      const repo = new DrizzleApiKeysRepo({ client: sql, db, close: async () => {} });

      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await sql`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`midwalk-${accountId}@test.local`})`;

      const base = Date.UTC(2026, 4, 1, 0, 0, 0);
      await assertStableUnderMidWalkInserts({
        noun: 'api key',
        seed: async (offsetMs) => {
          const kid = randomUUID();
          const [row] = await sql`
            INSERT INTO api_keys (account_id, name, key_prefix, key_hash, created_at)
            VALUES (${accountId}, 'midwalk', ${`dsk_${kid.slice(0, 8)}`}, ${`hash_${kid}`}, ${new Date(base + offsetMs).toISOString()})
            RETURNING id`;
          return row?.id as string;
        },
        list: async ({ limit, cursor }) => {
          // Single options object, and `accountId` MUST be inside it: passing it
          // positionally silently drops `limit`, the walk returns every key in
          // the database in one page, and the absence assertions all pass.
          const page = await repo.listAllApiKeys(
            cursor === undefined ? { limit, accountId } : { limit, accountId, cursor },
          );
          return { ids: page.items.map((r) => r.id), nextCursor: page.nextCursor };
        },
      });
    });
  },
);
