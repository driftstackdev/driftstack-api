// Terminating an account cancels every subscription still collecting, and
// suspending one pauses them all (live-billing audit #1 and the second half of
// #4).
//
// TERMINATION. `deleteAccount` revoked sessions, keys and webhooks and never
// touched Stripe, so a terminated paying customer went on being charged every
// month — while no longer able to sign in and cancel. The Terms (14.5) say access
// ends at termination and fees are owed only up to it. Termination now cancels
// every subscription Stripe is still collecting on (active, trialing, past_due)
// AT ONCE, prorated, so the unused part of the period becomes a credit on the
// Stripe customer. Nothing is refunded automatically: staff get an alert that
// carries no identifier, and decide whether a refund is owed. The cancellation
// is written into the admin audit record the route hands in.
//
// A Stripe failure never fails the termination (the status change is already
// committed) and is never silent: the step is recorded as
// `account_reclaim_failed` / `billing_cancel`, exactly as a failed suspension
// pause is, and staff are alerted that a subscription may still be charging.
//
// SUSPENSION. Pause and resume used to reach only the NEWEST collecting
// subscription. An account can hold two (re-checkout is allowed while one is
// past_due), and the other went on billing a suspended customer. Every
// collecting subscription is now paused, and every one resumed.
//
// Driven through the real AccountsAdminService, BillingService and Drizzle repos
// on a Postgres rebuilt from the migrations; only Stripe is a recording double.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAccountsAdminRepo } from '../../src/db/admin-accounts-repo.js';
import { DrizzleBillingRepo } from '../../src/db/billing-repo.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { AccountsAdminService } from '../../src/services/admin-accounts.js';
import type { AccountContext } from '../../src/services/auth.js';
import { BillingService, type BillingProvider } from '../../src/services/billing.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_live_billing_terminate';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const ADMIN_ID = '11111111-2222-4333-8444-555555555555';

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

function database(): Database {
  if (pool === null) throw new Error('isolated database unreachable');
  return pool;
}

function ctx(): AccountContext {
  return {
    account: { id: ADMIN_ID, tier: 'enterprise', status: 'active' },
    apiKey: { id: ADMIN_ID, scopes: ['driftstack_internal_admin'] as ApiKeyScope[] },
    teams: [],
    rateLimitOverrides: {},
  } as unknown as AccountContext;
}

/** Stripe, recorded. `failCancelOf` names subscriptions whose cancel Stripe refuses. */
class RecordingStripe implements BillingProvider {
  readonly calls: string[] = [];
  constructor(private readonly failCancelOf: ReadonlySet<string> = new Set()) {}
  ensureCustomer(): Promise<string> {
    return Promise.resolve('cus_unused');
  }
  createSubscriptionCheckout(): Promise<{ url: string; sessionId: string }> {
    return Promise.reject(new Error('not used'));
  }
  createPortalSession(): Promise<{ url: string }> {
    return Promise.reject(new Error('not used'));
  }
  pauseSubscriptionCollection(args: { subscriptionId: string }): Promise<void> {
    this.calls.push(`pause:${args.subscriptionId}`);
    return Promise.resolve();
  }
  resumeSubscriptionCollection(args: { subscriptionId: string }): Promise<void> {
    this.calls.push(`resume:${args.subscriptionId}`);
    return Promise.resolve();
  }
  cancelSubscriptionNow(args: { subscriptionId: string }): Promise<void> {
    if (this.failCancelOf.has(args.subscriptionId)) {
      this.calls.push(`cancel-refused:${args.subscriptionId}`);
      return Promise.reject(Object.assign(new Error('Stripe 503'), { status: 503 }));
    }
    this.calls.push(`cancel:${args.subscriptionId}`);
    return Promise.resolve();
  }
}

/** The same Stripe with no way to cancel — a provider nobody has taught to. */
class StripeThatCannotCancel implements BillingProvider {
  ensureCustomer(): Promise<string> {
    return Promise.resolve('cus_unused');
  }
  createSubscriptionCheckout(): Promise<{ url: string; sessionId: string }> {
    return Promise.reject(new Error('not used'));
  }
  createPortalSession(): Promise<{ url: string }> {
    return Promise.reject(new Error('not used'));
  }
  pauseSubscriptionCollection(): Promise<void> {
    return Promise.resolve();
  }
  resumeSubscriptionCollection(): Promise<void> {
    return Promise.resolve();
  }
}

function billingOn(provider: BillingProvider): BillingService {
  return new BillingService(new DrizzleBillingRepo(database()), provider, {
    tierPrices: {},
    defaultSuccessUrl: 'https://app.driftstack.io/billing/success',
    defaultCancelUrl: 'https://app.driftstack.io/billing/cancel',
    portalReturnUrl: 'https://app.driftstack.io/billing',
  });
}

interface Harness {
  admin: AccountsAdminService;
  errors: Array<Record<string, unknown>>;
  alerts: SentryMessage[];
}

function adminWith(billing: BillingService): Harness {
  const errors: Array<Record<string, unknown>> = [];
  const alerts: SentryMessage[] = [];
  const logger = {
    error: (obj: Record<string, unknown>) => {
      errors.push(obj);
    },
    warn: () => {},
  };
  const admin = new AccountsAdminService(
    new DrizzleAccountsAdminRepo(database(), null),
    null,
    null,
    null,
    null,
    null,
    logger,
    billing,
    null,
    {
      captureMessage: (msg: SentryMessage) => {
        alerts.push(msg);
      },
    },
  );
  return { admin, errors, alerts };
}

async function newAccount(tier: AccountTier = 'api_starter'): Promise<{
  accountId: string;
  customerId: string;
}> {
  const accountId = randomUUID();
  const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
  await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
             VALUES (${accountId}::uuid, ${`terminate-${accountId}@example.test`},
                     ${tier}::account_tier, ${customerId})`;
  return { accountId, customerId };
}

/** A mirrored subscription, written by the production mirror writer. */
async function subscription(
  accountId: string,
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid',
  at: string,
): Promise<string> {
  const id = `sub_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const { applied } = await new DrizzleStripeWebhooksRepo(database()).upsertSubscription({
    accountId,
    stripeSubscriptionId: id,
    stripePriceId: 'price_starter_m',
    tier: 'api_starter',
    status,
    currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    canceledAt: status === 'canceled' ? new Date(at) : null,
    at: new Date(at),
  });
  expect(applied).toBe(true);
  return id;
}

async function statusOf(accountId: string): Promise<string | null> {
  const [row] = await db()<Array<{ status: string }>>`
    SELECT status::text FROM accounts WHERE id = ${accountId}::uuid`;
  return row?.status ?? null;
}

function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}

describe.skipIf(!RUN_DB_TESTS)(
  'terminating an account cancels every subscription still collecting, and suspending pauses them all',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL suspension pauses EVERY collecting subscription of the account — not only the newest — and leaves a canceled one alone; reinstating resumes every one', async () => {
      const { accountId } = await newAccount();
      const older = await subscription(accountId, 'past_due', '2026-08-01T00:00:00Z');
      const newer = await subscription(accountId, 'active', '2026-08-20T00:00:00Z');
      const trial = await subscription(accountId, 'trialing', '2026-08-10T00:00:00Z');
      const gone = await subscription(accountId, 'canceled', '2026-07-01T00:00:00Z');
      const stripe = new RecordingStripe();
      const { admin, errors } = adminWith(billingOn(stripe));

      await admin.suspend(ctx(), accountId);
      expect(
        sorted(stripe.calls),
        'a suspended customer went on being billed by a subscription that was not paused',
      ).toEqual(sorted([`pause:${older}`, `pause:${newer}`, `pause:${trial}`]));
      expect(stripe.calls).not.toContain(`pause:${gone}`);

      stripe.calls.length = 0;
      await admin.unsuspend(ctx(), accountId);
      expect(sorted(stripe.calls)).toEqual(
        sorted([`resume:${older}`, `resume:${newer}`, `resume:${trial}`]),
      );
      expect(errors).toEqual([]);
    });

    it('CRITICAL termination cancels every collecting subscription at once, records it in the audit row, and alerts staff WITHOUT naming the account', async () => {
      const { accountId, customerId } = await newAccount();
      const active = await subscription(accountId, 'active', '2026-08-20T00:00:00Z');
      const pastDue = await subscription(accountId, 'past_due', '2026-08-01T00:00:00Z');
      const gone = await subscription(accountId, 'canceled', '2026-07-01T00:00:00Z');
      const stripe = new RecordingStripe();
      const { admin, errors, alerts } = adminWith(billingOn(stripe));
      const auditRecord: Record<string, unknown> = { reason: 'terms violation' };

      const row = await admin.deleteAccount(ctx(), accountId, auditRecord);

      expect(row.status).toBe('deleted');
      expect(await statusOf(accountId)).toBe('deleted');
      expect(
        sorted(stripe.calls),
        'a terminated account was left with a subscription that goes on charging',
      ).toEqual(sorted([`cancel:${active}`, `cancel:${pastDue}`]));
      expect(stripe.calls).not.toContain(`cancel:${gone}`);
      expect(errors).toEqual([]);

      expect(sorted(auditRecord.stripe_subscriptions_cancelled as string[])).toEqual(
        sorted([active, pastDue]),
      );
      expect(auditRecord.reason, 'the route’s own payload was replaced').toBe('terms violation');

      expect(alerts).toHaveLength(1);
      const alert = alerts[0]!;
      expect(alert.message).toMatch(/refund/i);
      expect(alert.message).toMatch(/14\.5/);
      const everything = JSON.stringify(alert);
      for (const id of [accountId, customerId, active, pastDue]) {
        expect(everything, `the alert carries an identifier (${id})`).not.toContain(id);
      }
    });

    it('CRITICAL a Stripe failure does not fail the termination and is never silent: the step is recorded, staff are alerted, and the other subscription is still cancelled', async () => {
      const { accountId } = await newAccount();
      const refused = await subscription(accountId, 'active', '2026-08-20T00:00:00Z');
      const other = await subscription(accountId, 'past_due', '2026-08-01T00:00:00Z');
      const stripe = new RecordingStripe(new Set([refused]));
      const { admin, errors, alerts } = adminWith(billingOn(stripe));
      const auditRecord: Record<string, unknown> = {};

      const row = await admin.deleteAccount(ctx(), accountId, auditRecord);

      expect(row.status).toBe('deleted');
      expect(stripe.calls).toContain(`cancel:${other}`);
      const alarm = errors.find((e) => e.event === 'account_reclaim_failed');
      expect(alarm, 'a failed cancel was swallowed without a record').toBeDefined();
      expect(alarm?.step).toBe('billing_cancel');
      expect(alarm?.account_id).toBe(accountId);

      expect(auditRecord.stripe_subscriptions_cancelled).toEqual([other]);
      expect(auditRecord.stripe_subscriptions_not_cancelled).toEqual([refused]);

      const failure = alerts.find((a) => a.level === 'error');
      expect(failure, 'staff were not told a subscription may still be charging').toBeDefined();
      expect(JSON.stringify(failure)).not.toContain(accountId);
      expect(JSON.stringify(failure)).not.toContain(refused);
    });

    it('an account with nothing collecting is a normal termination: no Stripe call, no alarm, no alert', async () => {
      const { accountId } = await newAccount('free');
      await subscription(accountId, 'canceled', '2026-07-01T00:00:00Z');
      const stripe = new RecordingStripe();
      const { admin, errors, alerts } = adminWith(billingOn(stripe));
      const auditRecord: Record<string, unknown> = {};

      await admin.deleteAccount(ctx(), accountId, auditRecord);

      expect(stripe.calls).toEqual([]);
      expect(errors).toEqual([]);
      expect(alerts).toEqual([]);
      expect(auditRecord.stripe_subscriptions_cancelled).toEqual([]);
    });

    it('a billing provider that cannot cancel is never a silent skip: the paying account is terminated, the step is recorded, and staff are alerted', async () => {
      const { accountId } = await newAccount();
      await subscription(accountId, 'active', '2026-08-20T00:00:00Z');
      const { admin, errors, alerts } = adminWith(billingOn(new StripeThatCannotCancel()));

      const row = await admin.deleteAccount(ctx(), accountId);

      expect(row.status).toBe('deleted');
      expect(errors.find((e) => e.event === 'account_reclaim_failed')?.step).toBe('billing_cancel');
      expect(alerts.some((a) => a.level === 'error')).toBe(true);
    });
  },
);
