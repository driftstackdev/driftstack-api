// Drizzle-backed integration test: DrizzleWebhooksRepo.insertEndpointIfUnderLimit
// enforces the per-account active-endpoint cap ATOMICALLY under concurrency,
// against a REAL Postgres.
//
// The old create path was countActiveEndpoints() then a SEPARATE
// insertEndpoint() — a TOCTOU: N concurrent creates all read the same stale
// count, all pass the cap check, all insert → the 10-endpoint cap is exceeded.
// insertEndpointIfUnderLimit closes it: the count+insert run in ONE transaction
// serialised by a per-account pg_advisory_xact_lock, so the second transaction
// blocks on the lock until the first commits, then re-counts, sees the cap is
// full, and returns null (the service surfaces ConflictError).
//
// The in-memory twin is synchronous (no await gap → no race), so only a real
// Postgres with a MULTI-connection pool (max:5 → distinct connections) actually
// exercises the advisory lock. With the fix: exactly `limit` rows; the pre-fix
// count-then-insert would yield up to N.
//
// Run scope:
//   - CI: the build-test job has postgres:17 at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if the DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';
import type { NewWebhookEndpointInput } from '../../src/services/webhooks.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// accountIds seeded — cleaned in FK order: webhook_endpoints → accounts.
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
  // max: 5 so concurrent transactions get distinct connections — the advisory
  // lock, not connection serialisation, is what's exercised.
  client = postgres(DB_URL, { max: 5 });
  try {
    await client`SELECT 1 FROM webhook_endpoints LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM webhook_endpoints WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccount(client: ReturnType<typeof postgres>): Promise<string> {
  const accountId = randomUUID();
  seeded.push(accountId);
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`wh-cap-${accountId}@test.local`})`;
  return accountId;
}

function mkInput(accountId: string, i: number): NewWebhookEndpointInput {
  return {
    accountId,
    url: `https://hooks.example/${accountId.slice(0, 4)}-${i.toString()}`,
    secret: `whsec_${randomUUID()}`,
    secretPrefix: `whsec_${i.toString()}`,
    events: ['session.completed'],
    description: null,
  };
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'webhook-endpoint cap enforcement is atomic (insertEndpointIfUnderLimit advisory lock, real Postgres)',
  () => {
    it('5 concurrent inserts on a limit-1 account yield EXACTLY 1 row (the advisory lock serialises → 4 losers get null)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleWebhooksRepo({ client, db, close: async () => {} });
      const accountId = await seedAccount(client);

      // Pre-fix (bare count-then-insert) → all 5 read count=0 → 5 rows. With the
      // locked count+insert → exactly 1 inserts, the other 4 return null.
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) => repo.insertEndpointIfUnderLimit(mkInput(accountId, i), 1)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(4);
      expect(await repo.countActiveEndpoints(accountId)).toBe(1);
    });

    it('6 concurrent inserts on a limit-3 account yield EXACTLY 3 rows', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleWebhooksRepo({ client, db, close: async () => {} });
      const accountId = await seedAccount(client);

      const results = await Promise.all(
        [0, 1, 2, 3, 4, 5].map((i) => repo.insertEndpointIfUnderLimit(mkInput(accountId, i), 3)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(3);
      expect(await repo.countActiveEndpoints(accountId)).toBe(3);
    });
  },
);
