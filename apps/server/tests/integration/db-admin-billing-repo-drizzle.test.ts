// Drizzle-backed integration test for DrizzleAdminBillingRepo.
//
// The last of the item-5e zero-coverage repos that is actually wired:
// bootstrap.ts:487 builds it for the admin cockpit's billing analytics. (The
// remaining one, audit-archive-repo, is constructed nowhere in src/ — verified,
// not inherited from the assessment — so a test there would cover SQL nothing
// calls.)
//
// One method, and it is the number a human reads to answer "how many paying
// customers do we have". Three separate things can make that number wrong and
// none of them throws:
//
//   the status filter   `inArray(status, ['active','trialing'])`. Stripe keeps
//                       cancelled, past_due, unpaid and paused rows in the same
//                       mirror table, so without the filter the cockpit counts
//                       churned customers as paying — the count only ever grows
//                       and never reflects a cancellation.
//
//   `trialing` included  the opposite direction: drop it from the set and every
//                       customer inside a trial disappears from the paying
//                       count, so the number dips exactly when signups rise.
//
//   `count(*)::int`      without the cast Postgres returns text, and the record
//                       claims to be Record<AccountTier, number> while holding
//                       strings. Arithmetic on it concatenates.
//
//   `emptyTierCounts()`  the record is zero-filled over the canonical enum
//                       first. Without it a tier with no subscriptions is
//                       absent rather than 0, and the cockpit renders undefined
//                       where a zero belongs.
//
// ─── isolation on a shared, globally-aggregated table ─────────────────────────
//
// `countActiveSubscriptionsByTier` groups the whole table with no caller scope,
// so an exact count is not assertable. Deltas are — but only if nothing else is
// writing the tier being measured concurrently. That was checked rather than
// assumed: exactly one other test file inserts into `subscriptions`
// (`db-billing-subscription-lookups-drizzle`), and it hardcodes tier
// `api_scale`. Every arm here therefore uses `agency_manual`, where this file is
// the only writer and a delta is exact rather than approximate.
//
// The one arm that reads other tiers exempts `api_scale` explicitly for that
// reason, rather than pretending the whole record is stable.
//
// MUTATION-PROVED against admin-billing-repo.ts — control 7/7 green:
//
//   the status filter dropped                1 red  (churn counted as paying)
//   `trialing` removed from the active set   1 red  (trials vanish)
//   `count(*)::int` cast dropped             3 red  (strings, not numbers)
//   the record no longer zero-filled         3 red  (absent tiers, not 0)
//
// The two status mutations fail in opposite directions and each takes a
// different arm, which is why they are separate arms rather than one combined
// "the status filter works". Like this module's sibling
// `cost-nightly-accounts-provider`, there is no source pin to compare against:
// the import-vs-pin sweep found both with neither an importer nor a pin.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountTierSchema, type AccountTier } from '@driftstack/api-types';
import { DrizzleAdminBillingRepo } from '../../src/db/admin-billing-repo.js';
import * as schema from '../../src/db/schema.js';
import { cleanDelta } from './_helpers/counter-delta.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** The one tier no other test file writes — see the isolation note above. */
const TIER: AccountTier = 'agency_manual';
/** The tier db-billing-subscription-lookups writes, so it may move under us. */

/**
 * V-1282 — buckets other files write inside any measurement window, so they are not ours to
 * claim. `free` is the accounts default; `api_scale` is written by
 * db-billing-subscription-lookups; `api_starter`, `api_scale` and TIER itself are seeded by
 * admin-billing-active-tier-repo-contract, which RETRIES on an interfered reading and so may
 * seed up to five times in a run. Every other tier stays constrained, so a count filed under
 * the wrong bucket is still caught.
 */
const NOISY_TIERS: ReadonlySet<string> = new Set(['free', 'api_scale', 'api_starter']);

type SubStatus = 'active' | 'trialing' | 'canceled' | 'past_due' | 'unpaid' | 'paused';

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAdminBillingRepo | null = null;
const seededAccounts: string[] = [];

async function seedSubscription(status: SubStatus, tier: AccountTier = TIER): Promise<void> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
    VALUES (${accountId}, ${`adminbilling-${accountId.slice(0, 8)}@example.test`},
            ${'Admin Billing Fixture'}, 'free'::account_tier, 'active'::account_status,
            now(), now())`;
  seededAccounts.push(accountId);
  const subId = randomUUID();
  await client`
    INSERT INTO subscriptions
      (id, account_id, stripe_subscription_id, stripe_price_id, tier, status, created_at)
    VALUES (${subId}, ${accountId}, ${`sub_${subId.slice(0, 12)}`}, ${'price_test'},
            ${tier}::account_tier, ${status}::subscription_status, now())`;
}

async function counts(): Promise<Record<AccountTier, number>> {
  if (!repo) throw new Error('no repo');
  return repo.countActiveSubscriptionsByTier();
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM subscriptions LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleAdminBillingRepo({ db: drizzle(client, { schema }) });
});

afterAll(async () => {
  if (client) {
    // subscriptions.account_id cascades from accounts.
    for (const id of seededAccounts) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleAdminBillingRepo (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and the table present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL every tier is present and zero-filled, including tiers nobody subscribes to. The record is built from the canonical enum before the rows are folded in; without that a tier with no subscriptions is absent rather than 0, and the cockpit renders undefined where a zero belongs.', async () => {
      if (!dbReachable || !repo) return;
      const got = await counts();
      for (const tier of AccountTierSchema.options) {
        expect(Object.hasOwn(got, tier), `tier ${tier} present`).toBe(true);
        expect(typeof got[tier], `tier ${tier} is a number`).toBe('number');
        expect(Number.isInteger(got[tier]), `tier ${tier} is a whole count`).toBe(true);
      }
    });

    it('CRITICAL an active subscription adds exactly one to its own tier. This is the number the cockpit reports as paying customers, so an increment landing on the wrong tier misattributes revenue between plans.', async () => {
      if (!dbReachable || !repo) return;
      await cleanDelta(
        counts,
        async () => {
          await seedSubscription('active');
        },
        { [TIER]: 1 },
        NOISY_TIERS,
      );
    });

    it('CRITICAL a trialing subscription counts as paying. Stripe reports a trial as its own status, and dropping it from the active set makes the paying count DIP exactly when signups rise — a metric that moves the wrong way under success is worse than one that is merely wrong.', async () => {
      if (!dbReachable || !repo) return;
      await cleanDelta(
        counts,
        async () => {
          await seedSubscription('trialing');
        },
        { [TIER]: 1 },
        NOISY_TIERS,
      );
    });

    it('CRITICAL cancelled, past_due, unpaid and paused subscriptions are NOT counted. Stripe keeps all of them in the same mirror table, so without the status filter the cockpit counts churned customers as paying and the number only ever grows — a cancellation would never show up at all.', async () => {
      if (!dbReachable || !repo) return;
      // Four unbilled rows must move NOTHING, so the expected vector is EMPTY and every tier
      // but the noisy ones is constrained to zero — a stronger statement than the single-bucket
      // delta this used to make.
      await cleanDelta(
        counts,
        async () => {
          await seedSubscription('canceled');
          await seedSubscription('past_due');
          await seedSubscription('unpaid');
          await seedSubscription('paused');
        },
        {},
        NOISY_TIERS,
      );
    });

    it('CRITICAL a subscription on one tier does not move another. The count is grouped by tier, and a grouping that collapsed would report the whole book against whichever tier sorted first.', async () => {
      if (!dbReachable || !repo) return;
      // The whole vector at once: TIER gains exactly one and every other constrained tier sits
      // still. That is what the per-tier loop below was reaching for, and cleanDelta states it
      // directly — including distinguishing a MISCOUNT from a concurrent writer, which the loop's
      // growing list of `continue` exemptions could only ever paper over.
      await cleanDelta(
        counts,
        async () => {
          await seedSubscription('active');
        },
        { [TIER]: 1 },
        NOISY_TIERS,
      );
    });

    it('CRITICAL the counts are numbers rather than the text Postgres returns for count(*). The signature promises Record<AccountTier, number>; without the ::int cast the values are strings, so any arithmetic downstream concatenates instead of adding and a total renders as digits glued together.', async () => {
      if (!dbReachable || !repo) return;
      await seedSubscription('active');
      const got = await counts();
      expect(typeof got[TIER], 'the populated tier is a number').toBe('number');
      // Adding 1 to the string "3" yields "31", which this catches and a
      // self-comparison would not.
      expect(String(got[TIER] + 1), 'addition adds rather than concatenates').not.toMatch(/^\d+1$/);
    });
  },
);
