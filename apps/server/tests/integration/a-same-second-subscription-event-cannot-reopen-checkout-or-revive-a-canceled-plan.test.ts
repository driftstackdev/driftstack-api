// A same-second subscription event cannot reopen checkout or revive a canceled
// plan (live-billing audit #2).
//
// Stripe stamps an event's `created` in WHOLE SECONDS and does not promise to
// deliver in order. The subscription mirror's recency guard compares those
// stamps, so two events of one subscription that share a second used to be
// settled by whichever was PROCESSED last:
//
//   · CHECKOUT. Checkout sends `customer.subscription.created` (incomplete) and
//     `customer.subscription.updated` (active) in the same second. Processed the
//     other way round — a reorder, or a redelivery after a transient 500 — the
//     mirror went back to `incomplete`. The customer is paying, but nothing
//     counted the subscription any more: checkout reopened (a second Stripe
//     subscription, double billing), the billing page said "incomplete" and a
//     suspension would not pause it.
//   · AFTER A CANCEL. A same-second `updated` (active) processed after the
//     `deleted` brought the canceled subscription — and its tier — back.
//
// The rule now: a strictly newer event still wins, as before. At the SAME
// second the later lifecycle status wins by a fixed order
//   incomplete < incomplete_expired < trialing < active < past_due < unpaid < paused < canceled
// so nothing replaces `canceled`. An event carrying the status already stored
// still applies, so a redelivery repeats its own tier step.
//
// Every arm drives the real StripeWebhooksService against the Drizzle repo on a
// Postgres rebuilt from the migrations, and against the in-memory double the
// rest of the suite runs on, and reads back what was stored.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleBillingRepo } from '../../src/db/billing-repo.js';
import {
  DrizzleStripeWebhooksRepo,
  SAME_SECOND_STATUS_ORDER,
} from '../../src/db/stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import { ConflictError } from '../../src/lib/errors.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import { BillingService, type BillingRepo } from '../../src/services/billing.js';
import {
  StripeWebhooksService,
  type StripeEvent,
  type StripeWebhooksRepo,
} from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { InMemoryBillingProvider, InMemoryBillingRepo } from './_helpers/in-memory-billing.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';
import { sec } from './_helpers/stripe-invoice-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_live_billing_same_second';
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

const PRICES = {
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
  api_builder: { monthly: 'price_builder_m', annual: 'price_builder_y' },
};
const MAPS = buildStripePriceMaps(PRICES);

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

interface Subject {
  label: string;
  repo: StripeWebhooksRepo;
  billingRepo: BillingRepo;
  newCustomer: () => Promise<{ accountId: string; customerId: string }>;
  mirrorStatus: (stripeSubscriptionId: string) => Promise<string | null>;
  accountTier: (accountId: string) => Promise<AccountTier | null>;
}

function drizzleSubject(): Subject {
  if (pool === null) throw new Error('isolated database unreachable');
  return {
    label: 'Drizzle on Postgres',
    repo: new DrizzleStripeWebhooksRepo(pool),
    billingRepo: new DrizzleBillingRepo(pool),
    newCustomer: async () => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
                 VALUES (${accountId}::uuid, ${`same-second-${accountId}@example.test`},
                         'free'::account_tier, ${customerId})`;
      return { accountId, customerId };
    },
    mirrorStatus: async (id) => {
      const [row] = await db()<Array<{ status: string }>>`
        SELECT status::text FROM subscriptions WHERE stripe_subscription_id = ${id}`;
      return row?.status ?? null;
    },
    accountTier: async (accountId) => {
      const [row] = await db()<Array<{ tier: AccountTier }>>`
        SELECT tier::text AS tier FROM accounts WHERE id = ${accountId}::uuid`;
      return row?.tier ?? null;
    },
  };
}

/**
 * The in-memory pair. The webhook double and the billing double are two
 * stores, so the billing side is fed from the webhook side's mirror before
 * each read — the same rows Postgres would hand both repos.
 */
function inMemorySubject(): Subject {
  const repo = new InMemoryStripeWebhooksRepo();
  const billing = new InMemoryBillingRepo();
  const sync = (accountId: string): void => {
    for (const s of repo.listSubscriptions()) {
      if (s.accountId !== accountId) continue;
      billing.upsertSubscription({
        id: s.id,
        accountId: s.accountId,
        stripeSubscriptionId: s.stripeSubscriptionId,
        stripePriceId: s.stripePriceId,
        tier: s.tier,
        status: s.status,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        canceledAt: s.canceledAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      });
    }
    const account = repo.readAccount(accountId);
    if (account !== null) {
      billing.upsertAccount({
        id: accountId,
        email: `same-second-${accountId}@example.test`,
        name: null,
        tier: account.tier,
        stripeCustomerId: `cus_${accountId.replace(/-/g, '').slice(0, 20)}`,
      });
    }
  };
  const billingRepo: BillingRepo = new Proxy(billing, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (typeof args[0] === 'string') sync(args[0]);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    label: 'the in-memory doubles',
    repo,
    billingRepo,
    newCustomer: () => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      repo.registerAccount({ accountId, stripeCustomerId: customerId, tier: 'free' });
      return Promise.resolve({ accountId, customerId });
    },
    mirrorStatus: (id) =>
      Promise.resolve(
        repo.listSubscriptions().find((s) => s.stripeSubscriptionId === id)?.status ?? null,
      ),
    accountTier: (accountId) => Promise.resolve(repo.readAccount(accountId)?.tier ?? null),
  };
}

let seq = 0;
function subscriptionEvent(
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted',
  createdSec: number,
  spec: { id: string; customerId: string; status: string; priceId?: string },
): StripeEvent {
  seq += 1;
  return {
    id: `evt_same_second_${String(seq)}_${randomUUID()}`,
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
        canceled_at: type === 'customer.subscription.deleted' ? createdSec : null,
        current_period_start: createdSec,
        current_period_end: createdSec + 30 * 24 * 60 * 60,
        items: { data: [{ id: 'si_1', price: { id: spec.priceId ?? 'price_starter_m' } }] },
      },
    },
  };
}

function webhooksFor(s: Subject): StripeWebhooksService {
  return new StripeWebhooksService(s.repo, {
    logger: silent,
    priceToTier: MAPS.priceToTier,
    priceToInterval: MAPS.priceToInterval,
  });
}

function billingFor(s: Subject): BillingService {
  return new BillingService(s.billingRepo, new InMemoryBillingProvider(), {
    tierPrices: PRICES,
    defaultSuccessUrl: 'https://app.driftstack.io/billing/success',
    defaultCancelUrl: 'https://app.driftstack.io/billing/cancel',
    portalReturnUrl: 'https://app.driftstack.io/billing',
  });
}

async function deliver(service: StripeWebhooksService, event: StripeEvent): Promise<void> {
  expect(await service.handle(event, JSON.stringify(event))).toBe('handled');
}

const T = sec('2026-09-01T10:00:00Z');

describe.skipIf(!RUN_DB_TESTS)(
  'a same-second subscription event cannot reopen checkout or revive a canceled plan',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const makeSubject of [drizzleSubject, inMemorySubject]) {
      const label =
        makeSubject === drizzleSubject ? 'Drizzle on Postgres' : 'the in-memory doubles';

      it(`CRITICAL [${label}] Checkout's created(incomplete) processed AFTER its same-second updated(active) leaves the subscription active: the tier holds, checkout stays closed and the billing page says active`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const webhooks = webhooksFor(s);

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', T, {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.created', T, {
            id: subId,
            customerId,
            status: 'incomplete',
          }),
        );

        expect(await s.mirrorStatus(subId), 'the mirror went back to incomplete').toBe('active');
        expect(await s.accountTier(accountId)).toBe('api_starter');

        const billing = billingFor(s);
        const state = await billing.getBillingState(accountId);
        expect(state.subscription?.status, 'the billing page would show incomplete').toBe('active');
        await expect(
          billing.createCheckoutSession({
            accountId,
            tier: 'api_builder',
            billingPeriod: 'monthly',
          }),
          'checkout reopened for a paying customer — a second subscription would bill them twice',
        ).rejects.toBeInstanceOf(ConflictError);
      });

      it(`CRITICAL [${label}] a same-second updated(active) processed after deleted neither revives the canceled subscription nor its tier`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const webhooks = webhooksFor(s);

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.created', T - 3600, {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('api_starter');

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.deleted', T, {
            id: subId,
            customerId,
            status: 'canceled',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('free');

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', T, {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        expect(await s.mirrorStatus(subId), 'a canceled subscription came back').toBe('canceled');
        expect(await s.accountTier(accountId), 'the canceled plan came back').toBe('free');
      });

      it(`[${label}] every same-second pair is settled the same way: the incoming status applies exactly when it is no earlier in SAME_SECOND_STATUS_ORDER than the stored one`, async () => {
        const s = makeSubject();
        const { accountId } = await s.newCustomer();
        const at = new Date(T * 1000);
        const got: string[] = [];
        const want: string[] = [];
        for (const stored of SAME_SECOND_STATUS_ORDER) {
          for (const incoming of SAME_SECOND_STATUS_ORDER) {
            const subId = `sub_${randomUUID()}`;
            const row = {
              accountId,
              stripeSubscriptionId: subId,
              stripePriceId: 'price_starter_m',
              tier: 'api_starter' as const,
              currentPeriodEnd: null,
              cancelAtPeriodEnd: false,
              canceledAt: null,
              at,
            };
            await s.repo.upsertSubscription({ ...row, status: stored });
            const { applied } = await s.repo.upsertSubscription({ ...row, status: incoming });
            const expected =
              SAME_SECOND_STATUS_ORDER.indexOf(incoming) >=
              SAME_SECOND_STATUS_ORDER.indexOf(stored);
            got.push(`${stored}→${incoming}:${String(applied)}`);
            want.push(`${stored}→${incoming}:${String(expected)}`);
            expect(await s.mirrorStatus(subId)).toBe(expected ? incoming : stored);
          }
        }
        expect(got).toEqual(want);
      });

      it(`[${label}] a same-second event that moves the lifecycle FORWARD still applies (active, then past_due in the same second)`, async () => {
        const s = makeSubject();
        const { customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const webhooks = webhooksFor(s);

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.created', T, {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', T, {
            id: subId,
            customerId,
            status: 'past_due',
          }),
        );
        expect(await s.mirrorStatus(subId)).toBe('past_due');
      });

      it(`[${label}] a strictly NEWER event still wins whatever its status — the order only settles a tie`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const webhooks = webhooksFor(s);

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.created', T, {
            id: subId,
            customerId,
            status: 'past_due',
          }),
        );
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', T + 1, {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        expect(await s.mirrorStatus(subId), 'a recovery one second later must apply').toBe(
          'active',
        );
        expect(await s.accountTier(accountId)).toBe('api_starter');
      });

      it(`[${label}] a redelivered same-second cancel still applies and still takes the tier down — a retry after a failed tier step repeats that step`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const webhooks = webhooksFor(s);

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.created', T - 60, {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        const cancel = subscriptionEvent('customer.subscription.deleted', T, {
          id: subId,
          customerId,
          status: 'canceled',
        });
        // The mirror is written as the cancel's first delivery would have left it
        // before its tier step failed: canceled, while the account kept the tier.
        const upsert = await s.repo.upsertSubscription({
          accountId,
          stripeSubscriptionId: subId,
          stripePriceId: 'price_starter_m',
          tier: 'api_starter',
          status: 'canceled',
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          canceledAt: new Date(T * 1000),
          at: new Date(T * 1000),
        });
        expect(upsert.applied).toBe(true);
        expect(await s.accountTier(accountId)).toBe('api_starter');

        await deliver(webhooks, cancel);
        expect(await s.mirrorStatus(subId)).toBe('canceled');
        expect(await s.accountTier(accountId), 'the retried cancel skipped its downgrade').toBe(
          'free',
        );
      });
    }
  },
);
