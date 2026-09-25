// A subscription updated to `canceled` takes the plan away, even when its
// `deleted` event arrives late (security sweep 2026-09-24, finding #30).
//
// `customer.subscription.updated` carrying a terminal status (`canceled`, or
// `incomplete_expired`) was mirrored with no tier recompute: the only downgrade
// for a cancellation lived in the `deleted` handler. When the `deleted` delivery
// failed and Stripe retried it after a later `updated` for the same, already
// cancelled subscription had been processed (Stripe allows metadata and
// cancellation_details edits on a cancelled subscription), the recency guard
// skipped the retried `deleted` as stale — and nothing ever downgraded the
// account. An applied `updated` that lands in a terminal status now recomputes
// the tier the way `deleted` does.
//
// It recomputes only while the stored row still held the plan. Once the
// cancellation has been applied, a later edit to the same cancelled
// subscription gave nothing and takes nothing: a plan staff set after the
// cancellation stays.
//
// Driven through the real StripeWebhooksService against the Drizzle repo on a
// Postgres rebuilt from the migrations and against the in-memory double.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import {
  StripeWebhooksService,
  type StripeEvent,
  type StripeWebhooksRepo,
} from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';

const ISOLATED_DB_NAME = 'driftstack_iso_updated_to_canceled';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

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

const MAPS = buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
  api_scale: { monthly: 'price_scale_m', annual: 'price_scale_y' },
});

const DAY_S = 24 * 60 * 60;

interface Subject {
  repo: StripeWebhooksRepo;
  /** A Stripe customer whose account is on `tier` (free unless given). */
  newCustomer: (tier?: AccountTier) => Promise<{ accountId: string; customerId: string }>;
  accountTier: (accountId: string) => Promise<AccountTier | null>;
  subscriptionStatus: (stripeSubscriptionId: string) => Promise<string | null>;
  /** Staff set the account's plan directly; no subscription or crypto term pays for it. */
  setPlanOutsideStripe: (accountId: string, tier: AccountTier) => Promise<void>;
}

function drizzleSubject(): Subject {
  if (pool === null) throw new Error('isolated database unreachable');
  const repo = new DrizzleStripeWebhooksRepo(pool);
  return {
    repo,
    newCustomer: async (tier = 'free') => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
                 VALUES (${accountId}::uuid, ${`canceled-${accountId}@example.test`},
                         ${tier}::account_tier, ${customerId})`;
      return { accountId, customerId };
    },
    accountTier: async (accountId) => {
      const [row] = await db()<Array<{ tier: AccountTier }>>`
        SELECT tier::text AS tier FROM accounts WHERE id = ${accountId}::uuid`;
      return row?.tier ?? null;
    },
    subscriptionStatus: async (id) => (await repo.findSubscription(id))?.status ?? null,
    setPlanOutsideStripe: async (accountId, tier) => {
      await db()`UPDATE accounts SET tier = ${tier}::account_tier WHERE id = ${accountId}::uuid`;
    },
  };
}

function inMemorySubject(): Subject {
  const repo = new InMemoryStripeWebhooksRepo();
  return {
    repo,
    newCustomer: (tier = 'free') => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      repo.registerAccount({ accountId, stripeCustomerId: customerId, tier });
      return Promise.resolve({ accountId, customerId });
    },
    accountTier: (accountId) => Promise.resolve(repo.readAccount(accountId)?.tier ?? null),
    subscriptionStatus: async (id) => (await repo.findSubscription(id))?.status ?? null,
    setPlanOutsideStripe: async (accountId, tier) => {
      await repo.setAccountTier({ accountId, tier, at: new Date() });
    },
  };
}

let seq = 0;
function subscriptionEvent(
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted',
  createdSec: number,
  spec: {
    id: string;
    customerId: string;
    status: string;
    priceId: string;
    /** When the subscription was cancelled; defaults to this event's time. */
    canceledAtSec?: number;
  },
): StripeEvent {
  seq += 1;
  return {
    id: `evt_updated_canceled_${String(seq)}_${randomUUID()}`,
    type,
    created: createdSec,
    livemode: false,
    data: {
      object: {
        id: spec.id,
        object: 'subscription',
        customer: spec.customerId,
        status: spec.status,
        cancel_at_period_end: false,
        canceled_at: spec.status === 'canceled' ? (spec.canceledAtSec ?? createdSec) : null,
        current_period_start: createdSec - 5 * DAY_S,
        current_period_end: createdSec + 25 * DAY_S,
        items: { data: [{ id: 'si_1', price: { id: spec.priceId } }] },
      },
    },
  };
}

function service(s: Subject): StripeWebhooksService {
  return new StripeWebhooksService(s.repo, {
    logger: createTestLogger(),
    priceToTier: MAPS.priceToTier,
    priceToInterval: MAPS.priceToInterval,
  });
}

async function deliver(webhooks: StripeWebhooksService, event: StripeEvent): Promise<void> {
  expect(await webhooks.handle(event, JSON.stringify(event))).toBe('handled');
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** An api_scale subscription created ten days ago, so the account is on api_scale. */
async function payingAccount(
  s: Subject,
  webhooks: StripeWebhooksService,
): Promise<{ accountId: string; customerId: string; sub: string }> {
  const { accountId, customerId } = await s.newCustomer();
  const sub = `sub_${randomUUID()}`;
  await deliver(
    webhooks,
    subscriptionEvent('customer.subscription.created', nowSec() - 10 * DAY_S, {
      id: sub,
      customerId,
      status: 'active',
      priceId: 'price_scale_m',
    }),
  );
  expect(await s.accountTier(accountId)).toBe('api_scale');
  return { accountId, customerId, sub };
}

describe.skipIf(!RUN_DB_TESTS)(
  'a subscription updated to canceled takes the plan away, even when its deleted event arrives late',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const makeSubject of [drizzleSubject, inMemorySubject]) {
      const label = makeSubject === drizzleSubject ? 'Drizzle on Postgres' : 'the in-memory double';

      it(`CRITICAL [${label}] an updated event with status=canceled, followed by a deleted event that is older (a retried delivery), leaves the account on the free plan`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        const now = nowSec();

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', now - 5, {
            id: sub,
            customerId,
            status: 'canceled',
            priceId: 'price_scale_m',
          }),
        );
        // The deleted delivery failed earlier and Stripe retries it now: its
        // event time is older than the updated event already applied.
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.deleted', now - 6, {
            id: sub,
            customerId,
            status: 'canceled',
            priceId: 'price_scale_m',
          }),
        );

        expect(await s.subscriptionStatus(sub)).toBe('canceled');
        expect(
          await s.accountTier(accountId),
          'a cancelled subscription left the account on its paid plan',
        ).toBe('free');
      });

      it(`CRITICAL [${label}] an updated event with status=canceled takes the plan away on its own`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 5, {
            id: sub,
            customerId,
            status: 'canceled',
            priceId: 'price_scale_m',
          }),
        );

        expect(await s.accountTier(accountId)).toBe('free');
      });

      it(`CRITICAL [${label}] an updated event with status=incomplete_expired takes a plan it granted away`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 5, {
            id: sub,
            customerId,
            status: 'incomplete_expired',
            priceId: 'price_scale_m',
          }),
        );

        expect(await s.accountTier(accountId)).toBe('free');
      });

      it(`CRITICAL [${label}] a checkout whose first payment never succeeded expires without touching a plan set outside Stripe`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        // The plan was set by staff; no subscription or crypto term pays for it.
        const { accountId, customerId } = await s.newCustomer('api_scale');
        const sub = `sub_${randomUUID()}`;
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.created', nowSec() - DAY_S, {
            id: sub,
            customerId,
            status: 'incomplete',
            priceId: 'price_starter_m',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('api_scale');

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 5, {
            id: sub,
            customerId,
            status: 'incomplete_expired',
            priceId: 'price_starter_m',
          }),
        );

        expect(await s.subscriptionStatus(sub)).toBe('incomplete_expired');
        expect(
          await s.accountTier(accountId),
          'a subscription that never granted anything took away a plan it did not give',
        ).toBe('api_scale');
      });

      it(`CRITICAL [${label}] a later edit to a subscription deleted days ago leaves a plan staff set after the cancellation`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        const cancelledAt = nowSec() - 5 * DAY_S;
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.deleted', cancelledAt, {
            id: sub,
            customerId,
            status: 'canceled',
            priceId: 'price_scale_m',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('free');

        // Enterprise moves are made after cancelling.
        await s.setPlanOutsideStripe(accountId, 'enterprise');
        // Stripe allows metadata and cancellation_details edits on a cancelled
        // subscription; each one is a customer.subscription.updated.
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
            id: sub,
            customerId,
            status: 'canceled',
            priceId: 'price_scale_m',
            canceledAtSec: cancelledAt,
          }),
        );

        expect(await s.subscriptionStatus(sub)).toBe('canceled');
        expect(
          await s.accountTier(accountId),
          'an edit to a long-cancelled subscription took away a plan staff set after it',
        ).toBe('enterprise');
      });

      it(`CRITICAL [${label}] a later edit to a subscription cancelled by an update leaves a plan staff set after the cancellation`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        const cancelledAt = nowSec() - 5 * DAY_S;
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', cancelledAt, {
            id: sub,
            customerId,
            status: 'canceled',
            priceId: 'price_scale_m',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('free');

        await s.setPlanOutsideStripe(accountId, 'enterprise');
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
            id: sub,
            customerId,
            status: 'canceled',
            priceId: 'price_scale_m',
            canceledAtSec: cancelledAt,
          }),
        );

        expect(
          await s.accountTier(accountId),
          'an edit to a long-cancelled subscription took away a plan staff set after it',
        ).toBe('enterprise');
      });

      it(`[${label}] control: another subscription still active keeps its plan when one is updated to canceled`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        const other = `sub_${randomUUID()}`;
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.created', nowSec() - 3 * DAY_S, {
            id: other,
            customerId,
            status: 'active',
            priceId: 'price_starter_m',
          }),
        );

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 5, {
            id: sub,
            customerId,
            status: 'canceled',
            priceId: 'price_scale_m',
          }),
        );

        expect(await s.accountTier(accountId)).toBe('api_starter');
      });
    }
  },
);
