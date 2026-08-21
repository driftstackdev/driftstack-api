// V-1227 — one contract for subscription selection, against BOTH implementations of `BillingRepo`.
//
// The seventeenth of the twenty-nine. Three lookups sit on the entitlement path and differ only in
// which statuses they accept, so the property they share is an ORDER OF OPERATIONS:
//
//   findActiveSubscription      status ∈ {active, trialing}              -> newest of those
//   findCollectingSubscription  status ∈ {active, trialing, past_due}    -> newest of those
//   findCurrentSubscription     any status                               -> newest overall
//
// FILTER FIRST, THEN TAKE THE NEWEST OF WHAT SURVIVES. Reversed — newest row first, then check its
// status — a customer who cancelled and resubscribed reads as having no active subscription,
// because the cancelled row is the newest one and it fails the status test. That inversion is a
// recorded defect: the double's own comment says the old guard "read the newest ROW regardless of
// status, so a canceled row sorting newer than a live one let a second concurrently-billed
// subscription through", and notes the twin had the same bug, "which is why no existing test could
// catch it". Both were fixed in V-741 and V-767. Nothing pins the fix across the pair.
//
// THE FIXTURE PUTS A CANCELLED ROW NEWEST ON PURPOSE. With the live row newest, filter-first and
// filter-second agree and the arm proves nothing — the same vacuity trap as V-1209's backdate
// direction and V-1210's creation order. The cancelled row is created LAST so the two orders
// disagree, which is the only arrangement where the assertion can fail.
//
// `findCurrentSubscription` is pinned alongside them precisely BECAUSE it takes the newest
// regardless of status: it is the one lookup that SHOULD return the cancelled row, and it backs
// customer-facing copy about what happened to a subscription. Without it, "filter first" is
// satisfied by an implementation that filters everywhere, including where it must not.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { BillingRepo, SubscriptionMirror } from '../../src/services/billing.js';
import { DrizzleBillingRepo } from '../../src/db/billing-repo.js';
import { InMemoryBillingRepo } from './_helpers/in-memory-billing.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const OLDER = new Date('2026-08-01T00:00:00.000Z');
const NEWER = new Date('2026-08-15T00:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

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
    for (const a of seeded) {
      await client`DELETE FROM subscriptions WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

type Status = SubscriptionMirror['status'];

interface Subject {
  repo: BillingRepo;
  account: () => Promise<string>;
  sub: (accountId: string, status: Status, createdAt: Date) => Promise<string>;
}

function inMemorySubject(): Subject {
  const repo = new InMemoryBillingRepo();
  return {
    repo,
    account: () => {
      const id = randomUUID();
      repo.upsertAccount({
        id,
        email: `bill-${id}@test.local`,
        name: null,
        tier: 'free',
        stripeCustomerId: null,
      });
      return Promise.resolve(id);
    },
    sub: (accountId, status, createdAt) => {
      const id = randomUUID();
      repo.upsertSubscription({
        id,
        accountId,
        stripeSubscriptionId: `sub_${id.slice(0, 12)}`,
        stripePriceId: 'price_contract',
        tier: 'solo_manual',
        status,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        createdAt,
        updatedAt: createdAt,
      });
      return Promise.resolve(id);
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    // DrizzleBillingRepo takes Pick<Database, 'db'> — no client, no close. vitest accepted the
    // extra keys because esbuild strips types without checking them; strict tsc did not.
    repo: new DrizzleBillingRepo({ db }),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`bill-${id}@test.local`})`;
      return id;
    },
    sub: async (accountId, status, createdAt) => {
      const id = randomUUID();
      await c`INSERT INTO subscriptions
                (id, account_id, stripe_subscription_id, stripe_price_id, tier, status,
                 cancel_at_period_end, created_at, updated_at)
              VALUES (${id}::uuid, ${accountId}::uuid, ${`sub_${id.slice(0, 12)}`},
                      'price_contract', 'solo_manual', ${status}, false,
                      ${createdAt.toISOString()}::timestamptz,
                      ${createdAt.toISOString()}::timestamptz)`;
      return id;
    },
  };
}

function subscriptionSelectionContract(
  label: string,
  make: () => Subject,
  enabled: () => boolean,
): void {
  describe(`BillingRepo subscription-selection contract — ${label}`, () => {
    it('CRITICAL findActiveSubscription filters by status FIRST, then takes the newest of what survives, in both. The fixture puts the CANCELLED row newest on purpose: reversed, a customer who cancelled and resubscribed reads as having no active subscription, because the cancelled row is newest and fails the status test. That inversion is the recorded V-741 defect.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const live = await s.sub(account, 'active', OLDER);
      await s.sub(account, 'canceled', NEWER);

      const found = await s.repo.findActiveSubscription(account);
      expect(found?.id, 'a newer cancelled row hid the live subscription').toBe(live);
    });

    it('CRITICAL findCollectingSubscription accepts past_due as still collecting, in both. A card that failed once is not a cancelled subscription — treating it as one stops collection on a customer Stripe is still retrying.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const pastDue = await s.sub(account, 'past_due', OLDER);
      await s.sub(account, 'canceled', NEWER);

      expect(
        (await s.repo.findCollectingSubscription(account))?.id,
        'a past_due subscription was not treated as collecting',
      ).toBe(pastDue);
    });

    it('CRITICAL findActiveSubscription does NOT accept past_due, in both. The two lookups differ by exactly that status, so an implementation sharing one filter would either bill a cancelled customer or grant entitlements to a failed card.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await s.sub(account, 'past_due', NEWER);

      expect(
        await s.repo.findActiveSubscription(account),
        'a past_due subscription was reported as active',
      ).toBeNull();
    });

    it('CRITICAL findCurrentSubscription takes the newest REGARDLESS of status, in both. It is the one lookup that must return the cancelled row — it backs customer-facing copy about what happened to a subscription — so without it "filter first" is satisfied by an implementation that filters everywhere, including where it must not.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await s.sub(account, 'active', OLDER);
      const cancelled = await s.sub(account, 'canceled', NEWER);

      expect(
        (await s.repo.findCurrentSubscription(account))?.id,
        'the most recent subscription was filtered out by status',
      ).toBe(cancelled);
    });

    it("CRITICAL every lookup is account-scoped, in both. Another customer's active subscription granting entitlements here is both a billing error and a disclosure.", async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      await s.sub(stranger, 'active', NEWER);

      expect(
        await s.repo.findActiveSubscription(owner),
        "another account's subscription was returned",
      ).toBeNull();
      expect(
        await s.repo.findCurrentSubscription(owner),
        "another account's subscription was returned",
      ).toBeNull();
    });
  });
}

subscriptionSelectionContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'BillingRepo subscription-selection contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    subscriptionSelectionContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
