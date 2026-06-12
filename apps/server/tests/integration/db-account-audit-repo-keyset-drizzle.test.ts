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
  },
);
