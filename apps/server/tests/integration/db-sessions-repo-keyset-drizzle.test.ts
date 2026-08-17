// Drizzle-backed integration test for DrizzleSessionRepo.listSessions
// keyset pagination — same-timestamp completeness against a REAL Postgres.
//
// Sibling of db-account-audit-repo-keyset-drizzle.test.ts. sessions is
// the highest-traffic paginated customer resource; listSessions pages
// the account's sessions on a compound (createdAt desc, id desc) keyset.
// A timestamp-only cursor would drop rows sharing the cursor's createdAt
// at a page boundary (sessions created in a burst share an identical
// now()). This validates the shipped Drizzle keyset SQL on real PG.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with
//     the `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleSessionRepo } from '../../src/db/sessions-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// (accountId, apiKeyId) pairs seeded — cleaned in FK order:
// sessions → api_keys → accounts.
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
    await client`SELECT 1 FROM sessions LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const { accountId, apiKeyId } of seeded) {
      await client`DELETE FROM sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM api_keys WHERE id = ${apiKeyId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleSessionRepo.listSessions keyset (Drizzle path against real Postgres)',
  () => {
    it('pages through a same-timestamp tie group larger than the page size WITHOUT dropping rows', async () => {
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
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      const apiKeyId = randomUUID();
      seeded.push({ accountId, apiKeyId });
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-sess-${accountId}@test.local`})`;
      await client`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${apiKeyId}, ${accountId}, 'keyset-probe', ${`dsk_${apiKeyId.slice(0, 8)}`}, ${`hash_${apiKeyId}`})`;

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
          const [row] = await client`
            INSERT INTO sessions (account_id, api_key_id, driver_session_id, created_at)
            VALUES (${accountId}, ${apiKeyId}, ${`drv_${randomUUID()}`}, ${g.ts.toISOString()})
            RETURNING id`;
          inserted.push(row?.id as string);
        }
      }
      expect(inserted).toHaveLength(9);

      const collected: Array<{ id: string; createdAt: Date }> = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await repo.listSessions(
          accountId,
          cursor === undefined ? { limit: 2 } : { limit: 2, cursor },
        );
        collected.push(...page.items.map((r) => ({ id: r.id, createdAt: r.createdAt })));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // Completeness: every seeded row returned exactly once.
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

    // The case above pages a fixed set. This one creates sessions WHILE the
    // walk is in progress, which is the ordinary state of this list: a customer
    // driving `sessions.list()` to completion is usually also starting
    // sessions, and every new one sorts ahead of the whole page they are on.
    //
    // The pagination reference promises "page 2 doesn't shift just because page
    // 1 grew". Nothing checked it for sessions, and the failure would be
    // invisible in aggregate — a duplicated session id in a reconciliation loop
    // reads as a real second session.
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
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });

      const seedSession = async (at: Date): Promise<{ accountId: string; sessionId: string }> => {
        const accountId = randomUUID();
        const apiKeyId = randomUUID();
        seeded.push({ accountId, apiKeyId });
        await client!`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-own-${accountId}@test.local`})`;
        await client!`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
          VALUES (${apiKeyId}, ${accountId}, 'ownership-probe', ${`dsk_${apiKeyId.slice(0, 8)}`}, ${`hash_${apiKeyId}`})`;
        const [row] = await client!`
          INSERT INTO sessions (account_id, api_key_id, driver_session_id, created_at)
          VALUES (${accountId}, ${apiKeyId}, ${`drv_${randomUUID()}`}, ${at.toISOString()})
          RETURNING id`;
        return { accountId, sessionId: row?.id as string };
      };

      // Theirs is OLDER than mine, deliberately. The keyset pages strictly
      // backwards from the anchor, so a foreign row resolving as one filters my
      // newer row out entirely. Ordered the other way this arm passes either way.
      const theirs = await seedSession(new Date(Date.UTC(2026, 0, 1)));
      const mine = await seedSession(new Date(Date.UTC(2026, 0, 2)));

      const page = await repo.listAllSessions({
        limit: 50,
        accountId: mine.accountId,
        cursor: theirs.sessionId,
      });
      expect(
        page.items.map((r) => r.id),
        'a session id from a different account resolved as the page anchor. The listing is ' +
          'filtered to one account, so the anchor lookup has to be filtered the same way or the ' +
          'page is positioned by a row the filter excludes and comes back wrong',
      ).toEqual([mine.sessionId]);
    });

    it('does not repeat or drop a session when sessions are created mid-walk (the documented concurrent-insert promise)', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG concurrent-create test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      const apiKeyId = randomUUID();
      seeded.push({ accountId, apiKeyId });
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`create-${accountId}@test.local`})`;
      await client`
        INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${apiKeyId}, ${accountId}, 'concurrent-probe', ${`dsk_${apiKeyId.slice(0, 8)}`}, ${`hash_${apiKeyId}`})`;

      const base = Date.UTC(2026, 3, 1, 0, 0, 0);
      // Capture into a non-null local: the `client` field is `... | null` and
      // a closure does not carry the narrowing from the guard above.
      const sql = client;
      const start = async (offsetMs: number): Promise<string> => {
        const [row] = await sql`
          INSERT INTO sessions (account_id, api_key_id, driver_session_id, created_at)
          VALUES (${accountId}, ${apiKeyId}, ${`drv_${randomUUID()}`}, ${new Date(base + offsetMs).toISOString()})
          RETURNING id`;
        return row?.id as string;
      };

      const originals: string[] = [];
      for (let i = 0; i < 5; i++) originals.push(await start(i * 1000));

      const first = await repo.listSessions(accountId, { limit: 2 });
      expect(first.items, 'page 1 is full').toHaveLength(2);

      // Three sessions started while the customer is still paging.
      for (let i = 0; i < 3; i++) await start(10_000 + i * 1000);

      const seen = first.items.map((r) => r.id);
      let cursor = first.nextCursor;
      for (let guard = 0; guard < 50 && cursor !== null; guard++) {
        const page = await repo.listSessions(accountId, { limit: 2, cursor });
        seen.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
      }

      expect(
        seen.filter((id, i) => seen.indexOf(id) !== i),
        'no session may be returned twice — a duplicate reads as a real second session',
      ).toEqual([]);
      expect(
        originals.filter((id) => !seen.includes(id)),
        'and no session that existed before the walk may be skipped',
      ).toEqual([]);
      expect(cursor, 'the walk terminated on its own').toBeNull();
    });
  },
);
