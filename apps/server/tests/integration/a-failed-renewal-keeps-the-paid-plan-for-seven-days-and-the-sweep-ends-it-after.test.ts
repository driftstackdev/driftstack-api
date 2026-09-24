// A failed renewal keeps the paid plan for seven days, and the sweep ends it
// after (live-billing audit #3).
//
// The first failed renewal moves a Stripe subscription to `past_due`, and the
// webhook dropped the account to the free plan at that moment. The published
// terms (8.5) promise at least seven days' written notice before a suspension
// for non-payment — the payment-failure email is that notice — and when Stripe's
// retry succeeded three days later the customer had paid the full month having
// spent part of it on free.
//
// Now the subscription remembers when it fell behind (`past_due_since`,
// migration 0141) and keeps granting its plan for seven days from then. A
// recovery inside the seven days never touches the plan. When the seven days
// run out, the next event takes the plan away — and when Stripe sends none, the
// past-due sweep does, once, and says nothing twice. `unpaid` still ends the
// plan at once, as `deleted` does.
//
// Driven through the real StripeWebhooksService and the real sweep, against the
// Drizzle repo on a Postgres rebuilt from the migrations and against the
// in-memory double. The sweep module is imported inside the arms that use it.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import type {
  AccountLifecycleService,
  LifecycleEvent,
} from '../../src/services/account-lifecycle.js';
import {
  StripeWebhooksService,
  type StripeEvent,
  type StripeWebhooksRepo,
} from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';

const ISOLATED_DB_NAME = 'driftstack_iso_past_due_grace';
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

interface Mirror {
  status: string;
  pastDueSince: Date | null;
  pastDueGraceEndedAt: Date | null;
}

interface Subject {
  label: string;
  repo: StripeWebhooksRepo;
  newCustomer: () => Promise<{ accountId: string; customerId: string }>;
  accountTier: (accountId: string) => Promise<AccountTier | null>;
  mirror: (stripeSubscriptionId: string) => Promise<Mirror | null>;
}

function drizzleSubject(): Subject {
  if (pool === null) throw new Error('isolated database unreachable');
  return {
    label: 'Drizzle on Postgres',
    repo: new DrizzleStripeWebhooksRepo(pool),
    newCustomer: async () => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
                 VALUES (${accountId}::uuid, ${`past-due-${accountId}@example.test`},
                         'free'::account_tier, ${customerId})`;
      return { accountId, customerId };
    },
    accountTier: async (accountId) => {
      const [row] = await db()<Array<{ tier: AccountTier }>>`
        SELECT tier::text AS tier FROM accounts WHERE id = ${accountId}::uuid`;
      return row?.tier ?? null;
    },
    mirror: async (stripeSubscriptionId) => {
      const [row] = await db()<
        Array<{ status: string; since: Date | null; ended: Date | null }>
      >`SELECT status::text AS status, past_due_since AS since, past_due_grace_ended_at AS ended
          FROM subscriptions WHERE stripe_subscription_id = ${stripeSubscriptionId}`;
      return row === undefined
        ? null
        : { status: row.status, pastDueSince: row.since, pastDueGraceEndedAt: row.ended };
    },
  };
}

function inMemorySubject(repo = new InMemoryStripeWebhooksRepo()): Subject {
  return {
    label: 'the in-memory double',
    repo,
    newCustomer: () => {
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      repo.registerAccount({ accountId, stripeCustomerId: customerId, tier: 'free' });
      return Promise.resolve({ accountId, customerId });
    },
    accountTier: (accountId) => Promise.resolve(repo.readAccount(accountId)?.tier ?? null),
    mirror: (stripeSubscriptionId) => {
      const row = repo
        .listSubscriptions()
        .find((s) => s.stripeSubscriptionId === stripeSubscriptionId) as
        | { status: string; pastDueSince?: Date | null; pastDueGraceEndedAt?: Date | null }
        | undefined;
      return Promise.resolve(
        row === undefined
          ? null
          : {
              status: row.status,
              pastDueSince: row.pastDueSince ?? null,
              pastDueGraceEndedAt: row.pastDueGraceEndedAt ?? null,
            },
      );
    },
  };
}

/** Records every lifecycle emit; the tier_changed ones are what a customer is told. */
function recordingLifecycle(): {
  lifecycle: AccountLifecycleService;
  tierChanges: (accountId?: string) => Array<{ from: AccountTier | null; to: AccountTier }>;
} {
  const events: Array<{ accountId: string; event: LifecycleEvent }> = [];
  return {
    lifecycle: {
      emit: (accountId: string, event: LifecycleEvent) => {
        events.push({ accountId, event });
        return Promise.resolve();
      },
    } as unknown as AccountLifecycleService,
    tierChanges: (accountId) =>
      events.flatMap(({ accountId: a, event: e }) =>
        e.kind === 'subscription.tier_changed' && (accountId === undefined || a === accountId)
          ? [{ from: e.fromTier, to: e.toTier }]
          : [],
      ),
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
    id: `evt_past_due_${String(seq)}_${randomUUID()}`,
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

async function deliver(service: StripeWebhooksService, event: StripeEvent): Promise<void> {
  expect(await service.handle(event, JSON.stringify(event))).toBe('handled');
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * A customer paying api_starter by card for ten days whose renewal failed
 * `failedSecondsAgo` ago: the subscription is past_due, and the account's plan
 * is whatever the webhook left it on.
 */
async function afterAFailedRenewal(
  s: Subject,
  failedSecondsAgo: number,
): Promise<{
  accountId: string;
  customerId: string;
  subId: string;
  webhooks: StripeWebhooksService;
  record: ReturnType<typeof recordingLifecycle>;
  failedAt: Date;
}> {
  const { accountId, customerId } = await s.newCustomer();
  const subId = `sub_${randomUUID()}`;
  const record = recordingLifecycle();
  const webhooks = new StripeWebhooksService(
    s.repo,
    { logger: silent, priceToTier: MAPS.priceToTier, priceToInterval: MAPS.priceToInterval },
    record.lifecycle,
  );
  const now = nowSec();
  await deliver(
    webhooks,
    subscriptionEvent('customer.subscription.created', now - 10 * DAY_S, {
      id: subId,
      customerId,
      status: 'active',
    }),
  );
  expect(await s.accountTier(accountId)).toBe('api_starter');
  const failedSec = now - failedSecondsAgo;
  await deliver(
    webhooks,
    subscriptionEvent('customer.subscription.updated', failedSec, {
      id: subId,
      customerId,
      status: 'past_due',
    }),
  );
  return { accountId, customerId, subId, webhooks, record, failedAt: new Date(failedSec * 1000) };
}

/**
 * The real sweep over the subject's repo. ⚠️ On Postgres every arm shares one
 * database, so a tick also processes other arms' accounts: arms assert on THEIR
 * account (its plan, its row, its emits), never on a tick's totals.
 */
async function sweeperFor(s: Subject, lifecycle?: AccountLifecycleService) {
  const { PastDueGraceSweeperService } =
    await import('../../src/services/past-due-grace-sweeper.js');
  return new PastDueGraceSweeperService({
    repo: s.repo,
    logger: silent,
    ...(lifecycle !== undefined ? { accountLifecycle: lifecycle } : {}),
  });
}

describe.skipIf(!RUN_DB_TESTS)(
  'a failed renewal keeps the paid plan for seven days, and the sweep ends it after',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const makeSubject of [drizzleSubject, inMemorySubject]) {
      const label = makeSubject === drizzleSubject ? 'Drizzle on Postgres' : 'the in-memory double';

      it(`CRITICAL [${label}] the first failed renewal keeps the paid plan, and the subscription records when it fell behind`, async () => {
        const s = makeSubject();
        const { accountId, subId, record, failedAt } = await afterAFailedRenewal(s, 60);

        expect(await s.accountTier(accountId), 'a failed renewal ended the plan at once').toBe(
          'api_starter',
        );
        expect(record.tierChanges(), 'the customer was told of a plan change').toEqual([
          { from: 'free', to: 'api_starter' },
        ]);
        const mirror = await s.mirror(subId);
        expect(mirror?.status).toBe('past_due');
        expect(mirror?.pastDueSince?.getTime()).toBe(failedAt.getTime());
        expect(mirror?.pastDueGraceEndedAt).toBeNull();
      });

      it(`CRITICAL [${label}] a payment that recovers within the seven days never takes the plan away, and clears the record`, async () => {
        const s = makeSubject();
        const { accountId, customerId, subId, webhooks, record, failedAt } =
          await afterAFailedRenewal(s, 3 * DAY_S);
        expect(await s.accountTier(accountId)).toBe('api_starter');

        // Another failed retry two days later: the spell's start does not move.
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - DAY_S, {
            id: subId,
            customerId,
            status: 'past_due',
          }),
        );
        expect((await s.mirror(subId))?.pastDueSince?.getTime()).toBe(failedAt.getTime());
        expect(await s.accountTier(accountId)).toBe('api_starter');

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('api_starter');
        expect(record.tierChanges(), 'the plan moved during the retries').toEqual([
          { from: 'free', to: 'api_starter' },
        ]);
        const mirror = await s.mirror(subId);
        expect(mirror?.status).toBe('active');
        expect(mirror?.pastDueSince).toBeNull();

        // Nothing is left for the sweep, even long after.
        const sweeper = await sweeperFor(s);
        await sweeper.tickOnce(new Date(Date.now() + 30 * DAY_MS));
        expect(await s.accountTier(accountId)).toBe('api_starter');
        expect((await s.mirror(subId))?.pastDueGraceEndedAt).toBeNull();
      });

      it(`CRITICAL [${label}] once the seven days pass with no event, the sweep takes the plan away — once, and not a day early`, async () => {
        const s = makeSubject();
        const { accountId, subId, record } = await afterAFailedRenewal(s, 60);
        const swept = recordingLifecycle();
        const sweeper = await sweeperFor(s, swept.lifecycle);

        await sweeper.tickOnce(new Date(Date.now() + 6 * DAY_MS));
        expect(await s.accountTier(accountId), 'the sweep ended the grace a day early').toBe(
          'api_starter',
        );
        expect((await s.mirror(subId))?.pastDueGraceEndedAt).toBeNull();

        const sevenDaysOn = new Date(Date.now() + 7 * DAY_MS + 2 * 60_000);
        const first = await sweeper.tickOnce(sevenDaysOn);
        expect(first.failed).toBe(0);
        expect(await s.accountTier(accountId)).toBe('free');
        expect((await s.mirror(subId))?.pastDueGraceEndedAt?.getTime()).toBe(sevenDaysOn.getTime());
        expect(swept.tierChanges(accountId)).toEqual([{ from: 'api_starter', to: 'free' }]);

        await sweeper.tickOnce(new Date(sevenDaysOn.getTime() + DAY_MS));
        expect(await s.accountTier(accountId)).toBe('free');
        expect(
          swept.tierChanges(accountId),
          'the sweep processed a spell twice and told the customer twice',
        ).toEqual([{ from: 'api_starter', to: 'free' }]);
        expect((await s.mirror(subId))?.pastDueGraceEndedAt?.getTime()).toBe(sevenDaysOn.getTime());
        // The webhook itself emitted only the original upgrade.
        expect(record.tierChanges(accountId)).toEqual([{ from: 'free', to: 'api_starter' }]);
      });

      it(`CRITICAL [${label}] unpaid ends the plan at once, as before`, async () => {
        const s = makeSubject();
        const { accountId, customerId, subId, webhooks } = await afterAFailedRenewal(s, 120);
        expect(await s.accountTier(accountId)).toBe('api_starter');
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
            id: subId,
            customerId,
            status: 'unpaid',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('free');
        const mirror = await s.mirror(subId);
        expect(mirror?.status).toBe('unpaid');
        expect(mirror?.pastDueSince, 'a row that left past_due kept its start').toBeNull();
      });

      it(`CRITICAL [${label}] a past_due event that arrives after its seven days are over ends the plan at once, and a late event from inside them does not hand it back`, async () => {
        const s = makeSubject();
        const { accountId, customerId, subId, webhooks } = await afterAFailedRenewal(s, 8 * DAY_S);
        expect(await s.accountTier(accountId), 'a grace already over was granted').toBe('free');

        // A retry of a past_due update created six days ago (inside the spell)
        // delivered now: the spell began eight days ago, so the plan stays gone.
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec() - 6 * DAY_S, {
            id: subId,
            customerId,
            status: 'past_due',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('free');
      });

      it(`[${label}] the sweep leaves alone a subscription that recovered between its read and its mark`, async () => {
        const s = makeSubject();
        const { accountId, customerId, subId, webhooks } = await afterAFailedRenewal(s, 60);
        const later = new Date(Date.now() + 8 * DAY_MS);
        const listed = await s.repo.listPastDueGraceEnded({ asOf: later, limit: 10_000 });
        const mine = listed.filter((r) => r.accountId === accountId);
        expect(mine).toHaveLength(1);

        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', nowSec(), {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        await s.repo.markPastDueGraceEnded({ ids: mine.map((r) => r.id), asOf: later });
        const mirror = await s.mirror(subId);
        expect(mirror?.status).toBe('active');
        expect(mirror?.pastDueGraceEndedAt).toBeNull();
        expect(await s.accountTier(accountId)).toBe('api_starter');
      });

      it(`[${label}] a spell the sweep has ended does not grant again, and falling behind again after a recovery starts a new seven days`, async () => {
        const s = makeSubject();
        const { accountId, customerId, subId, webhooks } = await afterAFailedRenewal(s, 60);
        const sweeper = await sweeperFor(s);
        await sweeper.tickOnce(new Date(Date.now() + 7 * DAY_MS + 60_000));
        expect(await s.accountTier(accountId)).toBe('free');

        // Recovery: the plan comes back. Then a new failure: a new seven days.
        const t = nowSec();
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', t + 1, {
            id: subId,
            customerId,
            status: 'active',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('api_starter');
        await deliver(
          webhooks,
          subscriptionEvent('customer.subscription.updated', t + 2, {
            id: subId,
            customerId,
            status: 'past_due',
          }),
        );
        expect(await s.accountTier(accountId)).toBe('api_starter');
        const mirror = await s.mirror(subId);
        expect(mirror?.pastDueGraceEndedAt).toBeNull();
        expect(mirror?.pastDueSince?.getTime()).toBe((t + 2) * 1000);
      });
    }

    it('CRITICAL [Drizzle on Postgres] a subscription that fell behind before migration 0141 recorded starts is given no grace it was never on', async () => {
      const s = drizzleSubject();
      const { accountId, customerId, subId, webhooks } = await afterAFailedRenewal(s, 3600);
      // As 0141 finds such a row: past_due, no recorded start, account downgraded.
      await db()`UPDATE subscriptions SET past_due_since = NULL
                 WHERE stripe_subscription_id = ${subId}`;
      await db()`UPDATE accounts SET tier = 'free'::account_tier WHERE id = ${accountId}::uuid`;

      await deliver(
        webhooks,
        subscriptionEvent('customer.subscription.updated', nowSec() - 60, {
          id: subId,
          customerId,
          status: 'past_due',
        }),
      );
      expect(await s.accountTier(accountId)).toBe('free');
      expect((await s.mirror(subId))?.pastDueSince).toBeNull();
      const sweeper = await sweeperFor(s);
      const listed = await s.repo.listPastDueGraceEnded({
        asOf: new Date(Date.now() + 30 * DAY_MS),
        limit: 1000,
      });
      expect(listed.some((r) => r.accountId === accountId)).toBe(false);
      await sweeper.tickOnce(new Date(Date.now() + 30 * DAY_MS));
      expect(await s.accountTier(accountId)).toBe('free');
    });

    it('[Drizzle on Postgres] the database refuses a past_due start on a row that is not past_due, and a sweep mark with no start', async () => {
      const s = drizzleSubject();
      const { subId } = await afterAFailedRenewal(s, 60);
      await expect(
        db()`UPDATE subscriptions SET status = 'active'::subscription_status
             WHERE stripe_subscription_id = ${subId}`,
      ).rejects.toThrow(/subscriptions_past_due_since/);
      await expect(
        db()`UPDATE subscriptions SET past_due_since = NULL, past_due_grace_ended_at = now()
             WHERE stripe_subscription_id = ${subId}`,
      ).rejects.toThrow(/subscriptions_past_due_grace_ended/);
    });
  },
);

describe('the past-due sweep alerts on failure and keeps its chain', () => {
  /** An in-memory repo whose recompute fails for the accounts named. */
  function failingFor(repo: InMemoryStripeWebhooksRepo, failing: Set<string>): StripeWebhooksRepo {
    return Object.assign(Object.create(repo) as StripeWebhooksRepo, {
      downgradeAccountTierToBestRemaining: (args: {
        accountId: string;
        fallbackTier: AccountTier;
        at: Date;
      }) =>
        failing.has(args.accountId)
          ? Promise.reject(new Error('the tier write failed'))
          : repo.downgradeAccountTierToBestRemaining(args),
    });
  }

  it('CRITICAL one account whose downgrade fails is alerted without its id, is retried next tick, and does not stop the others', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    const s = inMemorySubject(repo);
    const a = await afterAFailedRenewal(s, 60);
    const b = await afterAFailedRenewal(s, 60);
    const failing = new Set([a.accountId]);
    const alerts: Array<{ message: string; level: string; tags?: Record<string, string> }> = [];
    const errors: unknown[] = [];
    const { PastDueGraceSweeperService } =
      await import('../../src/services/past-due-grace-sweeper.js');
    const sweeper = new PastDueGraceSweeperService({
      repo: failingFor(repo, failing),
      logger: { ...silent, error: (o: unknown) => errors.push(o) },
      sentry: {
        captureMessage: (m) => {
          alerts.push({ message: m.message, level: m.level, tags: { ...m.tags } });
        },
      },
    });
    const at = new Date(Date.now() + 8 * DAY_MS);
    expect(await sweeper.tickOnce(at)).toEqual({ processed: 1, downgraded: 1, failed: 1 });
    expect(await s.accountTier(a.accountId)).toBe('api_starter');
    expect(await s.accountTier(b.accountId)).toBe('free');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe('error');
    expect(alerts[0]?.tags).toEqual({ kind: 'past_due_grace_downgrade_failed' });
    for (const id of [a.accountId, a.subId, b.accountId, b.subId]) {
      expect(alerts[0]?.message).not.toContain(id);
    }
    expect(JSON.stringify(errors)).toContain(a.accountId);

    failing.clear();
    expect(await sweeper.tickOnce(at)).toEqual({ processed: 1, downgraded: 1, failed: 0 });
    expect(await s.accountTier(a.accountId)).toBe('free');
  });

  it('a tick that fails whole is logged and alerted, and the job re-arms exactly once', async () => {
    const mod = await import('../../src/services/past-due-grace-sweeper.js');
    const alerts: string[] = [];
    const errors: unknown[] = [];
    const handlers = new Map<string, (job: { runAt: Date }) => Promise<void>>();
    const enqueued: Array<{ jobType: string; runAt: Date }> = [];
    const scheduledJobs = {
      register: (type: string, handler: (job: { runAt: Date }) => Promise<void>) => {
        handlers.set(type, handler);
      },
      enqueue: (args: { jobType: string; runAt: Date }) => {
        enqueued.push({ jobType: args.jobType, runAt: args.runAt });
        return Promise.resolve({ enqueued: true });
      },
    };
    const sweeper = new mod.PastDueGraceSweeperService({
      repo: {
        listPastDueGraceEnded: () => Promise.reject(new Error('the database went away')),
        markPastDueGraceEnded: () => Promise.resolve(),
        downgradeAccountTierToBestRemaining: () => Promise.reject(new Error('unreachable')),
      },
      logger: silent,
      sentry: { captureMessage: (m) => alerts.push(m.message) },
    });
    mod.registerPastDueGraceSweepJob({
      scheduledJobs: scheduledJobs as unknown as Parameters<
        typeof mod.registerPastDueGraceSweepJob
      >[0]['scheduledJobs'],
      sweeper,
      nowFn: () => 1_000_000,
      logger: { ...silent, error: (o: unknown) => errors.push(o) },
    });
    const handler = handlers.get(mod.PAST_DUE_GRACE_SWEEP_JOB_TYPE);
    expect(handler).toBeDefined();
    await handler?.({ runAt: new Date(1_000_000) });
    expect(errors).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(enqueued).toEqual([
      {
        jobType: 'billing.past_due_grace_sweep',
        runAt: new Date(1_000_000 + mod.PAST_DUE_GRACE_SWEEP_INTERVAL_MS),
      },
    ]);
  });
});
