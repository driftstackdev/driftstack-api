// A crypto term that has ended is not granted again by a late Stripe event
// (live-billing audit #9).
//
// Both tier recomputes floor the account's tier at its best UNEXPIRED crypto
// term. "Unexpired" was judged at the Stripe EVENT's time, not when the event
// was processed. Stripe retries a failed delivery for up to three days, so an
// event created before a crypto term ended can arrive after the expiry sweep
// has already taken that term's tier away — and the recompute then saw the
// term as live and gave the tier back. The sweep had already marked the term
// processed, so nothing ever removed it again: the customer kept a plan they
// had stopped paying for.
//
// A term now counts only while it is unexpired at the moment the recompute
// runs. A term that is still running keeps flooring the tier exactly as before.
//
// Driven through the real StripeWebhooksService and the real expiry sweeper,
// against the Drizzle repo on a Postgres rebuilt from the migrations and
// against the in-memory double.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import { CryptoEntitlementExpirySweeperService } from '../../src/services/crypto-entitlement-expiry-sweeper.js';
import {
  StripeWebhooksService,
  type StripeEvent,
  type StripeWebhooksRepo,
} from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';

const ISOLATED_DB_NAME = 'driftstack_iso_live_billing_crypto_floor';
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
});

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const DAY_S = 24 * 60 * 60;
const DAY_MS = DAY_S * 1000;

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
                 VALUES (${accountId}::uuid, ${`crypto-floor-${accountId}@example.test`},
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

let seq = 0;
function subscriptionEvent(
  type: 'customer.subscription.created' | 'customer.subscription.updated',
  createdSec: number,
  spec: { id: string; customerId: string; status: string },
): StripeEvent {
  seq += 1;
  return {
    id: `evt_crypto_floor_${String(seq)}_${randomUUID()}`,
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
        items: { data: [{ id: 'si_1', price: { id: 'price_starter_m' } }] },
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

async function deliver(service: StripeWebhooksService, event: StripeEvent): Promise<void> {
  expect(await service.handle(event, JSON.stringify(event))).toBe('handled');
}

/**
 * An account paying api_starter by card since 40 days ago, which ALSO bought a
 * 31-day api_builder term by crypto 35 days ago — so the term ended four days
 * ago — and the expiry sweep has since run and taken api_builder away.
 */
async function afterTheSweep(s: Subject): Promise<{
  accountId: string;
  customerId: string;
  subId: string;
  webhooks: StripeWebhooksService;
  sweeper: CryptoEntitlementExpirySweeperService;
}> {
  const nowSec = Math.floor(Date.now() / 1000);
  const { accountId, customerId } = await s.newCustomer();
  const subId = `sub_${randomUUID()}`;
  const webhooks = webhooksFor(s);
  await deliver(
    webhooks,
    subscriptionEvent('customer.subscription.created', nowSec - 40 * DAY_S, {
      id: subId,
      customerId,
      status: 'active',
    }),
  );
  expect(await s.accountTier(accountId)).toBe('api_starter');

  const grant = await s.repo.activateCryptoEntitlement({
    accountId,
    orderId: `ord_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    tier: 'api_builder',
    paidAt: new Date(Date.now() - 35 * DAY_MS),
    termDays: 31,
  });
  expect(grant.expiresAt.getTime()).toBeLessThan(Date.now());
  expect(await s.accountTier(accountId)).toBe('api_builder');

  const sweeper = new CryptoEntitlementExpirySweeperService({ repo: s.repo, logger: silent });
  await sweeper.tickOnce(new Date());
  expect(await s.accountTier(accountId), 'the sweep took the ended term away').toBe('api_starter');
  return { accountId, customerId, subId, webhooks, sweeper };
}

describe.skipIf(!RUN_DB_TESTS)(
  'a crypto term that has ended is not granted again by a late stripe event',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const makeSubject of [drizzleSubject, inMemorySubject]) {
      const label = makeSubject === drizzleSubject ? 'Drizzle on Postgres' : 'the in-memory double';

      it(`CRITICAL [${label}] an active-subscription event created BEFORE the term ended but delivered after the sweep leaves the account on its card plan, and the next sweep has nothing to undo`, async () => {
        const s = makeSubject();
        const { accountId, customerId, subId, webhooks, sweeper } = await afterTheSweep(s);

        // Created five days ago — the day before the term ended — and only now
        // delivered, as a Stripe retry after an earlier failure would be.
        const late = subscriptionEvent(
          'customer.subscription.updated',
          Math.floor(Date.now() / 1000) - 5 * DAY_S,
          { id: subId, customerId, status: 'active' },
        );
        await deliver(webhooks, late);
        expect(await s.accountTier(accountId), 'the ended crypto term was granted again').toBe(
          'api_starter',
        );

        await sweeper.tickOnce(new Date());
        expect(await s.accountTier(accountId)).toBe('api_starter');
      });

      it(`CRITICAL [${label}] a past_due event created before the term ended but delivered after the sweep drops the account to free, not back to the ended term's plan`, async () => {
        const s = makeSubject();
        const { accountId, customerId, subId, webhooks } = await afterTheSweep(s);

        // Created eight days ago (the term ended four days ago). Live-billing
        // audit #3: a past_due spell keeps the card plan for seven days, so a
        // spell that began five days ago would rightly keep api_starter; this one
        // is past its seven days, which is what makes "drops to free" the truth.
        const late = subscriptionEvent(
          'customer.subscription.updated',
          Math.floor(Date.now() / 1000) - 8 * DAY_S,
          { id: subId, customerId, status: 'past_due' },
        );
        await deliver(webhooks, late);
        expect(await s.accountTier(accountId), 'the ended crypto term was granted again').toBe(
          'free',
        );
      });

      it(`[${label}] a crypto term that is still running keeps flooring the tier when the card subscription falls into past_due`, async () => {
        const s = makeSubject();
        const { accountId, customerId } = await s.newCustomer();
        const subId = `sub_${randomUUID()}`;
        const webhooks = webhooksFor(s);
        const nowSec = Math.floor(Date.now() / 1000);
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.created', nowSec - 10 * DAY_S, {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        await s.repo.activateCryptoEntitlement({
          accountId,
          orderId: `ord_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          tier: 'api_builder',
          paidAt: new Date(Date.now() - 2 * DAY_MS),
          termDays: 31,
        });
        expect(await s.accountTier(accountId)).toBe('api_builder');

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec - 60, {
            id: subId,
            customerId,
            status: 'past_due',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('api_builder');
      });
    }
  },
);
