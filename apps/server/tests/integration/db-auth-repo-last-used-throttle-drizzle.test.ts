// Drizzle-backed integration test for DrizzleAccountAuthRepo.touchApiKeyLastUsed
// against a REAL Postgres.
//
// Regression guard for the write-once bug: the throttle WHERE had degenerated
// to `or(isNull(last_used_at))` (the staleness branch was left as a comment),
// so last_used_at was set ONCE (first use) and never updated again — the
// dashboard's API-key "last used" was silently frozen at first use. This was
// invisible to the in-memory repo (which updated unconditionally) so no test
// caught it; only the real Drizzle SQL had the bug. This validates the shipped
// `or(isNull, lt(last_used_at, at - 30s))` predicate: updates from NULL,
// throttles a re-touch within 30s, and updates a re-touch after 30s.
//
// Run scope: CI postgres:17-alpine (always); skips locally without DATABASE_URL.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountAuthRepo } from '../../src/db/auth-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccountIds: string[] = [];

beforeAll(async () => {
  it('CRITICAL the service was reachable, so a green here is not "no service"', () => {
    // Without this, every arm below early-returns against a dead service and the
    // file reports PASSED — a green meaning "nothing was tested".
    expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
  });

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
  'DrizzleAccountAuthRepo.touchApiKeyLastUsed throttle (Drizzle path against real Postgres)',
  () => {
    it('updates from NULL, throttles a re-touch within 30s, updates a re-touch after 30s', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAccountAuthRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`lastused-${accountId}@test.local`})`;

      const prefix = `dsk_${randomUUID().slice(0, 8)}`;
      const [keyRow] = await client`
        INSERT INTO api_keys (account_id, name, key_prefix, key_hash)
        VALUES (${accountId}, 'lastused', ${prefix}, ${`hash_${randomUUID()}`})
        RETURNING id`;
      const keyId = keyRow?.id as string;

      // Precondition: last_used_at starts NULL.
      expect((await repo.findApiKeyByPrefix(prefix))?.lastUsedAt).toBeNull();

      // 1) NULL → set on first touch.
      const t0 = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
      await repo.touchApiKeyLastUsed(keyId, t0);
      const after0 = (await repo.findApiKeyByPrefix(prefix))?.lastUsedAt;
      expect(after0?.getTime()).toBe(t0.getTime());

      // 2) Re-touch within 30s → throttled (unchanged), NOT frozen-at-NULL.
      const t10s = new Date(t0.getTime() + 10_000);
      await repo.touchApiKeyLastUsed(keyId, t10s);
      const after10 = (await repo.findApiKeyByPrefix(prefix))?.lastUsedAt;
      expect(after10?.getTime()).toBe(t0.getTime());

      // 3) Re-touch after 30s → updates (the bug: this never updated).
      const t40s = new Date(t0.getTime() + 40_000);
      await repo.touchApiKeyLastUsed(keyId, t40s);
      const after40 = (await repo.findApiKeyByPrefix(prefix))?.lastUsedAt;
      expect(after40?.getTime()).toBe(t40s.getTime());
    });
  },
);
