// A refunded crypto order leaves no term it did not pay for (security sweep
// 2026-09-24, findings #28 and #29).
//
// #28 — a same-tier repurchase is STACKED: order B's term starts when order A's
// ends. A refund of A brought only A's own expiry forward to the refund; B kept
// its future window, and both tier recomputes counted any term with
// expires_at > now whatever its start, so B took effect at once and ran to its
// original stacked end: about 61 days of the plan for one 31-day payment. A
// refund now moves every later same-tier term back by what the refunded term
// had left, in the same transaction, and a term that has not started does not
// hold the plan.
//
// #29 — a refund IPN on a paid order changes nothing on the order (paid is
// terminal) and only expires the order's entitlement. When activation had
// failed, there was no entitlement to expire, so the refund left no trace, and
// the hourly reconciler — which picks every paid order with no entitlement —
// later granted a full term for the refunded payment. A refund that finds no
// entitlement now records an already-ended one for the order, so neither the
// reconciler nor a late activation can grant it.
//
// Real DrizzleStripeWebhooksRepo, DrizzleCryptoOrdersRepo, CryptoOrdersService,
// CryptoTierActivationService and CryptoEntitlementReconcileSweeper on a Postgres
// rebuilt from the migrations. No payment provider is called.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCryptoOrdersRepo } from '../../src/db/crypto-orders-repo.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { CryptoEntitlementReconcileSweeper } from '../../src/services/crypto-entitlement-reconcile-sweeper.js';
import {
  CryptoOrdersService,
  type CryptoOrderTierActivationIntent,
  type CryptoOrderTierActivator,
} from '../../src/services/crypto-orders.js';
import {
  CRYPTO_ENTITLEMENT_TERM_DAYS,
  CryptoTierActivationService,
} from '../../src/services/crypto-tier-activation.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_crypto_refund_terms';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

const DAY_MS = 24 * 60 * 60 * 1000;
const TERM_MS = CRYPTO_ENTITLEMENT_TERM_DAYS * DAY_MS;

let client: postgres.Sql | null = null;
let pool: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  pool = createDb(opened.url, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await pool?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function database(): Database {
  if (pool === null) throw new Error('isolated database unreachable');
  return pool;
}

async function newAccount(tier: AccountTier = 'free'): Promise<string> {
  const id = randomUUID();
  await db()`INSERT INTO accounts (id, email, tier)
             VALUES (${id}::uuid, ${`refund-${id}@example.test`}, ${tier}::account_tier)`;
  return id;
}

async function tierOf(accountId: string): Promise<AccountTier | null> {
  const [row] = await db()<Array<{ tier: AccountTier }>>`
    SELECT tier::text AS tier FROM accounts WHERE id = ${accountId}::uuid`;
  return row?.tier ?? null;
}

async function termOf(orderId: string): Promise<{ startsAt: Date; expiresAt: Date }> {
  const [row] = await db()<Array<{ starts_at: Date | string; expires_at: Date | string }>>`
    SELECT starts_at, expires_at FROM crypto_entitlements WHERE order_id = ${orderId}`;
  if (row === undefined) throw new Error(`no entitlement for ${orderId}`);
  return { startsAt: new Date(row.starts_at), expiresAt: new Date(row.expires_at) };
}

async function entitlementsOf(orderId: string): Promise<number> {
  const [row] = await db()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM crypto_entitlements WHERE order_id = ${orderId}`;
  return row?.n ?? 0;
}

function activation(): CryptoTierActivationService {
  return new CryptoTierActivationService(
    new DrizzleStripeWebhooksRepo(database()),
    createTestLogger(),
  );
}

function orderId(): string {
  return `ord_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function paid(
  activator: CryptoTierActivationService,
  accountId: string,
  order: string,
  paidAt: Date,
  product: AccountTier = 'api_scale',
): Promise<void> {
  await activator.activateTierForPaidOrder({
    account_id: accountId,
    order_id: order,
    product,
    payment_id: `pay_${order}`,
    paid_at: paidAt.toISOString(),
  });
}

/** Milliseconds between two instants, for "about N days" assertions. */
function spanMs(from: Date, to: Date): number {
  return to.getTime() - from.getTime();
}

const MINUTE_MS = 60 * 1000;

describe.skipIf(!RUN_DB_TESTS)('a refunded crypto order leaves no term it did not pay for', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL #28 refunding the FIRST of two stacked same-tier terms leaves the second running for its own 31 days from the refund, not to its original stacked end', async () => {
    const accountId = await newAccount();
    const activator = activation();
    const a = orderId();
    const b = orderId();
    const now = new Date();
    await paid(activator, accountId, a, new Date(now.getTime() - DAY_MS));
    await paid(activator, accountId, b, now);
    const stacked = await termOf(b);
    expect(spanMs(now, stacked.expiresAt), 'B was stacked onto A').toBeGreaterThan(59 * DAY_MS);

    const refundAt = new Date();
    const outcome = await activator.revokeTierForRefundedOrder({
      account_id: accountId,
      order_id: a,
      at: refundAt,
    });

    expect(outcome.revoked).toBe(true);
    expect(await tierOf(accountId), 'B still pays for the plan').toBe('api_scale');
    const after = await termOf(b);
    expect(
      Math.abs(spanMs(refundAt, after.startsAt)),
      `B starts at the refund, not at A's original end (starts ${after.startsAt.toISOString()})`,
    ).toBeLessThan(MINUTE_MS);
    expect(
      Math.abs(spanMs(refundAt, after.expiresAt) - TERM_MS),
      `one payment buys one term: B ends 31 days after the refund (ends ${after.expiresAt.toISOString()})`,
    ).toBeLessThan(MINUTE_MS);
    const refunded = await termOf(a);
    expect(refunded.expiresAt.getTime()).toBe(refundAt.getTime());
  });

  it('CRITICAL #28 refunding a stacked term that has not started moves the terms after it up, and leaves the running one alone', async () => {
    const accountId = await newAccount();
    const activator = activation();
    const a = orderId();
    const b = orderId();
    const c = orderId();
    const now = new Date();
    await paid(activator, accountId, a, new Date(now.getTime() - 2 * DAY_MS));
    await paid(activator, accountId, b, new Date(now.getTime() - DAY_MS));
    await paid(activator, accountId, c, now);
    const aBefore = await termOf(a);
    const cBefore = await termOf(c);

    const outcome = await activator.revokeTierForRefundedOrder({
      account_id: accountId,
      order_id: b,
      at: new Date(),
    });

    expect(outcome.revoked).toBe(true);
    expect(await tierOf(accountId)).toBe('api_scale');
    const aAfter = await termOf(a);
    expect(aAfter.expiresAt.getTime(), 'the running term is untouched').toBe(
      aBefore.expiresAt.getTime(),
    );
    const cAfter = await termOf(c);
    expect(cAfter.startsAt.getTime(), 'C now starts where A ends').toBe(
      aBefore.expiresAt.getTime(),
    );
    expect(cAfter.expiresAt.getTime()).toBe(cBefore.expiresAt.getTime() - TERM_MS);
    const bAfter = await termOf(b);
    expect(bAfter.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(bAfter.startsAt.getTime()).toBeLessThanOrEqual(bAfter.expiresAt.getTime());
  });

  it('CRITICAL #28 a replayed refund IPN moves nothing a second time', async () => {
    const accountId = await newAccount();
    const activator = activation();
    const a = orderId();
    const b = orderId();
    const now = new Date();
    await paid(activator, accountId, a, new Date(now.getTime() - DAY_MS));
    await paid(activator, accountId, b, now);
    await activator.revokeTierForRefundedOrder({
      account_id: accountId,
      order_id: a,
      at: new Date(),
    });
    const once = await termOf(b);

    const again = await activator.revokeTierForRefundedOrder({
      account_id: accountId,
      order_id: a,
      at: new Date(Date.now() + 1000),
    });

    expect(again.revoked).toBe(false);
    const twice = await termOf(b);
    expect(twice.startsAt.getTime()).toBe(once.startsAt.getTime());
    expect(twice.expiresAt.getTime()).toBe(once.expiresAt.getTime());
  });

  it('CRITICAL #28 a term that has not started does not hold the plan in either tier recompute', async () => {
    const accountId = await newAccount('api_scale');
    await db()`INSERT INTO crypto_entitlements (account_id, order_id, tier, starts_at, expires_at)
                 VALUES (${accountId}::uuid, ${orderId()}, 'api_scale'::account_tier,
                         now() + interval '10 days', now() + interval '41 days')`;
    const repo = new DrizzleStripeWebhooksRepo(database());

    const down = await repo.downgradeAccountTierToBestRemaining({
      accountId,
      fallbackTier: 'free',
      at: new Date(),
    });
    expect(down.appliedTier, 'a future term held the plan').toBe('free');

    await repo.upsertSubscription({
      accountId,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripePriceId: 'price_starter_m',
      tier: 'api_starter',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      at: new Date(),
    });
    const best = await repo.setAccountTierToBestActive({ accountId, at: new Date() });
    expect(best.appliedTier, 'a future term outranked the paying subscription').toBe('api_starter');
  });

  it('control: a single refunded term with nothing stacked after it drops the account to free', async () => {
    const accountId = await newAccount();
    const activator = activation();
    const a = orderId();
    await paid(activator, accountId, a, new Date(Date.now() - DAY_MS));
    expect(await tierOf(accountId)).toBe('api_scale');

    await activator.revokeTierForRefundedOrder({
      account_id: accountId,
      order_id: a,
      at: new Date(),
    });

    expect(await tierOf(accountId)).toBe('free');
  });

  describe('#29 a refund that lands before the entitlement exists', () => {
    /** The real activator, wrapped so its FIRST activation fails (a database blip). */
    function flakyActivator(real: CryptoTierActivationService): CryptoOrderTierActivator & {
      failures: number;
    } {
      let failNext = true;
      const wrapped = {
        failures: 0,
        activateTierForPaidOrder: (intent: CryptoOrderTierActivationIntent) => {
          if (failNext) {
            failNext = false;
            wrapped.failures += 1;
            return Promise.reject(new Error('connection terminated unexpectedly'));
          }
          return real.activateTierForPaidOrder(intent);
        },
        revokeTierForRefundedOrder: (
          args: Parameters<CryptoOrderTierActivator['revokeTierForRefundedOrder']>[0],
        ) => real.revokeTierForRefundedOrder(args),
      };
      return wrapped;
    }

    async function paidOrderWhoseActivationFailed(): Promise<{
      accountId: string;
      order: string;
      service: CryptoOrdersService;
      real: CryptoTierActivationService;
    }> {
      const accountId = await newAccount();
      const real = activation();
      const activator = flakyActivator(real);
      const service = new CryptoOrdersService({
        repo: new DrizzleCryptoOrdersRepo(database()),
        tierActivator: activator,
        logger: { error: () => {}, warn: () => {} },
      });
      const order = orderId();
      await service.create({
        order_id: order,
        account_id: accountId,
        product: 'api_scale',
        price_cents: 149_900,
        price_currency: 'USD',
      });
      await service.recordPaymentId({ order_id: order, payment_id: `pay_${order}` });
      await service.applyIpnStatus({
        order_id: order,
        payment_id: `pay_${order}`,
        provider_status: 'finished',
      });
      expect(activator.failures, 'the activation failed once').toBe(1);
      expect(await tierOf(accountId)).toBe('free');
      expect(await entitlementsOf(order)).toBe(0);
      return { accountId, order, service, real };
    }

    it('CRITICAL the hourly reconciler does not grant a term for an order refunded before its entitlement existed', async () => {
      const { accountId, order, service, real } = await paidOrderWhoseActivationFailed();

      await service.applyIpnStatus({
        order_id: order,
        payment_id: `pay_${order}`,
        provider_status: 'refunded',
      });
      const sweeper = new CryptoEntitlementReconcileSweeper({
        repo: new DrizzleCryptoOrdersRepo(database()),
        activator: real,
      });
      const tick = await sweeper.tickOnce();

      expect(tick.recovered, 'the reconciler recovered a refunded order').toBe(0);
      expect(await tierOf(accountId), 'a refunded payment bought the plan').toBe('free');
      const [running] = await db()<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM crypto_entitlements
           WHERE account_id = ${accountId}::uuid AND expires_at > now()`;
      expect(running?.n).toBe(0);
    });

    it('CRITICAL a late activation of the refunded order grants nothing', async () => {
      const { accountId, order, service, real } = await paidOrderWhoseActivationFailed();
      await service.applyIpnStatus({
        order_id: order,
        payment_id: `pay_${order}`,
        provider_status: 'refunded',
      });

      await paid(real, accountId, order, new Date());

      expect(await tierOf(accountId)).toBe('free');
    });

    it('control: without a refund, the reconciler still recovers the stranded paid order', async () => {
      const { accountId, order, real } = await paidOrderWhoseActivationFailed();
      const sweeper = new CryptoEntitlementReconcileSweeper({
        repo: new DrizzleCryptoOrdersRepo(database()),
        activator: real,
      });

      await sweeper.tickOnce();

      expect(await tierOf(accountId)).toBe('api_scale');
      expect(await entitlementsOf(order)).toBe(1);
    });
  });
});
