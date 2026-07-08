// C1 — Drizzle-backed integration test for the crypto_entitlements table
// against a REAL Postgres. These semantics CANNOT be proven by the in-memory
// twin or by pglite:
//
//   1. The GLOBAL unique index `crypto_entitlements_order_id_unique` (order_id)
//      is the arbiter for activateCryptoEntitlement's ON CONFLICT DO NOTHING —
//      the idempotent-replay backstop. Only a real Postgres unique index proves
//      the arbiter target actually deduplicates a re-delivered paid IPN.
//   2. Same-tier STACKING computes the next window off the account's latest
//      unexpired same-tier expiry (a real gt(expires_at, paid_at) read).
//   3. The reconcile UNION (downgradeAccountTierToBestRemaining) floors the
//      account to its best UNEXPIRED entitlement via gt(expires_at, at).
//   4. The PARTIAL sweep index `WHERE expired_processed_at IS NULL` +
//      listExpiredUnprocessedCryptoEntitlements / markCryptoEntitlementsProcessed.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine migrated with the `driftstack`
//     schema; this test runs there and MUST NOT vacuously pass (see beforeAll).
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// accountIds seeded — cleaned in FK order: crypto_entitlements → accounts
// (the FK cascades, but delete explicitly so a failed cascade can't leak rows).
const seeded: string[] = [];

function makeRepo(): DrizzleStripeWebhooksRepo {
  const db = drizzle(client!) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return new DrizzleStripeWebhooksRepo({ client: client!, db, close: async () => {} });
}

async function seedAccount(tier = 'free'): Promise<string> {
  const accountId = randomUUID();
  seeded.push(accountId);
  await client!`INSERT INTO accounts (id, email, tier)
    VALUES (${accountId}, ${`crypto-ent-${accountId}@test.local`}, ${tier})`;
  return accountId;
}

async function accountTier(accountId: string): Promise<string> {
  const [row] =
    (await client!`SELECT tier FROM accounts WHERE id = ${accountId}`) as unknown as Array<{
      tier: string;
    }>;
  return row!.tier;
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    dbReachable = false;
  }
  if (dbReachable) {
    client = postgres(DB_URL, { max: 1 });
    try {
      await client`SELECT 1 FROM crypto_entitlements LIMIT 0`;
    } catch {
      dbReachable = false;
      await client.end({ timeout: 1 }).catch(() => {});
      client = null;
    }
  }
  // In CI the migrated table MUST exist — refuse to vacuously pass the only
  // place the real unique/partial indexes + ON CONFLICT arbiter are proven.
  if (process.env.CI && !dbReachable) {
    throw new Error(
      'CI requires a migrated Postgres with crypto_entitlements — DB/table unreachable; refusing to silently skip the constraint proof',
    );
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM crypto_entitlements WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'crypto_entitlements (Drizzle path against real Postgres)',
  () => {
    it('activateCryptoEntitlement is idempotent on order_id — a replay inserts nothing and returns the original window', async () => {
      if (!dbReachable || !client) return;
      const repo = makeRepo();
      const accountId = await seedAccount('free');
      const orderId = `ord-${randomUUID()}`;
      const paidAt = new Date('2026-07-01T00:00:00.000Z');

      const first = await repo.activateCryptoEntitlement({
        accountId,
        orderId,
        tier: 'api_builder',
        paidAt,
        termDays: 31,
      });
      expect(first.entitlementInserted).toBe(true);
      expect(first.applied).toBe(true); // upgrade from free
      expect(first.previousTier).toBe('free');
      expect(first.expiresAt).toEqual(new Date(paidAt.getTime() + 31 * DAY_MS));
      expect(await accountTier(accountId)).toBe('api_builder');

      // Replay the SAME order_id (re-delivered IPN). The real unique index is
      // the ON CONFLICT arbiter → no second row, no double-extend, no re-apply.
      const replay = await repo.activateCryptoEntitlement({
        accountId,
        orderId,
        tier: 'api_builder',
        paidAt: new Date('2026-07-05T00:00:00.000Z'), // different paidAt, ignored on replay
        termDays: 31,
      });
      expect(replay.entitlementInserted).toBe(false);
      expect(replay.applied).toBe(false);
      expect(replay.expiresAt).toEqual(first.expiresAt); // original window verbatim

      const [countRow] =
        (await client`SELECT count(*)::int AS n FROM crypto_entitlements WHERE order_id = ${orderId}`) as unknown as Array<{
          n: number;
        }>;
      expect(countRow!.n).toBe(1);
    });

    it('same-tier re-purchase STACKS off the latest unexpired same-tier expiry', async () => {
      if (!dbReachable || !client) return;
      const repo = makeRepo();
      const accountId = await seedAccount('free');
      const paidAt1 = new Date('2026-07-01T00:00:00.000Z');

      const g1 = await repo.activateCryptoEntitlement({
        accountId,
        orderId: `ord-${randomUUID()}`,
        tier: 'api_builder',
        paidAt: paidAt1,
        termDays: 31,
      });
      // Second purchase 5 days later, still inside the first window → stacks:
      // startsAt = g1.expiresAt, expiresAt = g1.expiresAt + 31d.
      const g2 = await repo.activateCryptoEntitlement({
        accountId,
        orderId: `ord-${randomUUID()}`,
        tier: 'api_builder',
        paidAt: new Date(paidAt1.getTime() + 5 * DAY_MS),
        termDays: 31,
      });
      expect(g2.entitlementInserted).toBe(true);
      expect(g2.startsAt).toEqual(g1.expiresAt);
      expect(g2.expiresAt).toEqual(new Date(g1.expiresAt.getTime() + 31 * DAY_MS));
    });

    it('downgradeAccountTierToBestRemaining floors to the best UNEXPIRED entitlement, then drops once it lapses', async () => {
      if (!dbReachable || !client) return;
      const repo = makeRepo();
      const accountId = await seedAccount('free');
      const paidAt = new Date('2026-07-01T00:00:00.000Z');
      await repo.activateCryptoEntitlement({
        accountId,
        orderId: `ord-${randomUUID()}`,
        tier: 'api_scale',
        paidAt,
        termDays: 31,
      });
      expect(await accountTier(accountId)).toBe('api_scale');

      // A Stripe cancel with no active subs, WHILE the entitlement is still
      // valid → the union floors the account to api_scale, not free.
      const inWindow = await repo.downgradeAccountTierToBestRemaining({
        accountId,
        fallbackTier: 'free',
        at: new Date(paidAt.getTime() + 10 * DAY_MS),
      });
      expect(inWindow.appliedTier).toBe('api_scale');
      expect(await accountTier(accountId)).toBe('api_scale');

      // Same call AFTER the entitlement has expired → nothing remaining → free.
      const afterExpiry = await repo.downgradeAccountTierToBestRemaining({
        accountId,
        fallbackTier: 'free',
        at: new Date(paidAt.getTime() + 40 * DAY_MS),
      });
      expect(afterExpiry.appliedTier).toBe('free');
      expect(await accountTier(accountId)).toBe('free');
    });

    it('sweep list/mark: the partial index surfaces expired-unprocessed rows, and marking removes them', async () => {
      if (!dbReachable || !client) return;
      const repo = makeRepo();
      const accountId = await seedAccount('free');
      // Expired grant (paidAt far in the past → expires_at well before asOf).
      await repo.activateCryptoEntitlement({
        accountId,
        orderId: `ord-${randomUUID()}`,
        tier: 'solo_manual',
        paidAt: new Date('2020-01-01T00:00:00.000Z'),
        termDays: 31,
      });
      const asOf = new Date('2026-07-08T00:00:00.000Z');

      const listed = await repo.listExpiredUnprocessedCryptoEntitlements({ asOf, limit: 50 });
      const mine = listed.filter((r) => r.accountId === accountId);
      expect(mine.length).toBe(1);
      expect(mine[0]!.tier).toBe('solo_manual');

      await repo.markCryptoEntitlementsProcessed({ ids: [mine[0]!.id], at: asOf });

      const after = await repo.listExpiredUnprocessedCryptoEntitlements({ asOf, limit: 50 });
      expect(after.filter((r) => r.accountId === accountId).length).toBe(0);
    });
  },
);
