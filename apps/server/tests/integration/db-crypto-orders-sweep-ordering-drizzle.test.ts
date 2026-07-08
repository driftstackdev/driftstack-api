// Drizzle-backed integration test for DrizzleCryptoOrdersRepo.listPendingOlderThan
// — the crypto-order expiry-sweep query — against a REAL Postgres.
//
// Fix 4d308f52 added this oldest-first query so the sweep drains the
// longest-pending orders first (and the per-tick cap keys off scan-fill,
// not flip-count). It shipped validated by the in-memory twin + typecheck;
// the build-test app uses the in-memory impl, so the Drizzle SQL (status
// filter + createdAt<=cutoff + ORDER BY createdAt ASC) had no real-Postgres
// coverage. This pins it on real PG: only PENDING orders at/older than the
// cutoff are returned, oldest-first; recent + non-pending orders excluded.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.
//
// crypto_orders has a nullable account_id (no FK chain needed) and a text
// order_id PK, so rows are seeded directly under a unique id prefix and the
// result is filtered to that prefix (the CI DB is shared across tests).

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleCryptoOrdersRepo } from '../../src/db/crypto-orders-repo.js';
import type { CryptoOrder } from '../../src/services/crypto-orders.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededPrefixes: string[] = [];

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
    await client`SELECT 1 FROM crypto_orders LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const prefix of seededPrefixes) {
      await client`DELETE FROM crypto_orders WHERE order_id LIKE ${prefix + '%'}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleCryptoOrdersRepo.listPendingOlderThan (Drizzle path against real Postgres)',
  () => {
    it('returns only PENDING orders at/older than the cutoff, oldest-first', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleCryptoOrdersRepo({ client, db, close: async () => {} });

      const prefix = `swp_${randomUUID().slice(0, 8)}_`;
      seededPrefixes.push(prefix);

      const cutoff = Date.UTC(2026, 0, 1, 12, 0, 0);
      const HOUR = 3_600_000;
      async function seed(suffix: string, status: string, createdAtMs: number): Promise<string> {
        const orderId = prefix + suffix;
        const at = new Date(createdAtMs);
        await client!`
          INSERT INTO crypto_orders
            (order_id, product, price_cents, price_currency, status, events, created_at, updated_at)
          VALUES (${orderId}, 'solo_manual', 7900, 'EUR', ${status}, '[]'::jsonb, ${at.toISOString()}, ${at.toISOString()})`;
        return orderId;
      }

      // 3 pending + older than cutoff (distinct times) → expected oldest-first.
      const oldA = await seed('old_a', 'pending', cutoff - 3 * HOUR);
      const oldB = await seed('old_b', 'pending', cutoff - 2 * HOUR);
      const oldC = await seed('old_c', 'pending', cutoff - 1 * HOUR);
      // pending but created AFTER the cutoff → excluded (createdAt > olderThan).
      await seed('recent', 'pending', cutoff + 1 * HOUR);
      // older than cutoff but NOT pending → excluded by the status filter.
      await seed('paid', 'paid', cutoff - 5 * HOUR);

      // High limit so our rows aren't paged out behind sibling-test rows in
      // the shared CI DB; filter to our prefix before asserting.
      const rows = await repo.listPendingOlderThan({ olderThan: cutoff, limit: 100_000 });
      const ours = rows.filter((r) => r.order_id.startsWith(prefix));

      // Only the 3 pending-and-old orders, oldest createdAt first.
      expect(ours.map((r) => r.order_id)).toEqual([oldA, oldB, oldC]);
    });
  },
);

// Fable audit-2 2026-07-08 (C6) — the idempotency_key unique index is PARTIAL
// (WHERE idempotency_key IS NOT NULL). insertWithIdempotencyKey's ON CONFLICT
// must carry that same predicate or real Postgres raises 42P10 and EVERY
// idempotent crypto checkout 500s. This only reproduces against real Postgres
// (pglite/in-memory twins don't enforce partial-index arbiter matching), so it
// lives in the real-PG integration block alongside the sweep test.
describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleCryptoOrdersRepo.insertWithIdempotencyKey (partial-index ON CONFLICT against real Postgres — C6)',
  () => {
    function makeOrder(orderId: string): CryptoOrder {
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      return {
        order_id: orderId,
        account_id: null,
        product: 'solo_manual',
        price_cents: 7900,
        price_currency: 'EUR',
        payment_id: null,
        pay_amount: null,
        pay_currency: null,
        status: 'pending',
        customer_note: null,
        internal_note: null,
        events: [],
        created_at: now,
        updated_at: now,
      };
    }

    it('inserts with an Idempotency-Key without a 42P10, then replays the SAME stored order on a same-key retry', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleCryptoOrdersRepo({ client, db, close: async () => {} });

      const prefix = `idem_${randomUUID().slice(0, 8)}_`;
      seededPrefixes.push(prefix);
      const key = `${prefix}scoped_key`;

      // Before the C6 fix this call threw 42P10 (ON CONFLICT with no predicate
      // against the partial unique index) — a hard 500 on every keyed checkout.
      const first = await repo.insertWithIdempotencyKey(makeOrder(`${prefix}first`), key);
      expect(first.replayed).toBe(false);
      expect(first.order.order_id).toBe(`${prefix}first`);

      // A retry with the SAME scoped key but a fresh envelope must REPLAY the
      // stored order (the ON CONFLICT DO NOTHING → SELECT path), never mint a
      // second row.
      const retry = await repo.insertWithIdempotencyKey(makeOrder(`${prefix}second`), key);
      expect(retry.replayed).toBe(true);
      expect(retry.order.order_id).toBe(`${prefix}first`);
    });
  },
);
