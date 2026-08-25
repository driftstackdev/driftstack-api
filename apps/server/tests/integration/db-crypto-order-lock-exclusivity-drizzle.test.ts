// `withOrderLock` must actually serialise two concurrent IPNs, on real Postgres.
//
// This is the crypto money path's idempotency. Unlike Stripe's — which is an
// INSERT … ON CONFLICT DO NOTHING keyed on the event id — an IPN carries no unique
// event identity, so the order row itself is the lock:
//
//   tx.select().from(cryptoOrders).where(eq(orderId)).for('update')
//
// The source states the defect it fixed, and it is the one this file reproduces:
// "Previously the read-modify-write was unlocked: two same-order IPNs both read
// pre-paid, both upserted, both fired the webhook + receipt email."
//
// Coverage before this: the only test that races two `applyIpnStatus` calls is a
// UNIT test against the in-memory repo. That cannot establish the property —
// JavaScript is single-threaded, so an in-memory "lock" is trivially exclusive and
// would pass identically with `.for('update')` deleted.
//
// ⚠️ The trap this test has to avoid is its own harness. A `postgres()` client with
// `max: 1` serialises the two calls in the CONNECTION POOL, so the assertions
// would hold with no row lock at all — a green that proves the pool works. Two
// independent clients are therefore mandatory here, and the first arm asserts they
// really are distinct backends before the race arm runs.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleCryptoOrdersRepo } from '../../src/db/crypto-orders-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let a: ReturnType<typeof postgres> | null = null;
let b: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

function repoFor(sqlClient: ReturnType<typeof postgres>): DrizzleCryptoOrdersRepo {
  const db = drizzle(sqlClient) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return new DrizzleCryptoOrdersRepo({ client: sqlClient, db, close: async () => {} });
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // Two SEPARATE clients: one pooled connection each, so the race is decided by
  // the database rather than by a queue inside this process.
  a = postgres(DB_URL, { max: 1 });
  b = postgres(DB_URL, { max: 1 });
  try {
    await a`SELECT 1 FROM crypto_orders LIMIT 0`;
  } catch {
    await a.end({ timeout: 1 }).catch(() => {});
    await b.end({ timeout: 1 }).catch(() => {});
    a = null;
    b = null;
  }
});

afterAll(async () => {
  if (a) {
    for (const orderId of seeded) {
      await a`DELETE FROM crypto_orders WHERE order_id = ${orderId}`.catch(() => {});
    }
    await a.end({ timeout: 5 });
  }
  if (b) await b.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'crypto order lock exclusivity (real Postgres)',
  () => {
    it('the two clients are distinct backends — otherwise the race below is decided by a connection pool and proves nothing', async () => {
      if (!a || !b) {
        if (process.env.CI) {
          throw new Error(
            'real-PG crypto-lock test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const [pidA] = await a<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      const [pidB] = await b<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      expect(pidA?.pid).toBeDefined();
      expect(pidB?.pid).not.toBe(pidA?.pid);
    });

    it("CRITICAL two concurrent IPNs on one order serialise: the second sees the first's COMMITTED status, so only one can make the paid transition. Without the row lock both read pre-paid and both fire the webhook and the receipt email — the exact defect the lock was added for.", async () => {
      if (!a || !b) {
        if (process.env.CI) {
          throw new Error(
            'real-PG crypto-lock test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const orderId = `ord_${randomUUID().replaceAll('-', '')}`;
      seeded.push(orderId);
      await a`
        INSERT INTO crypto_orders (order_id, product, price_cents, price_currency, status, events)
        VALUES (${orderId}, 'tier_upgrade', 5000, 'usd', 'pending', ${a.json([])})`;

      // Each side reports the status it OBSERVED under its own lock. The first to
      // acquire sees 'pending' and commits 'paid'; the second must then observe
      // 'paid' rather than the stale row it would have read without the lock.
      const observe = async (
        client: ReturnType<typeof postgres>,
        writePaid: boolean,
      ): Promise<string | null> =>
        repoFor(client).withOrderLock(orderId, (order) => ({
          updated: writePaid ? { ...order, status: 'paid' } : null,
          result: order.status,
        }));

      const [first, second] = await Promise.all([observe(a, true), observe(b, true)]);
      const observed = [first, second].sort();

      expect(
        observed,
        'one side must see the pre-paid row and the other its committed result',
      ).toEqual(['paid', 'pending']);

      const [row] = await a<Array<{ status: string }>>`
        SELECT status FROM crypto_orders WHERE order_id = ${orderId}`;
      expect(row?.status).toBe('paid');
    });

    it('CRITICAL the lock cannot carry an ownership change: a callback that returns a DIFFERENT account_id does not move the order. `account_id` is nullable with no foreign key, so before V-1649 the database would have accepted a wrong owner silently — the row lock protects against concurrency, not against authorship.', async () => {
      if (!a) {
        if (process.env.CI) {
          throw new Error(
            'real-PG crypto-lock test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const orderId = `ord_${randomUUID().replaceAll('-', '')}`;
      seeded.push(orderId);
      await a`
        INSERT INTO crypto_orders (order_id, product, price_cents, price_currency, status, events)
        VALUES (${orderId}, 'tier_upgrade', 5000, 'usd', 'pending', '[]'::jsonb)`;

      const [before] = await a<Array<{ account_id: string | null }>>`
        SELECT account_id FROM crypto_orders WHERE order_id = ${orderId}`;
      expect(before?.account_id, 'seeded unowned, so a write would be visible').toBeNull();

      // A callback that does NOT spread the locked row, which is exactly the
      // mistake the SET clause used to trust every caller not to make.
      const hijacker = randomUUID();
      const status = await repoFor(a).withOrderLock(orderId, (order) => ({
        updated: { ...order, account_id: hijacker, status: 'paid' as const },
        result: order.status,
      }));
      expect(status, 'the callback ran against the locked row').toBe('pending');

      const [after] = await a<Array<{ account_id: string | null; status: string }>>`
        SELECT account_id, status FROM crypto_orders WHERE order_id = ${orderId}`;
      // The rest of the update lands...
      expect(after?.status, 'the legitimate half of the write still applies').toBe('paid');
      // ...and the ownership change does not.
      expect(after?.account_id, 'account_id is not writable through the lock').toBeNull();
    });
  },
);
