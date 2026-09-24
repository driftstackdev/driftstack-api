// A new plan subscription cancels the older one still billing the account
// (live-billing audit #4, first half).
//
// Re-checkout is allowed while a subscription is past_due, and nothing
// cancelled the old one: when its card recovered, both subscriptions billed and
// nothing noticed. Now, when a NEW plan subscription starts collecting — its
// `customer.subscription.created` arrives active or trialing, or Checkout's
// incomplete subscription completes its first payment — every OLDER
// subscription the account still collects on is cancelled at once, prorated,
// and staff are alerted without identifiers. The new subscription is never
// cancelled, nor one the mirror saw after it (that one is the newer purchase:
// staff are told instead). A redelivery, or any later event of the new
// subscription, cancels nothing again. A cancel Stripe refuses is logged and
// alerted, and the event is still handled.
//
// Driven through the real StripeWebhooksService against the Drizzle repo on a
// Postgres rebuilt from the migrations and against the in-memory double. Only
// Stripe (the canceller) and Sentry are doubles.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import {
  StripeWebhooksService,
  type StripeEvent,
  type StripeWebhooksRepo,
  type StripeWebhooksServiceConfig,
} from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';

const ISOLATED_DB_NAME = 'driftstack_iso_replaced_subscription';
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

const MAPS = buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
  api_builder: { monthly: 'price_builder_m', annual: 'price_builder_y' },
});

const DAY_S = 24 * 60 * 60;

interface Subject {
  repo: StripeWebhooksRepo;
  newCustomer: () => Promise<{ accountId: string; customerId: string }>;
  accountTier: (accountId: string) => Promise<AccountTier | null>;
}

function drizzleSubject(): Subject {
  if (pool === null) throw new Error('isolated database unreachable');
  return {
    repo: new DrizzleStripeWebhooksRepo(pool),
    newCustomer: async () => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
                 VALUES (${accountId}::uuid, ${`replaced-${accountId}@example.test`},
                         'free'::account_tier, ${customerId})`;
      return { accountId, customerId };
    },
    accountTier: async (accountId) => {
      const [row] = await db()<Array<{ tier: AccountTier }>>`
        SELECT tier::text AS tier FROM accounts WHERE id = ${accountId}::uuid`;
      return row?.tier ?? null;
    },
  };
}

function inMemorySubject(): Subject {
  const repo = new InMemoryStripeWebhooksRepo();
  return {
    repo,
    newCustomer: () => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      repo.registerAccount({ accountId, stripeCustomerId: customerId, tier: 'free' });
      return Promise.resolve({ accountId, customerId });
    },
    accountTier: (accountId) => Promise.resolve(repo.readAccount(accountId)?.tier ?? null),
  };
}

/** Stripe's cancel, scripted: records every call; refuses while `refuse` is set. */
class ScriptedCanceller {
  readonly calls: string[] = [];
  refuse = false;
  cancelSubscriptionNow(args: { subscriptionId: string }): Promise<void> {
    this.calls.push(args.subscriptionId);
    if (this.refuse) {
      return Promise.reject(
        Object.assign(new Error('Stripe POST refused: 400'), { name: 'StripeApiError' }),
      );
    }
    return Promise.resolve();
  }
}

interface Harness {
  webhooks: StripeWebhooksService;
  canceller: ScriptedCanceller;
  alerts: SentryMessage[];
  errors: unknown[];
}

function harness(
  s: Subject,
  overrides: Partial<Pick<StripeWebhooksServiceConfig, 'subscriptionCanceller'>> = {},
): Harness {
  const canceller = new ScriptedCanceller();
  const alerts: SentryMessage[] = [];
  const errors: unknown[] = [];
  const logger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: (o: unknown) => errors.push(o),
  } as unknown as Logger;
  const webhooks = new StripeWebhooksService(s.repo, {
    logger,
    priceToTier: MAPS.priceToTier,
    priceToInterval: MAPS.priceToInterval,
    sentry: { captureMessage: (m) => alerts.push(m) },
    subscriptionCanceller: canceller,
    ...overrides,
  });
  return { webhooks, canceller, alerts, errors };
}

let seq = 0;
function subscriptionEvent(
  type: 'customer.subscription.created' | 'customer.subscription.updated',
  createdSec: number,
  spec: { id: string; customerId: string; status: string; priceId: string },
): StripeEvent {
  seq += 1;
  return {
    id: `evt_replaced_${String(seq)}_${randomUUID()}`,
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

async function deliver(h: Harness, event: StripeEvent): Promise<void> {
  expect(await h.webhooks.handle(event, JSON.stringify(event))).toBe('handled');
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** An account whose api_starter subscription (A) fell into past_due two days ago. */
async function withAPastDueSubscription(
  s: Subject,
  h: Harness,
): Promise<{ accountId: string; customerId: string; oldSub: string }> {
  const { accountId, customerId } = await s.newCustomer();
  const oldSub = `sub_old_${randomUUID()}`;
  const now = nowSec();
  await deliver(
    h,
    subscriptionEvent('customer.subscription.created', now - 40 * DAY_S, {
      id: oldSub,
      customerId,
      status: 'active',
      priceId: 'price_starter_m',
    }),
  );
  await deliver(
    h,
    subscriptionEvent('customer.subscription.updated', now - 2 * DAY_S, {
      id: oldSub,
      customerId,
      status: 'past_due',
      priceId: 'price_starter_m',
    }),
  );
  expect(h.canceller.calls, 'the old subscription cancelled something itself').toEqual([]);
  return { accountId, customerId, oldSub };
}

/** Every identifier an arm knows; an alert must carry none of them. */
function expectIdFree(alerts: SentryMessage[], ids: string[]): void {
  for (const alert of alerts) {
    const text = JSON.stringify(alert);
    for (const id of ids) expect(text, 'an alert carried an identifier').not.toContain(id);
  }
}

describe.skipIf(!RUN_DB_TESTS)(
  'a new plan subscription cancels the older one still billing the account',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const makeSubject of [drizzleSubject, inMemorySubject]) {
      const label = makeSubject === drizzleSubject ? 'Drizzle on Postgres' : 'the in-memory double';

      it(`CRITICAL [${label}] re-checkout while the old subscription is past_due: the new one's created event cancels the old one at once, and staff are told without ids`, async () => {
        const s = makeSubject();
        const h = harness(s);
        const { accountId, customerId, oldSub } = await withAPastDueSubscription(s, h);
        const newSub = `sub_new_${randomUUID()}`;
        await deliver(
          h,
          subscriptionEvent('customer.subscription.created', nowSec(), {
            id: newSub,
            customerId,
            status: 'active',
            priceId: 'price_builder_m',
          }),
        );
        expect(h.canceller.calls, 'the old subscription was left billing').toEqual([oldSub]);
        expect(await s.accountTier(accountId)).toBe('api_builder');
        expect(h.alerts.map((a) => [a.level, a.tags?.kind])).toEqual([
          ['warning', 'replaced_subscription_cancelled'],
        ]);
        expectIdFree(h.alerts, [accountId, customerId, oldSub, newSub]);
        expect(h.errors).toEqual([]);
      });

      it(`CRITICAL [${label}] Checkout's incomplete subscription completing its first payment cancels the old one — once`, async () => {
        const s = makeSubject();
        const h = harness(s);
        const { customerId, oldSub } = await withAPastDueSubscription(s, h);
        const newSub = `sub_new_${randomUUID()}`;
        const now = nowSec();
        await deliver(
          h,
          subscriptionEvent('customer.subscription.created', now - 1, {
            id: newSub,
            customerId,
            status: 'incomplete',
            priceId: 'price_builder_m',
          }),
        );
        expect(h.canceller.calls, 'an unpaid subscription replaced a paying one').toEqual([]);
        await deliver(
          h,
          subscriptionEvent('customer.subscription.updated', now, {
            id: newSub,
            customerId,
            status: 'active',
            priceId: 'price_builder_m',
          }),
        );
        expect(h.canceller.calls).toEqual([oldSub]);
      });

      it(`CRITICAL [${label}] a redelivery, a retry the ledger never recorded, and a later event of the new subscription cancel nothing again`, async () => {
        const s = makeSubject();
        const h = harness(s);
        const { customerId, oldSub } = await withAPastDueSubscription(s, h);
        const newSub = `sub_new_${randomUUID()}`;
        const now = nowSec();
        const created = subscriptionEvent('customer.subscription.created', now, {
          id: newSub,
          customerId,
          status: 'active',
          priceId: 'price_builder_m',
        });
        await deliver(h, created);
        expect(h.canceller.calls).toEqual([oldSub]);

        // Stripe redelivers the same event: the ledger answers.
        expect(await h.webhooks.handle(created, JSON.stringify(created))).toBe('duplicate');
        // The same event run again as if its first run had failed after the
        // cancel and was never recorded.
        const rerun = { ...created, id: `evt_rerun_${randomUUID()}` };
        await deliver(h, rerun);
        // A later event of the new subscription.
        await deliver(
          h,
          subscriptionEvent('customer.subscription.updated', now + 5, {
            id: newSub,
            customerId,
            status: 'active',
            priceId: 'price_builder_m',
          }),
        );
        expect(h.canceller.calls, 'the old subscription was cancelled twice').toEqual([oldSub]);
      });

      it(`CRITICAL [${label}] never the new subscription, and never one the mirror saw after it: two checkouts whose events crossed are both kept, and staff are told`, async () => {
        const s = makeSubject();
        const h = harness(s);
        const { accountId, customerId } = await s.newCustomer();
        const first = `sub_first_${randomUUID()}`;
        const second = `sub_second_${randomUUID()}`;
        const now = nowSec();
        // The SECOND purchase's event is processed first…
        await deliver(
          h,
          subscriptionEvent('customer.subscription.created', now, {
            id: second,
            customerId,
            status: 'active',
            priceId: 'price_builder_m',
          }),
        );
        // …then the first purchase's, created a minute earlier, arrives late.
        await deliver(
          h,
          subscriptionEvent('customer.subscription.created', now - 60, {
            id: first,
            customerId,
            status: 'active',
            priceId: 'price_starter_m',
          }),
        );
        expect(h.canceller.calls, 'a newer purchase was cancelled').toEqual([]);
        expect(h.alerts.map((a) => [a.level, a.tags?.kind])).toEqual([
          ['warning', 'duplicate_subscription_kept'],
        ]);
        expectIdFree(h.alerts, [accountId, customerId, first, second]);
      });

      it(`CRITICAL [${label}] a cancel Stripe refuses is logged with the ids and alerted without them, and the event is still handled`, async () => {
        const s = makeSubject();
        const h = harness(s);
        const { accountId, customerId, oldSub } = await withAPastDueSubscription(s, h);
        h.canceller.refuse = true;
        const newSub = `sub_new_${randomUUID()}`;
        await deliver(
          h,
          subscriptionEvent('customer.subscription.created', nowSec(), {
            id: newSub,
            customerId,
            status: 'active',
            priceId: 'price_builder_m',
          }),
        );
        expect(h.canceller.calls).toEqual([oldSub]);
        expect(await s.accountTier(accountId)).toBe('api_builder');
        expect(h.alerts.map((a) => [a.level, a.tags?.kind])).toEqual([
          ['error', 'replaced_subscription_not_cancelled'],
        ]);
        expectIdFree(h.alerts, [accountId, customerId, oldSub, newSub]);
        expect(JSON.stringify(h.errors)).toContain(oldSub);
      });

      it(`[${label}] with no canceller configured the old subscription is reported as not cancelled`, async () => {
        const s = makeSubject();
        const h = harness(s, { subscriptionCanceller: null });
        const { customerId, oldSub } = await withAPastDueSubscription(s, h);
        await deliver(
          h,
          subscriptionEvent('customer.subscription.created', nowSec(), {
            id: `sub_new_${randomUUID()}`,
            customerId,
            status: 'trialing',
            priceId: 'price_builder_m',
          }),
        );
        expect(h.alerts.map((a) => [a.level, a.tags?.kind])).toEqual([
          ['error', 'replaced_subscription_not_cancelled'],
        ]);
        expect(JSON.stringify(h.errors)).toContain(oldSub);
      });

      it(`[${label}] a subscription on a price no plan names (a custom one made in Stripe) cancels nothing`, async () => {
        const s = makeSubject();
        const h = harness(s);
        const { customerId } = await withAPastDueSubscription(s, h);
        await deliver(
          h,
          subscriptionEvent('customer.subscription.created', nowSec(), {
            id: `sub_custom_${randomUUID()}`,
            customerId,
            status: 'active',
            priceId: 'price_custom_contract',
          }),
        );
        expect(h.canceller.calls).toEqual([]);
        expect(h.alerts).toEqual([]);
      });

      it(`[${label}] a first subscription, and a routine update of an older one, cancel nothing and alert nothing`, async () => {
        const s = makeSubject();
        const h = harness(s);
        const { customerId } = await s.newCustomer();
        const only = `sub_only_${randomUUID()}`;
        const now = nowSec();
        await deliver(
          h,
          subscriptionEvent('customer.subscription.created', now - 10 * DAY_S, {
            id: only,
            customerId,
            status: 'active',
            priceId: 'price_starter_m',
          }),
        );
        await deliver(
          h,
          subscriptionEvent('customer.subscription.updated', now, {
            id: only,
            customerId,
            status: 'active',
            priceId: 'price_starter_m',
          }),
        );
        expect(h.canceller.calls).toEqual([]);
        expect(h.alerts).toEqual([]);
      });
    }
  },
);
