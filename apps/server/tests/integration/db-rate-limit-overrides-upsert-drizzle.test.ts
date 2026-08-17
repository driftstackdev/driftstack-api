// Drizzle-backed integration test for DrizzleRateLimitOverridesRepo.upsert
// against a REAL Postgres — the ON CONFLICT (account_id, bucket_key) DO
// UPDATE path, Date-param serialization, and centi-rate quantization.
//
// The in-memory twin keys a Map by `${accountId}:${bucketKey}`, so it
// never exercises Postgres's ON CONFLICT clause, the timestamptz Date
// binding (the class behind the 2026-05-19 scheduled-jobs Date-param
// prod bug), or the refill_per_second_centi *100 round-trip. This guard
// covers all three on real PG: a second upsert on the same bucket must
// REPLACE (not duplicate) the row, with updated capacity/refill and a
// preserved id, and refillPerSecond must survive the /100 read-side.
//
// Run scope: CI postgres:17-alpine (always); skips locally without
// DATABASE_URL.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleRateLimitOverridesRepo } from '../../src/db/rate-limit-overrides-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
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
  'DrizzleRateLimitOverridesRepo.upsert (Drizzle ON CONFLICT path against real Postgres)',
  () => {
    it('CRITICAL the dependency was reachable, so a green here is not "no service". V-793 — this arm previously sat inside beforeAll, where vitest registers nothing: the assertion existed as text, never ran, and the hole it was written to close stayed open.', () => {
      // Every arm below early-returns when the handle is absent. Without this
      // one, a run against a dead service reports PASSED — a green meaning
      // "nothing was tested", indistinguishable from "the service agreed".
      expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
    });

    it('re-upserting the same (account, bucket) REPLACES the row (no duplicate) + round-trips Date + centi-rate', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRateLimitOverridesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      const apiKeyId = randomUUID();
      seeded.push({ accountId, apiKeyId });
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`rlo-upsert-${accountId}@test.local`})`;
      await client`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${apiKeyId}, ${accountId}, 'upsert-probe', ${`dsk_${apiKeyId.slice(0, 8)}`}, ${`hash_${apiKeyId}`})`;

      const expires = new Date(Date.UTC(2027, 5, 15, 12, 0, 0));
      const first = await repo.upsert({
        accountId,
        bucketKey: 'global',
        capacity: 100,
        refillPerSecond: 1.5, // → 150 centi → read back as 1.5
        expiresAt: expires,
        reason: 'first',
        setByKeyId: apiKeyId,
      });
      expect(first.capacity).toBe(100);
      expect(first.refillPerSecond).toBeCloseTo(1.5, 5);
      expect(first.expiresAt.getTime()).toBe(expires.getTime()); // Date round-trip

      // Second upsert, SAME (account, bucket) → ON CONFLICT DO UPDATE.
      const second = await repo.upsert({
        accountId,
        bucketKey: 'global',
        capacity: 250,
        refillPerSecond: 3,
        expiresAt: expires,
        reason: 'second',
        setByKeyId: apiKeyId,
      });
      expect(second.id).toBe(first.id); // same row, not a new insert
      expect(second.capacity).toBe(250);
      expect(second.refillPerSecond).toBeCloseTo(3, 5);

      // Exactly one row for this account+bucket (replace, not duplicate).
      const page = await repo.listAll({ limit: 50, accountId });
      const globals = page.items.filter((r) => r.bucketKey === 'global');
      expect(globals).toHaveLength(1);
      expect(globals[0]!.capacity).toBe(250);
      expect(globals[0]!.reason).toBe('second');
    });
  },
);
