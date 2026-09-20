// A subscription event stores when its period STARTED, how often it bills, and
// when its plan last changed.
//
// Until migration 0129 the subscription mirror knew only when a period ended.
// These arms drive the real StripeWebhooksService with real subscription
// payloads, against BOTH stores — the Drizzle repo on a Postgres rebuilt from
// the migrations, and the in-memory double the rest of the suite runs on — and
// read back what was actually stored.
//
// `tier_since` is the subtle one. Stripe sends `customer.subscription.updated`
// for ANY change — a payment-method swap, a renewal — so "when did this plan
// begin" must move only when the stored plan really differs from the incoming
// one. That comparison reads the STORED row, so in Postgres it is SQL inside the
// upsert, and the double has to agree with it.
//
// None of this may disturb what the mirror already did: the account's plan after
// each sequence is asserted too.

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
import { sec } from './_helpers/stripe-invoice-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_subscription_periods';
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
  api_scale: { monthly: 'price_scale_m', annual: 'price_scale_y' },
});

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

interface Stored {
  tier: string;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  periodStartSource: string | null;
  billingInterval: string | null;
  tierSince: string | null;
}

interface Subject {
  label: string;
  repo: StripeWebhooksRepo;
  /** A new account on `tier`, returning its Stripe customer id. */
  newCustomer: (tier?: AccountTier) => Promise<{ accountId: string; customerId: string }>;
  stored: (stripeSubscriptionId: string) => Promise<Stored | null>;
  accountTier: (accountId: string) => Promise<string | null>;
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

function drizzleSubject(): Subject {
  if (pool === null) throw new Error('isolated database unreachable');
  const repo = new DrizzleStripeWebhooksRepo(pool);
  return {
    label: 'Drizzle on Postgres',
    repo,
    newCustomer: async (tier = 'free') => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId}`;
      await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
                 VALUES (${accountId}::uuid, ${`sub-${accountId}@example.test`},
                         ${tier}::account_tier, ${customerId})`;
      return { accountId, customerId };
    },
    stored: async (id) => {
      const [row] = await db()<
        Array<{
          tier: string;
          status: string;
          current_period_start: Date | null;
          current_period_end: Date | null;
          period_start_source: string | null;
          billing_interval: string | null;
          tier_since: Date | null;
        }>
      >`SELECT tier::text, status::text, current_period_start, current_period_end,
               period_start_source, billing_interval, tier_since
          FROM subscriptions WHERE stripe_subscription_id = ${id}`;
      if (row === undefined) return null;
      return {
        tier: row.tier,
        status: row.status,
        currentPeriodStart: iso(row.current_period_start),
        currentPeriodEnd: iso(row.current_period_end),
        periodStartSource: row.period_start_source,
        billingInterval: row.billing_interval,
        tierSince: iso(row.tier_since),
      };
    },
    accountTier: async (accountId) => {
      const [row] = await db()<Array<{ tier: string }>>`
        SELECT tier::text FROM accounts WHERE id = ${accountId}::uuid`;
      return row?.tier ?? null;
    },
  };
}

function inMemorySubject(): Subject {
  const repo = new InMemoryStripeWebhooksRepo();
  return {
    label: 'the in-memory double',
    repo,
    newCustomer: (tier = 'free') => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId}`;
      repo.registerAccount({ accountId, stripeCustomerId: customerId, tier });
      return Promise.resolve({ accountId, customerId });
    },
    stored: (id) => {
      const s = repo.listSubscriptions().find((r) => r.stripeSubscriptionId === id);
      if (s === undefined) return Promise.resolve(null);
      return Promise.resolve({
        tier: s.tier,
        status: s.status,
        currentPeriodStart: iso(s.currentPeriodStart),
        currentPeriodEnd: iso(s.currentPeriodEnd),
        periodStartSource: s.periodStartSource,
        billingInterval: s.billingInterval,
        tierSince: iso(s.tierSince),
      });
    },
    accountTier: (accountId) => Promise.resolve(repo.readAccount(accountId)?.tier ?? null),
  };
}

const MAR_1 = sec('2026-03-01T00:00:00Z');
const APR_1 = sec('2026-04-01T00:00:00Z');
const MAY_1 = sec('2026-05-01T00:00:00Z');
const MAR_1_2027 = sec('2027-03-01T00:00:00Z');

interface SubSpec {
  id: string;
  customerId: string;
  priceId: string;
  status?: string;
  /** Top-level period, as the older payload shape carries it. */
  period?: { startSec?: number; endSec?: number };
  /** Item-level period, where the newer payload shape carries it. */
  itemPeriod?: { startSec?: number; endSec?: number };
}

let seq = 0;
function subscriptionEvent(
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted',
  createdSec: number,
  spec: SubSpec,
): StripeEvent {
  seq += 1;
  return {
    id: `evt_sub_${String(seq)}_${randomUUID()}`,
    type,
    created: createdSec,
    livemode: false,
    data: {
      object: {
        id: spec.id,
        object: 'subscription',
        customer: spec.customerId,
        status: spec.status ?? 'active',
        cancel_at_period_end: false,
        canceled_at: null,
        ...(spec.period?.startSec !== undefined
          ? { current_period_start: spec.period.startSec }
          : {}),
        ...(spec.period?.endSec !== undefined ? { current_period_end: spec.period.endSec } : {}),
        items: {
          data: [
            {
              id: 'si_1',
              price: { id: spec.priceId },
              ...(spec.itemPeriod?.startSec !== undefined
                ? { current_period_start: spec.itemPeriod.startSec }
                : {}),
              ...(spec.itemPeriod?.endSec !== undefined
                ? { current_period_end: spec.itemPeriod.endSec }
                : {}),
            },
          ],
        },
      },
    },
  };
}

function serviceFor(s: Subject): StripeWebhooksService {
  return new StripeWebhooksService(s.repo, {
    logger: silent,
    priceToTier: MAPS.priceToTier,
    priceToInterval: MAPS.priceToInterval,
  });
}

async function deliver(service: StripeWebhooksService, event: StripeEvent): Promise<void> {
  expect(await service.handle(event, JSON.stringify(event))).toBe('handled');
}

const at = (secs: number): string => new Date(secs * 1000).toISOString();

describe.skipIf(!RUN_DB_TESTS)(
  'a subscription event stores its period start, its interval and when its plan changed',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const makeSubject of [drizzleSubject, inMemorySubject]) {
      const label = makeSubject === drizzleSubject ? 'Drizzle on Postgres' : 'the in-memory double';

      it(`CRITICAL [${label}] a subscription event stores when its period started, marked as read from Stripe, beside the monthly interval and the plan’s start`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        await deliver(
          serviceFor(s),
          subscriptionEvent('customer.subscription.created', MAR_1 + 5, {
            id: subId,
            customerId,
            priceId: 'price_starter_m',
            period: { startSec: MAR_1, endSec: APR_1 },
          }),
        );
        expect(await s.stored(subId)).toEqual({
          tier: 'api_starter',
          status: 'active',
          currentPeriodStart: at(MAR_1),
          currentPeriodEnd: at(APR_1),
          periodStartSource: 'stripe',
          billingInterval: 'month',
          tierSince: at(MAR_1 + 5),
        });
        expect(await s.accountTier(accountId)).toBe('api_starter');
      });

      it(`CRITICAL [${label}] a period carried ONLY on the subscription’s item is still stored`, async () => {
        const s = makeSubject();
        const { customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        await deliver(
          serviceFor(s),
          subscriptionEvent('customer.subscription.created', MAR_1 + 5, {
            id: subId,
            customerId,
            priceId: 'price_starter_m',
            period: { endSec: APR_1 },
            itemPeriod: { startSec: MAR_1, endSec: APR_1 },
          }),
        );
        expect(await s.stored(subId)).toMatchObject({
          currentPeriodStart: at(MAR_1),
          periodStartSource: 'stripe',
        });
        // The subscription's own start wins when both are present.
        const both = `sub_${randomUUID()}`;
        await deliver(
          serviceFor(s),
          subscriptionEvent('customer.subscription.created', MAR_1 + 5, {
            id: both,
            customerId,
            priceId: 'price_starter_m',
            period: { startSec: MAR_1, endSec: APR_1 },
            itemPeriod: { startSec: MAR_1 + 86400 },
          }),
        );
        expect((await s.stored(both))?.currentPeriodStart).toBe(at(MAR_1));
      });

      it(`[${label}] an annual price is stored as yearly, and a price the configuration does not name as no interval at all`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer('enterprise');
        const annual = `sub_${randomUUID()}`;
        const custom = `sub_${randomUUID()}`;
        const service = serviceFor(s);
        await deliver(
          service,
          subscriptionEvent('customer.subscription.created', MAR_1 + 5, {
            id: custom,
            customerId,
            priceId: 'price_custom_contract',
            period: { startSec: MAR_1, endSec: APR_1 },
          }),
        );
        expect(await s.stored(custom)).toMatchObject({
          billingInterval: null,
          currentPeriodStart: at(MAR_1),
          // The unmapped-price filler is the account's current plan, as before.
          tier: 'enterprise',
        });
        expect(await s.accountTier(accountId)).toBe('enterprise');

        await deliver(
          service,
          subscriptionEvent('customer.subscription.created', MAR_1 + 6, {
            id: annual,
            customerId,
            priceId: 'price_scale_y',
            period: { startSec: MAR_1, endSec: MAR_1_2027 },
          }),
        );
        expect(await s.stored(annual)).toMatchObject({
          billingInterval: 'year',
          currentPeriodEnd: at(MAR_1_2027),
        });
      });

      it(`CRITICAL [${label}] a plan change records when the new plan began; an unrelated update — a renewal, a payment-method swap — does not move it`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const service = serviceFor(s);
        const base = { id: subId, customerId, priceId: 'price_starter_m' };

        await deliver(
          service,
          subscriptionEvent('customer.subscription.created', MAR_1 + 5, {
            ...base,
            period: { startSec: MAR_1, endSec: APR_1 },
          }),
        );
        // An unrelated update, ten days on.
        await deliver(
          service,
          subscriptionEvent('customer.subscription.updated', MAR_1 + 10 * 86400, {
            ...base,
            period: { startSec: MAR_1, endSec: APR_1 },
          }),
        );
        // A renewal: the period rolls, the plan does not.
        await deliver(
          service,
          subscriptionEvent('customer.subscription.updated', APR_1 + 5, {
            ...base,
            period: { startSec: APR_1, endSec: MAY_1 },
          }),
        );
        expect(await s.stored(subId)).toMatchObject({
          tierSince: at(MAR_1 + 5),
          currentPeriodStart: at(APR_1),
          currentPeriodEnd: at(MAY_1),
        });

        // The plan changes mid-period.
        const changedAt = APR_1 + 12 * 86400;
        await deliver(
          service,
          subscriptionEvent('customer.subscription.updated', changedAt, {
            ...base,
            priceId: 'price_scale_m',
            period: { startSec: APR_1, endSec: MAY_1 },
          }),
        );
        expect(await s.stored(subId)).toMatchObject({
          tier: 'api_scale',
          tierSince: at(changedAt),
          currentPeriodStart: at(APR_1),
        });
        expect(await s.accountTier(accountId)).toBe('api_scale');

        // And afterwards another unrelated update leaves the NEW time alone.
        await deliver(
          service,
          subscriptionEvent('customer.subscription.updated', changedAt + 3600, {
            ...base,
            priceId: 'price_scale_m',
            period: { startSec: APR_1, endSec: MAY_1 },
          }),
        );
        expect((await s.stored(subId))?.tierSince).toBe(at(changedAt));
      });

      it(`CRITICAL [${label}] an OLDER event arriving late moves nothing: not the plan’s start, not the period`, async () => {
        const s = makeSubject();
        const { customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const service = serviceFor(s);
        await deliver(
          service,
          subscriptionEvent('customer.subscription.updated', APR_1 + 5, {
            id: subId,
            customerId,
            priceId: 'price_scale_m',
            period: { startSec: APR_1, endSec: MAY_1 },
          }),
        );
        const fresh = await s.stored(subId);
        // Stripe re-delivers the month-old creation event, on the old plan.
        await deliver(
          service,
          subscriptionEvent('customer.subscription.created', MAR_1 + 5, {
            id: subId,
            customerId,
            priceId: 'price_starter_m',
            period: { startSec: MAR_1, endSec: APR_1 },
          }),
        );
        expect(await s.stored(subId)).toEqual(fresh);
      });

      it(`[${label}] an event that carries NO period start clears a stored one rather than leaving a stale start beside a new end`, async () => {
        const s = makeSubject();
        const { customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const service = serviceFor(s);
        const base = { id: subId, customerId, priceId: 'price_starter_m' };
        await deliver(
          service,
          subscriptionEvent('customer.subscription.created', MAR_1 + 5, {
            ...base,
            period: { startSec: MAR_1, endSec: APR_1 },
          }),
        );
        await deliver(
          service,
          subscriptionEvent('customer.subscription.updated', APR_1 + 5, {
            ...base,
            period: { endSec: MAY_1 },
          }),
        );
        expect(await s.stored(subId)).toMatchObject({
          currentPeriodStart: null,
          periodStartSource: null,
          currentPeriodEnd: at(MAY_1),
          // The interval is a fact about the price, not the period.
          billingInterval: 'month',
        });
      });

      it(`CRITICAL [${label}] a start that is not before its end is DROPPED, and the plan is still granted: a nonsensical period must never take the tier update down with it`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer();
        for (const startSec of [APR_1, MAY_1]) {
          const subId = `sub_${randomUUID()}`;
          await deliver(
            serviceFor(s),
            subscriptionEvent('customer.subscription.created', MAR_1 + 5, {
              id: subId,
              customerId,
              priceId: 'price_starter_m',
              period: { startSec, endSec: APR_1 },
            }),
          );
          expect(await s.stored(subId)).toMatchObject({
            currentPeriodStart: null,
            periodStartSource: null,
            currentPeriodEnd: at(APR_1),
            tier: 'api_starter',
          });
        }
        expect(await s.accountTier(accountId)).toBe('api_starter');
      });

      it(`[${label}] a cancellation keeps the period it ended in and the time its plan began, and the account falls back exactly as before`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const service = serviceFor(s);
        const spec = {
          id: subId,
          customerId,
          priceId: 'price_starter_m',
          period: { startSec: MAR_1, endSec: APR_1 },
        };
        await deliver(service, subscriptionEvent('customer.subscription.created', MAR_1 + 5, spec));
        await deliver(
          service,
          subscriptionEvent('customer.subscription.deleted', MAR_1 + 20 * 86400, {
            ...spec,
            status: 'canceled',
          }),
        );
        expect(await s.stored(subId)).toEqual({
          tier: 'api_starter',
          status: 'canceled',
          currentPeriodStart: at(MAR_1),
          currentPeriodEnd: at(APR_1),
          periodStartSource: 'stripe',
          billingInterval: 'month',
          tierSince: at(MAR_1 + 5),
        });
        expect(await s.accountTier(accountId)).toBe('free');
      });
    }

    it('CRITICAL a mirror row from BEFORE the migration has no plan-start time, and keeps none until its plan actually changes: when it began is not known, and a guess would read as a fact', async () => {
      const s = drizzleSubject();
      const { accountId, customerId } = await s.newCustomer('api_starter');
      const subId = `sub_${randomUUID()}`;
      // As 0010 wrote it: none of the four new columns.
      await db()`
        INSERT INTO subscriptions
          (account_id, stripe_subscription_id, stripe_price_id, tier, status,
           current_period_end, created_at, updated_at)
        VALUES (${accountId}::uuid, ${subId}, 'price_starter_m', 'api_starter', 'active',
                '2026-04-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
      const service = serviceFor(s);
      const base = { id: subId, customerId, period: { startSec: MAR_1, endSec: APR_1 } };

      await deliver(
        service,
        subscriptionEvent('customer.subscription.updated', MAR_1 + 5, {
          ...base,
          priceId: 'price_starter_m',
        }),
      );
      expect(await s.stored(subId)).toMatchObject({
        tierSince: null,
        currentPeriodStart: at(MAR_1),
        periodStartSource: 'stripe',
        billingInterval: 'month',
      });

      await deliver(
        service,
        subscriptionEvent('customer.subscription.updated', MAR_1 + 9 * 86400, {
          ...base,
          priceId: 'price_scale_m',
        }),
      );
      expect((await s.stored(subId))?.tierSince).toBe(at(MAR_1 + 9 * 86400));
    });
  },
);
