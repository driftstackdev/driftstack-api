// A grandfathered price keeps its plan when the subscription recovers
// (live-billing audit #11).
//
// `DRIFTSTACK_TIER_PRICE_IDS` names one price per plan and interval, so after
// the price ids change, a subscriber still on an OLD price has a price the
// configuration no longer names. The webhook granted nothing for such a price
// and stored the account's current plan as filler. So a grandfathered
// subscriber whose payment failed (dropped to free) and then recovered stayed
// on free, paying, for good — and the recovery even overwrote the mirror's plan
// with that "free".
//
// Now a price the configuration does not name falls back to the plan the
// mirror already holds for THAT subscription, and the plan is granted on it. A
// subscription the mirror has never seen, on a price nobody names, still grants
// nothing (V-742: never 'enterprise', never a move).
//
// Driven through the real StripeWebhooksService — one configured with the old
// price ids, one after they changed — against the Drizzle repo on a Postgres
// rebuilt from the migrations and against the in-memory double.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import {
  StripeWebhooksService,
  type StripeEvent,
  type StripeWebhooksRepo,
} from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';

const ISOLATED_DB_NAME = 'driftstack_iso_grandfathered_price';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let pool: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  pool = createDb(opened.url, { max: 2 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await pool?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

/** The price ids when the customer subscribed… */
const BEFORE = buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_2025_m', annual: 'price_starter_2025_y' },
});
/** …and after the owner moved api_starter to new ones. */
const AFTER = buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_2026_m', annual: 'price_starter_2026_y' },
});

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const DAY_S = 24 * 60 * 60;

interface Subject {
  repo: StripeWebhooksRepo;
  newCustomer: (tier?: AccountTier) => Promise<{ accountId: string; customerId: string }>;
  accountTier: (accountId: string) => Promise<AccountTier | null>;
  mirror: (stripeSubscriptionId: string) => Promise<{ tier: string; status: string } | null>;
}

function drizzleSubject(): Subject {
  if (pool === null) throw new Error('isolated database unreachable');
  return {
    repo: new DrizzleStripeWebhooksRepo(pool),
    newCustomer: async (tier = 'free') => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
                 VALUES (${accountId}::uuid, ${`grandfathered-${accountId}@example.test`},
                         ${tier}::account_tier, ${customerId})`;
      return { accountId, customerId };
    },
    accountTier: async (accountId) => {
      const [row] = await db()<Array<{ tier: AccountTier }>>`
        SELECT tier::text AS tier FROM accounts WHERE id = ${accountId}::uuid`;
      return row?.tier ?? null;
    },
    mirror: async (stripeSubscriptionId) => {
      const [row] = await db()<Array<{ tier: string; status: string }>>`
        SELECT tier::text AS tier, status::text AS status
          FROM subscriptions WHERE stripe_subscription_id = ${stripeSubscriptionId}`;
      return row ?? null;
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
    mirror: (stripeSubscriptionId) => {
      const row = repo
        .listSubscriptions()
        .find((s) => s.stripeSubscriptionId === stripeSubscriptionId);
      return Promise.resolve(row === undefined ? null : { tier: row.tier, status: row.status });
    },
  };
}

function webhooks(s: Subject, maps: typeof BEFORE): StripeWebhooksService {
  return new StripeWebhooksService(s.repo, {
    logger: silent,
    priceToTier: maps.priceToTier,
    priceToInterval: maps.priceToInterval,
  });
}

let seq = 0;
function subscriptionEvent(
  type: 'customer.subscription.created' | 'customer.subscription.updated',
  createdSec: number,
  spec: { id: string; customerId: string; status: string; priceId: string },
): StripeEvent {
  seq += 1;
  return {
    id: `evt_grandfathered_${String(seq)}_${randomUUID()}`,
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
        canceled_at: null,
        current_period_start: createdSec,
        current_period_end: createdSec + 30 * DAY_S,
        items: { data: [{ id: 'si_1', price: { id: spec.priceId } }] },
      },
    },
  };
}

async function deliver(service: StripeWebhooksService, event: StripeEvent): Promise<void> {
  expect(await service.handle(event, JSON.stringify(event))).toBe('handled');
}

describe.skipIf(!RUN_DB_TESTS)(
  'a grandfathered price keeps its plan when the subscription recovers',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const makeSubject of [drizzleSubject, inMemorySubject]) {
      const label = makeSubject === drizzleSubject ? 'Drizzle on Postgres' : 'the in-memory double';

      for (const setback of ['unpaid', 'past_due'] as const) {
        it(`CRITICAL [${label}] the audit's scenario: subscribed on the old price, the price ids change, the payment fails (${setback}), the customer pays — and ends on the paid plan`, async () => {
          const s = makeSubject();
          const { accountId, customerId } = await s.newCustomer();
          const subId = `sub_${randomUUID()}`;
          const now = Math.floor(Date.now() / 1000);
          const spec = { id: subId, customerId, priceId: 'price_starter_2025_m' };

          await deliver(
            webhooks(s, BEFORE),
            subscriptionEvent('customer.subscription.created', now - 60 * DAY_S, {
              ...spec,
              status: 'active',
            }),
          );
          expect(await s.accountTier(accountId)).toBe('api_starter');

          // The price ids move on; this subscriber stays on the old price.
          const after = webhooks(s, AFTER);
          // `unpaid` ends the plan at once; a `past_due` spell that began nine
          // days ago is already past its seven days (audit #3), so it does too.
          const failedAt = setback === 'unpaid' ? now - 3 * DAY_S : now - 9 * DAY_S;
          await deliver(
            after,
            subscriptionEvent('customer.subscription.updated', failedAt, {
              ...spec,
              status: setback,
            }),
          );
          expect(await s.accountTier(accountId)).toBe('free');

          await deliver(
            after,
            subscriptionEvent('customer.subscription.updated', now - 60, {
              ...spec,
              status: 'active',
            }),
          );
          expect(
            await s.accountTier(accountId),
            'a paying grandfathered subscriber was left on free',
          ).toBe('api_starter');
          expect(await s.mirror(subId)).toEqual({ tier: 'api_starter', status: 'active' });
        });
      }

      it(`[${label}] a subscription the mirror has never seen, on a price nobody names, still grants nothing and moves nothing (V-742)`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer('api_starter');
        const subId = `sub_${randomUUID()}`;
        await deliver(
          webhooks(s, AFTER),
          subscriptionEvent('customer.subscription.created', Math.floor(Date.now() / 1000), {
            id: subId,
            customerId,
            status: 'active',
            priceId: 'price_custom_contract',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('api_starter');
        expect(await s.mirror(subId)).toEqual({ tier: 'api_starter', status: 'active' });
      });
    }
  },
);
