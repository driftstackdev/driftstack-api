// Drizzle-backed integration test for DrizzleAdminAuditLogRepo.list keyset
// pagination — same-timestamp completeness against a REAL Postgres.
//
// Sibling of db-account-audit-repo-keyset-drizzle.test.ts. The admin
// audit list cursor was migrated to a compound (timestamp, id) keyset
// to stop dropping tie-group overflow at page boundaries — bulk admin
// actions written in one transaction share an identical now() timestamp.
// admin-audit differs from account-audit in two ways worth pinning on
// real PG: (1) its cursor lookup is NOT account-scoped (cross-account
// admin surface — `eq(id, cursor)` only), and (2) `action` is a pg enum
// (admin_audit_action), not free text.
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
import { DrizzleAdminAuditLogRepo } from '../../src/db/admin-audit-repo.js';
import { assertStableUnderMidWalkInserts } from './_helpers/keyset-stable-under-inserts.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// (accountId, apiKeyId) pairs this suite created — deleted in afterAll in
// FK order: admin_audit_log (admin_account_id FK is onDelete:restrict) →
// api_keys → accounts.
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
    await client`SELECT 1 FROM admin_audit_log LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const { accountId, apiKeyId } of seeded) {
      await client`DELETE FROM admin_audit_log WHERE admin_account_id = ${accountId}`.catch(
        () => {},
      );
      await client`DELETE FROM api_keys WHERE id = ${apiKeyId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleAdminAuditLogRepo.list keyset (Drizzle path against real Postgres)',
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
      const repo = new DrizzleAdminAuditLogRepo({ client, db, close: async () => {} });

      // Throwaway account + api key (both FK targets of admin_audit_log).
      const accountId = randomUUID();
      const apiKeyId = randomUUID();
      seeded.push({ accountId, apiKeyId });
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-admin-${accountId}@test.local`})`;
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
            INSERT INTO admin_audit_log (admin_account_id, admin_key_id, action, result, timestamp)
            VALUES (${accountId}, ${apiKeyId}, 'webhook_delivery.replayed', 'success', ${g.ts.toISOString()})
            RETURNING id`;
          inserted.push(row?.id as string);
        }
      }
      expect(inserted).toHaveLength(9);

      // Page with limit=2 (< the 5-row tie group), scoped to our admin.
      const collected: Array<{ id: string; timestamp: Date }> = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await repo.list(
          cursor === undefined
            ? { limit: 2, adminAccountId: accountId }
            : { limit: 2, adminAccountId: accountId, cursor },
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

    // The case above pages a fixed set. This one appends WHILE the walk runs.
    // See _helpers/keyset-stable-under-inserts.ts for why this belongs against
    // real Postgres rather than the in-memory twin.
    it('does not repeat or drop an entry when the admin log is appended to mid-walk (the documented concurrent-insert promise)', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG concurrent-append test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const sql = client;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAdminAuditLogRepo({ client: sql, db, close: async () => {} });

      const accountId = randomUUID();
      const apiKeyId = randomUUID();
      seeded.push({ accountId, apiKeyId });
      await sql`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`midwalk-admin-${accountId}@test.local`})`;
      await sql`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${apiKeyId}, ${accountId}, 'midwalk', ${`dsk_${apiKeyId.slice(0, 8)}`}, ${`hash_${apiKeyId}`})`;

      const base = Date.UTC(2026, 4, 1, 0, 0, 0);
      await assertStableUnderMidWalkInserts({
        noun: 'admin audit entry',
        seed: async (offsetMs) => {
          const [row] = await sql`
            INSERT INTO admin_audit_log (admin_account_id, admin_key_id, action, result, timestamp)
            VALUES (${accountId}, ${apiKeyId}, 'account.suspended', 'ok', ${new Date(base + offsetMs).toISOString()})
            RETURNING id`;
          return row?.id as string;
        },
        list: async ({ limit, cursor }) => {
          const page = await repo.list(
            cursor === undefined
              ? { limit, adminAccountId: accountId }
              : { limit, adminAccountId: accountId, cursor },
          );
          return { ids: page.items.map((r) => r.id), nextCursor: page.nextCursor };
        },
      });
    });
  },
);
