// A redelivered cancellation takes the plan away after a transient failure
// (security sweep 2026-09-24, finding #30, redelivery).
//
// A customer.subscription.updated that moves a paying subscription to `canceled`
// recomputes the account's plan, but only while the STORED row still held the
// plan (so a later edit to a long-cancelled subscription takes away nothing).
// The stored row is read before the event's own upsert. When the first delivery
// upserted the row and then its recompute failed on a transient error (a
// deadlock, 40P01), no processed-event row was written and Stripe redelivered the
// same event. The redelivery read the row its own first delivery had written —
// already `canceled` — skipped the recompute, and the account kept the paid plan.
//
// The recompute now also runs when the stored row IS this update (same status,
// same event time) and the update is the one that moved the subscription out of
// a paying status (its `previous_attributes.status`, when Stripe sends it). A
// later, different edit still skips, and so does a redelivered edit that never
// changed the status.
//
// Nor may a later edit processed BETWEEN the failed delivery and Stripe's retry
// make the retry lose its recompute. The retry is then older than the stored row,
// so the recency guard reads it as stale and used to return before the recompute:
// the account kept its paid plan. A stale update that moved the subscription out
// of a paying status into the terminal status the row still holds (and a stale
// `customer.subscription.deleted` of a row already cancelled) now recomputes; a
// stale edit that did not change the status still does not.
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
import type { CreditsRefresher } from '../../src/services/credit-grants.js';
import {
  StripeWebhooksService,
  type StripeEvent,
  type StripeWebhooksRepo,
} from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';

const ISOLATED_DB_NAME = 'driftstack_iso_redelivered_cancel';
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

/** Postgres's deadlock error, as the driver raises it: a transient failure. */
function deadlock(): Error {
  return Object.assign(new Error('deadlock detected'), { code: '40P01' });
}

interface Subject {
  /** The repo, with the tier recompute failing once on a deadlock when armed. */
  repo: StripeWebhooksRepo;
  failNextRecompute: () => void;
  recomputes: () => number;
  newCustomer: () => Promise<{ accountId: string; customerId: string }>;
  accountTier: (accountId: string) => Promise<AccountTier | null>;
  setPlanOutsideStripe: (accountId: string, tier: AccountTier) => Promise<void>;
}

/** Wraps `base` so `downgradeAccountTierToBestRemaining` is counted and can fail once. */
function withFailingRecompute(
  base: StripeWebhooksRepo,
): Pick<Subject, 'repo' | 'failNextRecompute' | 'recomputes'> {
  let armed = false;
  let calls = 0;
  const repo = Object.create(base) as StripeWebhooksRepo;
  repo.downgradeAccountTierToBestRemaining = (args) => {
    calls += 1;
    if (armed) {
      armed = false;
      return Promise.reject(deadlock());
    }
    return base.downgradeAccountTierToBestRemaining(args);
  };
  return { repo, failNextRecompute: () => (armed = true), recomputes: () => calls };
}

function drizzleSubject(): Subject {
  if (pool === null) throw new Error('isolated database unreachable');
  return {
    ...withFailingRecompute(new DrizzleStripeWebhooksRepo(pool)),
    newCustomer: async () => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
                 VALUES (${accountId}::uuid, ${`redelivered-${accountId}@example.test`},
                         'free'::account_tier, ${customerId})`;
      return { accountId, customerId };
    },
    accountTier: async (accountId) => {
      const [row] = await db()<Array<{ tier: AccountTier }>>`
        SELECT tier::text AS tier FROM accounts WHERE id = ${accountId}::uuid`;
      return row?.tier ?? null;
    },
    setPlanOutsideStripe: async (accountId, tier) => {
      await db()`UPDATE accounts SET tier = ${tier}::account_tier WHERE id = ${accountId}::uuid`;
    },
  };
}

function inMemorySubject(): Subject {
  const base = new InMemoryStripeWebhooksRepo();
  return {
    ...withFailingRecompute(base),
    newCustomer: () => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      base.registerAccount({ accountId, stripeCustomerId: customerId, tier: 'free' });
      return Promise.resolve({ accountId, customerId });
    },
    accountTier: (accountId) => Promise.resolve(base.readAccount(accountId)?.tier ?? null),
    setPlanOutsideStripe: async (accountId, tier) => {
      await base.setAccountTier({ accountId, tier, at: new Date() });
    },
  };
}

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
    canceledAtSec?: number;
    /** Stripe's `data.previous_attributes`: the fields this update changed. Omitted when absent. */
    previous?: Record<string, unknown>;
  },
): StripeEvent {
  return {
    id: `evt_redelivered_${randomUUID()}`,
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
        items: { data: [{ id: 'si_1', price: { id: 'price_scale_m' } }] },
      },
      // Stripe's own field on an update; the parsed StripeEvent shape does not name it.
      ...(spec.previous !== undefined ? { previous_attributes: spec.previous } : {}),
    },
  };
}

function service(s: Subject, creditsRefresher?: CreditsRefresher): StripeWebhooksService {
  return new StripeWebhooksService(s.repo, {
    logger: createTestLogger(),
    priceToTier: MAPS.priceToTier,
    priceToInterval: MAPS.priceToInterval,
    ...(creditsRefresher !== undefined ? { creditsRefresher } : {}),
  });
}

async function deliver(webhooks: StripeWebhooksService, event: StripeEvent): Promise<void> {
  expect(await webhooks.handle(event, JSON.stringify(event))).toBe('handled');
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

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
    }),
  );
  expect(await s.accountTier(accountId)).toBe('api_scale');
  return { accountId, customerId, sub };
}

/** A creditsRefresher whose next call fails on a deadlock when armed. */
function refresherFailingOnce(): { refresher: CreditsRefresher; failNext: () => void } {
  let armed = false;
  return {
    refresher: {
      refreshCredits: () => {
        if (armed) {
          armed = false;
          return Promise.reject(deadlock());
        }
        return Promise.resolve({} as Awaited<ReturnType<CreditsRefresher['refreshCredits']>>);
      },
    },
    failNext: () => (armed = true),
  };
}

describe.skipIf(!RUN_DB_TESTS)(
  'a redelivered cancellation takes the plan away after a transient failure',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const makeSubject of [drizzleSubject, inMemorySubject]) {
      const label = makeSubject === drizzleSubject ? 'Drizzle on Postgres' : 'the in-memory double';

      for (const previous of [{ status: 'active' }, undefined]) {
        const shape =
          previous === undefined ? 'without previous_attributes' : 'with previous status active';
        it(`CRITICAL [${label}] the update to canceled whose recompute hit a deadlock takes the plan away when Stripe redelivers it (${shape})`, async () => {
          const s = makeSubject();
          const webhooks = service(s);
          const { accountId, customerId, sub } = await payingAccount(s, webhooks);
          const cancelled = subscriptionEvent('customer.subscription.updated', nowSec() - 30, {
            id: sub,
            customerId,
            status: 'canceled',
            ...(previous !== undefined ? { previous } : {}),
          });

          s.failNextRecompute();
          await expect(
            webhooks.handle(cancelled, JSON.stringify(cancelled)),
            'the transient failure must reach Stripe as a failure, so it redelivers',
          ).rejects.toMatchObject({ code: '40P01' });
          expect(await s.accountTier(accountId)).toBe('api_scale');

          await deliver(webhooks, cancelled);

          expect(
            await s.accountTier(accountId),
            'the redelivered cancellation left the account on its paid plan',
          ).toBe('free');
        });
      }

      it(`CRITICAL [${label}] after the redelivery, a later metadata-only edit neither recomputes nor takes a plan staff set`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        const cancelledAt = nowSec() - DAY_S;
        const cancelled = subscriptionEvent('customer.subscription.updated', cancelledAt, {
          id: sub,
          customerId,
          status: 'canceled',
          previous: { status: 'active' },
        });
        s.failNextRecompute();
        await expect(webhooks.handle(cancelled, JSON.stringify(cancelled))).rejects.toBeTruthy();
        await deliver(webhooks, cancelled);
        expect(await s.accountTier(accountId)).toBe('free');

        await s.setPlanOutsideStripe(accountId, 'enterprise');
        const before = s.recomputes();
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
            id: sub,
            customerId,
            status: 'canceled',
            canceledAtSec: cancelledAt,
            previous: { metadata: { note: 'old' } },
          }),
        );

        expect(s.recomputes() - before, 'a metadata-only edit recomputed the plan').toBe(0);
        expect(await s.accountTier(accountId)).toBe('enterprise');
      });

      it(`CRITICAL [${label}] a redelivered metadata-only edit to a cancelled subscription does not recompute either`, async () => {
        const s = makeSubject();
        const credits = refresherFailingOnce();
        const webhooks = service(s, credits.refresher);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        const cancelledAt = nowSec() - 5 * DAY_S;
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', cancelledAt, {
            id: sub,
            customerId,
            status: 'canceled',
            previous: { status: 'active' },
          }),
        );
        expect(await s.accountTier(accountId)).toBe('free');
        await s.setPlanOutsideStripe(accountId, 'enterprise');

        // The edit's first delivery writes its row and then fails on a transient error
        // after the (skipped) recompute, so Stripe sends the same edit again.
        const edit = subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
          id: sub,
          customerId,
          status: 'canceled',
          canceledAtSec: cancelledAt,
          previous: { metadata: { note: 'old' } },
        });
        credits.failNext();
        await expect(webhooks.handle(edit, JSON.stringify(edit))).rejects.toMatchObject({
          code: '40P01',
        });
        const before = s.recomputes();
        await deliver(webhooks, edit);

        expect(
          s.recomputes() - before,
          'a redelivered metadata-only edit recomputed the plan',
        ).toBe(0);
        expect(await s.accountTier(accountId)).toBe('enterprise');
      });

      it(`CRITICAL [${label}] the update to canceled whose recompute hit a deadlock takes the plan away when Stripe redelivers it after a later edit`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        const cancelledAt = nowSec() - 120;
        const cancelled = subscriptionEvent('customer.subscription.updated', cancelledAt, {
          id: sub,
          customerId,
          status: 'canceled',
          previous: { status: 'active' },
        });
        s.failNextRecompute();
        await expect(webhooks.handle(cancelled, JSON.stringify(cancelled))).rejects.toMatchObject({
          code: '40P01',
        });
        // A later edit (cancellation_details) lands before Stripe retries the first.
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
            id: sub,
            customerId,
            status: 'canceled',
            canceledAtSec: cancelledAt,
            previous: { cancellation_details: { comment: null } },
          }),
        );
        expect(await s.accountTier(accountId)).toBe('api_scale');

        await deliver(webhooks, cancelled);

        expect(
          await s.accountTier(accountId),
          'the redelivery, now older than the stored row, left the account on its paid plan',
        ).toBe('free');
      });

      it(`CRITICAL [${label}] a deleted event whose recompute hit a deadlock takes the plan away when Stripe redelivers it after a later edit`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        const deletedAt = nowSec() - 120;
        const deleted = subscriptionEvent('customer.subscription.deleted', deletedAt, {
          id: sub,
          customerId,
          status: 'canceled',
        });
        s.failNextRecompute();
        await expect(webhooks.handle(deleted, JSON.stringify(deleted))).rejects.toMatchObject({
          code: '40P01',
        });
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
            id: sub,
            customerId,
            status: 'canceled',
            canceledAtSec: deletedAt,
            previous: { metadata: { note: 'old' } },
          }),
        );
        expect(await s.accountTier(accountId)).toBe('api_scale');

        await deliver(webhooks, deleted);

        expect(
          await s.accountTier(accountId),
          'the redelivered deletion, now older than the stored row, left the account on its paid plan',
        ).toBe('free');
      });

      it(`CRITICAL [${label}] a stale metadata-only edit to a cancelled subscription recomputes nothing and keeps a plan staff set`, async () => {
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
            previous: { status: 'active' },
          }),
        );
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
            id: sub,
            customerId,
            status: 'canceled',
            canceledAtSec: cancelledAt,
            previous: { metadata: { note: 'newer' } },
          }),
        );
        await s.setPlanOutsideStripe(accountId, 'enterprise');
        const before = s.recomputes();

        // An OLDER edit that never changed the status, delivered late.
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 2 * DAY_S, {
            id: sub,
            customerId,
            status: 'canceled',
            canceledAtSec: cancelledAt,
            previous: { metadata: { note: 'old' } },
          }),
        );

        expect(s.recomputes() - before, 'a stale metadata-only edit recomputed the plan').toBe(0);
        expect(await s.accountTier(accountId)).toBe('enterprise');
      });

      it(`[${label}] control: a stale update from before the cancellation still recomputes nothing`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
            id: sub,
            customerId,
            status: 'canceled',
            previous: { status: 'active' },
          }),
        );
        await s.setPlanOutsideStripe(accountId, 'enterprise');
        const before = s.recomputes();

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 3 * DAY_S, {
            id: sub,
            customerId,
            status: 'active',
            previous: { cancel_at_period_end: false },
          }),
        );

        expect(s.recomputes() - before).toBe(0);
        expect(await s.accountTier(accountId)).toBe('enterprise');
      });

      it(`[${label}] control: a delivery that succeeds the first time recomputes once`, async () => {
        const s = makeSubject();
        const webhooks = service(s);
        const { accountId, customerId, sub } = await payingAccount(s, webhooks);
        const before = s.recomputes();

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 30, {
            id: sub,
            customerId,
            status: 'canceled',
            previous: { status: 'active' },
          }),
        );

        expect(s.recomputes() - before).toBe(1);
        expect(await s.accountTier(accountId)).toBe('free');
      });
    }
  },
);
