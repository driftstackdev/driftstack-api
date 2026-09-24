// An admin tier change is refused while the account is still paying by card or
// by crypto (live-billing audit #6).
//
// A tier an admin set by hand was silently undone by the next billing event of
// that account: the old subscription's `cancel_at_period_end` update reset the
// tier to the subscription's, its `deleted` event dropped it to free, and the
// crypto expiry sweep did the same when a crypto term ended. Moving a
// self-serve customer to Enterprise lasted until Stripe next spoke.
//
// So the change is now refused, with a message saying what to do first, while
// the account has a Stripe subscription that is still collecting (active,
// trialing or past_due) or a paid crypto term that has not ended. Enterprise
// moves are made after cancelling. A change on an account with nothing live
// works exactly as before, and naming the tier the account already holds is not
// a change and is not refused.
//
// Driven through the real AccountsAdminService with the production Drizzle
// repos on a Postgres rebuilt from the migrations.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAccountsAdminRepo } from '../../src/db/admin-accounts-repo.js';
import { DrizzleBillingRepo } from '../../src/db/billing-repo.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import { ConflictError } from '../../src/lib/errors.js';
import { AccountsAdminService } from '../../src/services/admin-accounts.js';
import type { AccountContext } from '../../src/services/auth.js';
import { BillingService, type BillingProvider } from '../../src/services/billing.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_live_billing_admin_tier';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const ADMIN_ID = '11111111-2222-4333-8444-666666666666';
const DAY_MS = 24 * 60 * 60 * 1000;

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

const noStripe = {} as BillingProvider;

function admin(): AccountsAdminService {
  const billing = new BillingService(new DrizzleBillingRepo(database()), noStripe, {
    tierPrices: {},
    defaultSuccessUrl: 'https://app.driftstack.io/billing/success',
    defaultCancelUrl: 'https://app.driftstack.io/billing/cancel',
    portalReturnUrl: 'https://app.driftstack.io/billing',
  });
  return new AccountsAdminService(
    new DrizzleAccountsAdminRepo(database(), null),
    null,
    null,
    null,
    null,
    null,
    null,
    billing,
  );
}

async function newAccount(tier: AccountTier): Promise<string> {
  const accountId = randomUUID();
  await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
             VALUES (${accountId}::uuid, ${`admin-tier-${accountId}@example.test`},
                     ${tier}::account_tier, ${`cus_${accountId.slice(0, 18)}`})`;
  return accountId;
}

async function subscription(
  accountId: string,
  status: 'active' | 'trialing' | 'past_due' | 'canceled',
): Promise<string> {
  const id = `sub_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await new DrizzleStripeWebhooksRepo(database()).upsertSubscription({
    accountId,
    stripeSubscriptionId: id,
    stripePriceId: 'price_starter_m',
    tier: 'api_starter',
    status,
    currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
    cancelAtPeriodEnd: false,
    canceledAt: status === 'canceled' ? new Date() : null,
    at: new Date(Date.now() - DAY_MS),
  });
  return id;
}

async function cryptoTerm(accountId: string, endsInDays: number): Promise<void> {
  await db()`INSERT INTO crypto_entitlements (account_id, order_id, tier, starts_at, expires_at)
             VALUES (${accountId}::uuid, ${`ord_${randomUUID().slice(0, 12)}`}, 'api_builder'::account_tier,
                     ${new Date(Date.now() - 5 * DAY_MS).toISOString()}::timestamptz,
                     ${new Date(Date.now() + endsInDays * DAY_MS).toISOString()}::timestamptz)`;
}

async function tierOf(accountId: string): Promise<string | null> {
  const [row] = await db()<Array<{ tier: string }>>`
    SELECT tier::text FROM accounts WHERE id = ${accountId}::uuid`;
  return row?.tier ?? null;
}

async function refusal(promise: Promise<unknown>): Promise<ConflictError> {
  try {
    await promise;
  } catch (err) {
    expect(err, 'refused, but not as a conflict').toBeInstanceOf(ConflictError);
    return err as ConflictError;
  }
  throw new Error('the tier change was NOT refused — the next billing event would undo it');
}

describe.skipIf(!RUN_DB_TESTS)(
  'an admin tier change is refused while the account is still paying by card or crypto',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it.each(['active', 'trialing', 'past_due'] as const)(
      'CRITICAL a %s Stripe subscription refuses a move to Enterprise, says to cancel it first, and leaves the tier alone',
      async (status) => {
        const accountId = await newAccount('api_starter');
        const subId = await subscription(accountId, status);

        const err = await refusal(admin().changeTier(ctx(), accountId, 'enterprise'));

        expect(err.message).toMatch(/cancel/i);
        expect(err.message).toContain(subId);
        expect(await tierOf(accountId)).toBe('api_starter');
      },
    );

    it('CRITICAL a crypto term that has not ended refuses the change, says when it ends, and leaves the tier alone', async () => {
      const accountId = await newAccount('api_builder');
      await cryptoTerm(accountId, 12);

      const err = await refusal(admin().changeTier(ctx(), accountId, 'enterprise'));

      expect(err.message).toMatch(/crypto/i);
      expect(err.message).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(await tierOf(accountId)).toBe('api_builder');
    });

    it('CONTROL a tier change on an account with nothing live — a canceled subscription and an ended crypto term — still works', async () => {
      const accountId = await newAccount('api_starter');
      await subscription(accountId, 'canceled');
      await cryptoTerm(accountId, -3);

      const updated = await admin().changeTier(ctx(), accountId, 'enterprise');

      expect(updated.tier).toBe('enterprise');
      expect(await tierOf(accountId)).toBe('enterprise');
    });

    it('naming the tier the account already holds is not a change and is not refused', async () => {
      const accountId = await newAccount('api_starter');
      await subscription(accountId, 'active');

      const updated = await admin().changeTier(ctx(), accountId, 'api_starter');

      expect(updated.tier).toBe('api_starter');
    });
  },
);
