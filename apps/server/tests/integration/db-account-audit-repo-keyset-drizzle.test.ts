// Drizzle-backed integration test for DrizzleAccountAuditRepo.list keyset
// pagination — same-timestamp completeness against a REAL Postgres.
//
// Why this exists: 2026-05-26 the account-audit list cursor was migrated
// from a timestamp-only cursor to a compound (timestamp, id) keyset
// (mirrors profiles-repo). The bug the migration fixed: a timestamp-only
// cursor set nextCursor to a shared timestamp, and the next page's strict
// `lt(timestamp, cursor)` excluded the ENTIRE tie group, so rows sharing
// the cursor's timestamp at a page boundary were silently DROPPED. Audit
// rows written in one transaction (bulk actions) share an identical
// `now()` timestamp, so the collision is real, not theoretical.
//
// The unit + in-memory tests pin the keyset SHAPE and exercise the
// in-memory twin, but NOT the Drizzle SQL — `or(lt(ts), and(eq(ts),
// lt(id)))` compiled by drizzle-orm against real Postgres. This test
// closes that gap: it seeds a tie group larger than the page size,
// pages through with the real Drizzle query, and asserts every row is
// returned exactly once in non-increasing timestamp order.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with
//     the `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable. Set
//     DATABASE_URL=postgres://... to opt in to local verification.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountAuditRepo } from '../../src/db/account-audit-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// Accounts this suite created — deleted in afterAll (cascade clears the
// account_audit_log rows via the account_id FK on delete).
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
  // Schema-presence probe: skip rather than fail if migrations aren't
  // applied (partially-bootstrapped local env).
  try {
    await client`SELECT 1 FROM account_audit_log LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const id of seededAccountIds) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleAccountAuditRepo.list keyset (Drizzle path against real Postgres)',
  () => {
    it('pages through a same-timestamp tie group larger than the page size WITHOUT dropping rows (regression for the timestamp-only-cursor drop)', async () => {
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
      const repo = new DrizzleAccountAuditRepo({ client, db, close: async () => {} });

      // Throwaway account (only `email` is required + no-default).
      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-${accountId}@test.local`})`;

      // Three timestamp groups: 2 newest, 5 in a tie group, 2 oldest.
      // The tie group (5) exceeds the page size (2), so a timestamp-only
      // cursor would drop the tie-group overflow at the page boundary.
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
            INSERT INTO account_audit_log (account_id, actor_type, action, timestamp)
            VALUES (${accountId}, 'system', 'webhook_endpoint.created', ${g.ts.toISOString()})
            RETURNING id`;
          inserted.push(row?.id as string);
        }
      }
      expect(inserted).toHaveLength(9);

      // Page through with limit=2 (smaller than the 5-row tie group).
      const collected: Array<{ id: string; timestamp: Date }> = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await repo.list(
          accountId,
          cursor === undefined ? { limit: 2 } : { limit: 2, cursor },
        );
        collected.push(...page.items.map((r) => ({ id: r.id, timestamp: r.timestamp })));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // Completeness: every seeded row returned exactly once.
      expect(collected).toHaveLength(9);
      expect(new Set(collected.map((r) => r.id)).size).toBe(9);
      expect([...collected].map((r) => r.id).sort()).toEqual([...inserted].sort());

      // Ordering: non-increasing timestamp (desc) across the full walk.
      for (let i = 1; i < collected.length; i++) {
        expect(collected[i]!.timestamp.getTime()).toBeLessThanOrEqual(
          collected[i - 1]!.timestamp.getTime(),
        );
      }
    });

    // V-1317 — the boundary the two walks above never reach.
    //
    // Both page until the cursor goes null, and both end on a SHORT final page:
    // nine rows at limit two leaves one. So the case where the last page is
    // exactly FULL — total rows an exact multiple of the limit — is never
    // exercised, and that is precisely where `rows.length > limit` differs from
    // `>=`. Under the off-by-one the repo hands back a cursor for a page that
    // does not exist, and the customer's own paging loop makes one more request
    // and receives nothing. Mutating `>` to `>=` across all fourteen paginated
    // repos left this file green.
    it('CRITICAL reports NO further pages when the final page is exactly full. The walks above always end on a short page, so nothing here distinguished `rows.length > limit` from `>=` — the classic overfetch off-by-one, which hands the customer a cursor onto an empty page.', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG keyset test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAccountAuditRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`boundary-${accountId}@test.local`})`;

      // Exactly four rows, each on its own timestamp so ordering is total.
      const base = Date.UTC(2026, 0, 2, 0, 0, 0);
      for (let i = 0; i < 4; i++) {
        await client`
          INSERT INTO account_audit_log (account_id, actor_type, action, timestamp)
          VALUES (${accountId}, 'system', 'webhook_endpoint.created', ${new Date(base + i * 1000).toISOString()})`;
      }

      // A page whose size equals the whole population: full, and the last one.
      const exact = await repo.list(accountId, { limit: 4 });
      expect(exact.items, 'the full population came back in one page').toHaveLength(4);
      expect(
        exact.nextCursor,
        'a full final page must not offer a cursor — that cursor leads to an empty page',
      ).toBeNull();

      // And the same boundary reached by WALKING: two pages of two, the second
      // exactly full. This is the shape a customer's loop actually takes.
      const second = await repo.list(accountId, { limit: 2 });
      expect(second.items, 'first page is full').toHaveLength(2);
      expect(second.nextCursor, 'with four rows and a limit of two there IS more').not.toBeNull();

      const third = await repo.list(accountId, { limit: 2, cursor: second.nextCursor! });
      expect(third.items, 'the second page is also exactly full').toHaveLength(2);
      expect(
        third.nextCursor,
        'and it is the last — a cursor here sends the caller to an empty page',
      ).toBeNull();
    });

    // The case above seeds a fixed set and pages it. This one lets the log GROW
    // mid-walk, which is what an audit log actually does: it is append-only and
    // written on every account action, so a customer exporting theirs is paging
    // a table that is still receiving rows.
    //
    // The pagination reference promises exactly this — "cursor pagination is
    // stable under concurrent inserts (page 2 doesn't shift just because page 1
    // grew)" — and names the audit log among the endpoints it governs. Nothing
    // checked it here. An export that returns an entry twice, or walks past one,
    // is a defect a customer discovers while reconciling records, which is the
    // worst possible moment.
    it('does not repeat or drop an entry when the log is appended to mid-walk (the documented concurrent-insert promise)', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG concurrent-append test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAccountAuditRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`append-${accountId}@test.local`})`;

      const base = Date.UTC(2026, 2, 1, 0, 0, 0);
      // Capture into a non-null local: the `client` field is `... | null` and
      // a closure does not carry the narrowing from the guard above.
      const sql = client;
      const write = async (offsetMs: number): Promise<string> => {
        const [row] = await sql`
          INSERT INTO account_audit_log (account_id, actor_type, action, timestamp)
          VALUES (${accountId}, 'system', 'webhook_endpoint.created', ${new Date(base + offsetMs).toISOString()})
          RETURNING id`;
        return row?.id as string;
      };

      const originals: string[] = [];
      for (let i = 0; i < 5; i++) originals.push(await write(i * 1000));

      const first = await repo.list(accountId, { limit: 2 });
      expect(first.items, 'page 1 is full').toHaveLength(2);

      // The log grows: three entries NEWER than anything returned so far.
      for (let i = 0; i < 3; i++) await write(10_000 + i * 1000);

      const seen = first.items.map((r) => r.id);
      let cursor = first.nextCursor;
      for (let guard = 0; guard < 50 && cursor !== null; guard++) {
        const page = await repo.list(accountId, { limit: 2, cursor });
        seen.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
      }

      expect(
        seen.filter((id, i) => seen.indexOf(id) !== i),
        'no audit entry may be returned twice — a duplicated row in an export is a reconciliation defect',
      ).toEqual([]);
      expect(
        originals.filter((id) => !seen.includes(id)),
        'and no entry present before the walk began may be skipped',
      ).toEqual([]);
      expect(cursor, 'the export loop terminated on its own').toBeNull();
    });
  },
);
