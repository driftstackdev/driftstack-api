// V-779 — the crash window between "order is paid" and "entitlement exists", against real Postgres.
//
// The IPN handler is a dual write across TWO transactions: `withOrderLock` commits
// `status='paid'` and returns, then the tier activator runs in its own transaction. A process
// death in between leaves a paying customer with no entitlement and no tier.
//
// It cannot self-heal. `firePaid` is computed from the LOCKED pre-update status, so a
// re-delivered IPN reads `status='paid'`, sets `firePaid = false`, and skips activation, the
// webhook and the receipt email. The handler's comment says so; its alarm only fires when the
// activator THROWS, so an abrupt death raises nothing.
//
// This is a DB-backed test on purpose. `InMemoryCryptoOrdersRepo` has no transaction boundary at
// all, so the window is structurally invisible to it — the fake cannot express the bug, which is
// exactly why it survived. The crash is simulated the only honest way: commit the paid status
// and then simply never call the activator.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleCryptoOrdersRepo } from '../../src/db/crypto-orders-repo.js';
import { CryptoEntitlementReconcileSweeper } from '../../src/services/crypto-entitlement-reconcile-sweeper.js';
import type { Database } from '../../src/db/client.js';
import type {
  CryptoOrderTierActivationIntent,
  CryptoOrderTierActivator,
} from '../../src/services/crypto-orders.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const TEST_SCHEMA = `cx_reconcile_${randomUUID().replaceAll('-', '')}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;
let reachable = false;

const PAID_AT_MS = Date.parse('2026-08-15T09:00:00.000Z');

beforeAll(async () => {
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
    reachable = true;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    return;
  }
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  for (const table of ['accounts', 'crypto_orders', 'crypto_entitlements']) {
    await admin.unsafe(
      `CREATE TABLE "${TEST_SCHEMA}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  client = postgres(DB_URL, { max: 1 });
  db = drizzle(client);
  try {
    await client.unsafe(`SET search_path TO "${TEST_SCHEMA}", public`);
    await client`SELECT 1 FROM crypto_orders LIMIT 0`;
  } catch {
    reachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'paid crypto orders without an entitlement are reconciled (V-779, real Postgres)',
  () => {
    /** Simulates the crash: the paid status is COMMITTED, the activator never runs. */
    async function paidOrderWithNoEntitlement(product = 'api_starter'): Promise<{
      accountId: string;
      orderId: string;
    }> {
      const accountId = randomUUID();
      await client!`
        INSERT INTO accounts (id, email, tier, status)
        VALUES (${accountId}, ${`c-${accountId}@t.test`}, 'free', 'active')`;
      const orderId = `ord_${randomUUID().slice(0, 12)}`;
      await client!`
        INSERT INTO crypto_orders (order_id, account_id, product, price_cents, price_currency,
                                   status, payment_id, events)
        VALUES (${orderId}, ${accountId}, ${product}, 4900, 'usd', 'paid', 'pay_123',
                ${JSON.stringify([{ status: 'paid', at: PAID_AT_MS }])}::text::jsonb)`;
      return { accountId, orderId };
    }

    function sweeper(seen: CryptoOrderTierActivationIntent[], fail = false) {
      const database = {
        client: client!,
        db: db!,
        close: async () => {},
      } as unknown as Database;
      const activator: CryptoOrderTierActivator = {
        activateTierForPaidOrder: (intent: CryptoOrderTierActivationIntent) => {
          seen.push(intent);
          if (fail) return Promise.reject(new Error('activator unavailable'));
          // Mirror the real activator's write so the second tick sees it gone.
          return client!`
            INSERT INTO crypto_entitlements (account_id, order_id, tier, starts_at, expires_at)
            VALUES (${intent.account_id}, ${intent.order_id}, ${intent.product}::account_tier,
                    ${intent.paid_at}, ${new Date(PAID_AT_MS + 31 * 86400000).toISOString()})
            ON CONFLICT (order_id) DO NOTHING`.then(() => undefined);
        },
        clawbackTierForRefundedOrder: () => Promise.resolve(),
      } as CryptoOrderTierActivator;
      return new CryptoEntitlementReconcileSweeper({
        repo: new DrizzleCryptoOrdersRepo(database),
        activator,
      });
    }

    it('CRITICAL a paid order whose entitlement never landed is found and recovered — the IPN cannot re-drive it, because a re-delivery reads status=paid and computes firePaid=false', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const { accountId, orderId } = await paidOrderWithNoEntitlement();

      const seen: CryptoOrderTierActivationIntent[] = [];
      const result = await sweeper(seen).tickOnce();

      expect(result.found, 'the stranded order is visible to the reconciler').toBe(1);
      expect(result.recovered).toBe(1);
      expect(seen[0]?.order_id).toBe(orderId);
      expect(seen[0]?.account_id).toBe(accountId);
      // The intent must carry the ORIGINAL paid timestamp from the events array, not "now" —
      // the entitlement window is 31 days from payment.
      expect(Date.parse(seen[0]!.paid_at)).toBe(PAID_AT_MS);
      expect(seen[0]?.payment_id).toBe('pay_123');
    });

    it('CRITICAL a second tick is a no-op — the reconciler must not re-grant an entitlement that already exists, or a recurring job would extend a customer forever', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      await paidOrderWithNoEntitlement();

      const first: CryptoOrderTierActivationIntent[] = [];
      expect((await sweeper(first).tickOnce()).recovered).toBe(1);

      const second: CryptoOrderTierActivationIntent[] = [];
      const again = await sweeper(second).tickOnce();
      expect(again.found, 'nothing left to reconcile').toBe(0);
      expect(second, 'the activator is not called again').toEqual([]);
    });

    it('CRITICAL orders that are NOT stranded are never touched — a pending order, and a paid one that already has its entitlement', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const acc = randomUUID();
      await client!`
        INSERT INTO accounts (id, email, tier, status)
        VALUES (${acc}, ${`c-${acc}@t.test`}, 'free', 'active')`;
      // pending, not paid
      await client!`
        INSERT INTO crypto_orders (order_id, account_id, product, price_cents, price_currency,
                                   status, events)
        VALUES (${`ord_${randomUUID().slice(0, 12)}`}, ${acc}, 'api_starter', 4900, 'usd',
                'pending', '[]'::jsonb)`;
      // paid AND already entitled
      const done = `ord_${randomUUID().slice(0, 12)}`;
      await client!`
        INSERT INTO crypto_orders (order_id, account_id, product, price_cents, price_currency,
                                   status, events)
        VALUES (${done}, ${acc}, 'api_starter', 4900, 'usd', 'paid', '[]'::jsonb)`;
      await client!`
        INSERT INTO crypto_entitlements (account_id, order_id, tier, starts_at, expires_at)
        VALUES (${acc}, ${done}, 'api_starter', now(), now() + interval '31 days')`;

      const seen: CryptoOrderTierActivationIntent[] = [];
      const result = await sweeper(seen).tickOnce();
      expect(result.found, 'neither row qualifies').toBe(0);
      expect(seen).toEqual([]);
    });

    it('a failing activator alarms and leaves the order for the next tick rather than dropping it', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      await paidOrderWithNoEntitlement();

      const seen: CryptoOrderTierActivationIntent[] = [];
      const result = await sweeper(seen, true).tickOnce();
      expect(result.found).toBe(1);
      expect(result.recovered).toBe(0);
      expect(result.failed, 'the failure is counted, not swallowed').toBe(1);

      // Still stranded, so the next tick retries it — the work is not lost.
      const retry: CryptoOrderTierActivationIntent[] = [];
      expect((await sweeper(retry).tickOnce()).found).toBe(1);
    });
  },
);
