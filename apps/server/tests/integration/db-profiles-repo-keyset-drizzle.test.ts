// Drizzle-backed integration test for DrizzleProfilesRepo.list keyset
// pagination — same-timestamp completeness against a REAL Postgres.
//
// Sibling of db-sessions-repo-keyset-drizzle.test.ts. profiles is the
// prod-proven keyset REFERENCE impl (the timestamp-only-cursor migration
// mirrored it across the other repos), and it's the highest-traffic
// customer list — but it had no real-Postgres regression guard. list()
// pages an account's profiles on a compound (createdAt desc, id desc)
// keyset; a timestamp-only cursor would drop rows sharing the cursor's
// createdAt at a page boundary (profiles created in a burst share an
// identical now()). This locks the shipped keyset SQL on real PG.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

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
// accountIds seeded — cleaned in FK order: profiles → accounts.
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
  'DrizzleProfilesRepo.list keyset (Drizzle path against real Postgres)',
  () => {
    it('pages a same-createdAt tie group larger than the page size WITHOUT dropping rows', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-prof-${accountId}@test.local`})`;

      // 2 newest, 5 in a tie group (> page size 2), 2 oldest — distinct
      // names (account+name is unique), controlled created_at for the tie.
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      const groups: Array<{ ts: Date; n: number }> = [
        { ts: new Date(base + 2000), n: 2 },
        { ts: new Date(base + 1000), n: 5 },
        { ts: new Date(base), n: 2 },
      ];
      const inserted: string[] = [];
      let nameSeq = 0;
      for (const g of groups) {
        for (let i = 0; i < g.n; i++) {
          const [row] = await client`
            INSERT INTO profiles (account_id, name, created_at)
            VALUES (${accountId}, ${`keyset-prof-${nameSeq++}`}, ${g.ts})
            RETURNING id`;
          inserted.push(row?.id as string);
        }
      }
      expect(inserted).toHaveLength(9);

      const collected: Array<{ id: string; createdAt: Date }> = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await repo.list(
          cursor === undefined ? { accountId, limit: 2 } : { accountId, limit: 2, cursor },
        );
        collected.push(...page.data.map((r) => ({ id: r.id, createdAt: r.createdAt })));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // Completeness: every seeded profile returned exactly once.
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
  },
);

// V-714 — the TOCTOU guard this change exists for. Only a REAL Postgres
// exercises the `FOR UPDATE` account-row lock inside insertWithLimit; the
// in-memory repo's JS-single-thread atomicity can't reproduce the race.
describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleProfilesRepo.insertWithLimit (V-714 — atomic tier-cap under real concurrency)',
  () => {
    it('serialises N concurrent creates so exactly `limit` succeed (no over-create past the cap)', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`limit-prof-${accountId}@test.local`})`;

      // Fire N concurrent creates against a cap of 1, each with a DISTINCT name
      // (so the unique index is NOT the limiter — only the tier cap is). Without
      // the FOR UPDATE lock all N read count=0 and all insert (the TOCTOU); the
      // account-row lock serialises them so exactly `LIMIT` win.
      const LIMIT = 1;
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, (_unused, i) =>
          repo.insertWithLimit(
            {
              accountId,
              name: `limit-prof-${i.toString()}`,
              archetype: 'iphone16pro_ios18_7_safari26_4',
              description: null,
            },
            LIMIT,
          ),
        ),
      );
      const accepted = results.filter((r) => 'record' in r);
      const refused = results.filter((r) => 'limitExceeded' in r);
      expect(accepted).toHaveLength(LIMIT);
      expect(refused).toHaveLength(N - LIMIT);

      // The DB agrees: exactly LIMIT rows exist for the account.
      const countRows = await client`
        SELECT count(*)::int AS n FROM profiles WHERE account_id = ${accountId}`;
      expect(countRows[0]?.n).toBe(LIMIT);
    });
  },
);
