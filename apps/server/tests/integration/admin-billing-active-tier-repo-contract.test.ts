// V-1238 — one contract for the active-subscription-by-tier aggregate, against BOTH
// implementations of `AdminBillingRepo`.
//
// The twenty-seventh of the twenty-nine. One method, and it produces the paying-customer count per
// tier on the admin cockpit — the number staff read to answer "how many subscribers do we have".
//
//   Drizzle  SELECT tier, count(*)::int FROM subscriptions
//              WHERE status IN (ACTIVE_SUBSCRIPTION_STATUSES) GROUP BY tier,
//            zero-filled from AccountTierSchema.options
//
//   double   the same aggregate over seeded rows, previously with the billed-status set
//            RESTATED as `status === 'active' || status === 'trialing'`
//
// TWO LISTS OF THE SAME TWO STRINGS. They agreed, so nothing was wrong today, and nothing would
// have reported it on the day they stopped agreeing. Stripe keeps billing a `past_due`
// subscription through its retry window, so "billed" gaining a third status is a plausible edit
// rather than a hypothetical one — and it would have moved the real revenue figure while every
// test standing on the double went on asserting the old one, agreeing with itself the whole time.
// The constant is now exported and the double reads it.
//
// THIS FILE DERIVES BOTH SETS RATHER THAN NAMING THEM. The billed statuses come from the exported
// constant and the unbilled ones are the `subscription_status` enum MINUS that constant. So adding
// a status to either enum extends the contract on its own: a new billed status gets an arm that
// says it counts, a new unbilled one gets an arm that says it does not. A test that hardcoded
// 'active' and 'trialing' would be a third copy of the very list this finding is about.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { AccountTierSchema } from '@driftstack/api-types';
import type { AdminBillingRepo } from '../../src/services/admin-billing.js';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  DrizzleAdminBillingRepo,
} from '../../src/db/admin-billing-repo.js';
import { InMemoryAdminBillingRepo } from './_helpers/in-memory-admin-billing-repo.js';
import { subscriptionStatus, subscriptions } from '../../src/db/schema.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const BILLED: readonly string[] = ACTIVE_SUBSCRIPTION_STATUSES;
const UNBILLED = subscriptionStatus.enumValues.filter((s) => !BILLED.includes(s));

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seededAccounts: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM subscriptions LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const a of seededAccounts) {
      await client`DELETE FROM subscriptions WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: AdminBillingRepo;
  seed: (tier: (typeof AccountTierSchema.options)[number], status: string) => Promise<void>;
}

function inMemorySubject(): Subject {
  const repo = new InMemoryAdminBillingRepo();
  return {
    repo,
    seed: (tier, status) => {
      repo.upsertSubscription({ tier, status });
      return Promise.resolve();
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleAdminBillingRepo({ db }),
    // Through Drizzle's insert, not a raw template: `tier` and `status` are Postgres enums
    // and postgres-js mis-serialises them alongside a timestamp in a raw parameter list.
    seed: async (tier, status) => {
      const accountId = randomUUID();
      seededAccounts.push(accountId);
      const tag = accountId.slice(0, 8);
      await c`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`billing-${accountId}@test.local`})`;
      await db.insert(subscriptions).values({
        accountId,
        stripeSubscriptionId: `sub_${tag}`,
        stripePriceId: `price_${tag}`,
        tier,
        status: status as (typeof subscriptionStatus.enumValues)[number],
      });
    },
  };
}

function activeTierContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`AdminBillingRepo active-by-tier contract — ${label}`, () => {
    it('CRITICAL the aggregate reports EVERY tier in the enum, including tiers nobody subscribes to, in both. The cockpit renders one row per key it is handed, so a tier missing from the map vanishes from the page rather than showing a zero — and a tier added to the enum later has to appear without anyone remembering this file.', async () => {
      if (!enabled()) return;
      const s = make();

      const counts = await s.repo.countActiveSubscriptionsByTier();
      expect(
        Object.keys(counts).sort(),
        'the tier map does not have exactly one key per enum option',
      ).toEqual([...AccountTierSchema.options].sort());
      for (const tier of AccountTierSchema.options) {
        expect(typeof counts[tier], `tier ${tier} is not a number at runtime`).toBe('number');
      }
    });

    it.each([...BILLED])(
      'CRITICAL a %s subscription COUNTS as paying, in both. The billed-status set is read from ACTIVE_SUBSCRIPTION_STATUSES rather than restated here, so a status added to that constant arrives with an arm of its own instead of silently going uncounted by a test that names two strings.',
      async (status) => {
        if (!enabled()) return;
        const s = make();
        const before = (await s.repo.countActiveSubscriptionsByTier()).api_scale;
        await s.seed('api_scale', status);

        expect(
          (await s.repo.countActiveSubscriptionsByTier()).api_scale - before,
          `a subscription in the billed status "${status}" was not counted`,
        ).toBe(1);
      },
    );

    it.each([...UNBILLED])(
      'CRITICAL a %s subscription does NOT count as paying, in both. These are the subscriptions Stripe is not charging; counting them reports revenue the platform is not collecting, and the figure looks healthy precisely while it is not.',
      async (status) => {
        if (!enabled()) return;
        const s = make();
        const before = (await s.repo.countActiveSubscriptionsByTier()).api_scale;
        await s.seed('api_scale', status);

        expect(
          (await s.repo.countActiveSubscriptionsByTier()).api_scale - before,
          `a subscription in the unbilled status "${status}" was counted as paying`,
        ).toBe(0);
      },
    );

    it('CRITICAL a subscription is attributed to its OWN tier, in both. Without this the arms above are satisfied by an implementation that puts every subscription in one bucket, which reads as one tier carrying the whole platform.', async () => {
      if (!enabled()) return;
      const s = make();
      const before = await s.repo.countActiveSubscriptionsByTier();
      await s.seed('agency_manual', 'active');
      const after = await s.repo.countActiveSubscriptionsByTier();

      expect(
        after.agency_manual - before.agency_manual,
        'the subscription was not counted under its own tier',
      ).toBe(1);
      expect(
        after.api_scale - before.api_scale,
        'it was also counted under a tier it does not belong to',
      ).toBe(0);
    });

    it('CRITICAL subscriptions ACCUMULATE within a tier, in both. Otherwise every arm above is satisfied by an implementation that reports 1 for any tier it has seen and never actually counts.', async () => {
      if (!enabled()) return;
      const s = make();
      const before = (await s.repo.countActiveSubscriptionsByTier()).api_starter;
      await s.seed('api_starter', 'active');
      await s.seed('api_starter', 'active');
      await s.seed('api_starter', 'trialing');

      expect(
        (await s.repo.countActiveSubscriptionsByTier()).api_starter - before,
        'three paying subscriptions in one tier did not add up',
      ).toBe(3);
    });

    it('CRITICAL the counts are NUMBERS at runtime, in both. count(*) is a bigint and postgres-js hands bigints back as strings; the `::int` cast is what makes this a number, and without it the first arithmetic on the figure concatenates instead of adding.', async () => {
      if (!enabled()) return;
      const s = make();
      await s.seed('enterprise', 'active');

      const counts = await s.repo.countActiveSubscriptionsByTier();
      expect(typeof counts.enterprise, 'the enterprise count is not a number at runtime').toBe(
        'number',
      );
    });
  });
}

// Ungated on purpose: `it.each` over an empty array registers ZERO tests and reports green, so a
// derivation that quietly produced nothing would look like a passing contract rather than an
// absent one. This runs whether or not a database is reachable.
describe('AdminBillingRepo active-by-tier contract — the derived sets', () => {
  it('CRITICAL both derived status sets are non-empty, so neither .each arm is vacuously zero-length', () => {
    expect(
      BILLED.length,
      'no billed statuses — the "counts as paying" arms would register no tests',
    ).toBeGreaterThan(0);
    expect(
      UNBILLED.length,
      'no unbilled statuses — the "does not count" arms would register no tests',
    ).toBeGreaterThan(0);
  });

  it('CRITICAL the two sets are disjoint and together cover the whole subscription_status enum, so no status escapes the contract by belonging to neither', () => {
    expect(
      [...BILLED, ...UNBILLED].sort(),
      'the billed and unbilled sets do not partition the enum',
    ).toEqual([...subscriptionStatus.enumValues].sort());
  });
});

activeTierContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'AdminBillingRepo active-by-tier contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    activeTierContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
