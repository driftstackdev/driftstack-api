// `DrizzleStripeWebhooksRepo.setAccountTierToBestActive` against real Postgres.
//
// This is the tier recompute a Stripe subscription event runs. It exists so a
// routine update on a superseded LOWER subscription cannot downgrade an account
// that still holds a HIGHER active one, and it ranks in unexpired crypto
// entitlements for the same reason — a lower Stripe sub must not wipe a
// higher crypto-paid tier.
//
// Three rules carry that, and all three were uncovered. Measured by mutation at
// full unit scope before any of this was written:
//
//   gt(expiresAt, args.at) on entitlements  → compared against the epoch so every
//                                             entitlement counts: 22,447 green
//   inArray(status, active|trialing)        → any status counts:    22,447 green
//   .for('update')                          → lock removed:         22,447 green
//
// Every failure mode here points the same way — an account keeps a tier it is no
// longer paying for. An expired crypto entitlement keeps granting; a cancelled or
// past_due subscription keeps granting.
//
// Run scope: CI always (postgres:17, migrated). Local dev skips unless a
// reachable DATABASE_URL is set.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const LOWER = 'api_starter' as const; // rank 14900
const HIGHER = 'api_scale' as const; // rank 149900

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 3 });
  try {
    await client`SELECT 1 FROM crypto_entitlements LIMIT 0`;
    await client`SELECT 1 FROM subscriptions LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const id of seeded) {
    await client`DELETE FROM crypto_entitlements WHERE account_id = ${id}`.catch(() => {});
    await client`DELETE FROM subscriptions WHERE account_id = ${id}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'setAccountTierToBestActive (real Postgres) — only what is still PAID FOR counts',
  () => {
    const mkRepo = (): DrizzleStripeWebhooksRepo => {
      if (!client) throw new Error('no client');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      return new DrizzleStripeWebhooksRepo({ client, db, close: async () => {} });
    };

    async function seedAccount(tier: string): Promise<string> {
      if (!client) throw new Error('no client');
      const id = randomUUID();
      seeded.push(id);
      await client`INSERT INTO accounts (id, email, tier, status)
                   VALUES (${id}, ${`best-active-${id}@test.local`}, ${tier}::account_tier, 'active')`;
      return id;
    }

    async function addSubscription(accountId: string, tier: string, status: string): Promise<void> {
      if (!client) throw new Error('no client');
      await client`
        INSERT INTO subscriptions (id, account_id, stripe_subscription_id, stripe_price_id, tier, status)
        VALUES (${randomUUID()}, ${accountId}, ${`sub_${randomUUID()}`}, ${'price_x'},
                ${tier}::account_tier, ${status}::subscription_status)`;
    }

    async function addEntitlement(accountId: string, tier: string, expiresAt: Date): Promise<void> {
      if (!client) throw new Error('no client');
      await client`
        INSERT INTO crypto_entitlements (id, account_id, order_id, tier, starts_at, expires_at)
        VALUES (${randomUUID()}, ${accountId}, ${`ord_${randomUUID()}`}, ${tier}::account_tier,
                ${new Date(Date.now() - 86_400_000).toISOString()}::timestamptz,
                ${expiresAt.toISOString()}::timestamptz)`;
    }

    async function tierOf(id: string): Promise<string> {
      if (!client) throw new Error('no client');
      const rows = await client<Array<{ tier: string }>>`
        SELECT tier FROM accounts WHERE id = ${id}`;
      return rows[0]?.tier ?? 'missing';
    }

    const future = (): Date => new Date(Date.now() + 30 * 86_400_000);
    const past = (): Date => new Date(Date.now() - 86_400_000);

    it('CRITICAL the database is reachable and both tables present, so the arms cannot pass vacuously', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable, crypto_entitlements + subscriptions present').toBe(
        true,
      );
    });

    it('an active subscription sets the tier — the arm that keeps the exclusions honest', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount('free');
      await addSubscription(accountId, LOWER, 'active');
      const result = await mkRepo().setAccountTierToBestActive({ accountId, at: new Date() });
      expect(result).toEqual({ previousTier: 'free', appliedTier: LOWER });
      expect(await tierOf(accountId)).toBe(LOWER);
    });

    it('CRITICAL an unexpired crypto entitlement outranks a lower active subscription', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount('free');
      await addSubscription(accountId, LOWER, 'active');
      await addEntitlement(accountId, HIGHER, future());
      const result = await mkRepo().setAccountTierToBestActive({ accountId, at: new Date() });
      expect(result.appliedTier, 'the crypto-paid tier wins over the lower Stripe sub').toBe(
        HIGHER,
      );
      expect(await tierOf(accountId)).toBe(HIGHER);
    });

    it('CRITICAL an EXPIRED crypto entitlement grants nothing, so a lapsed purchase stops paying out', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount('free');
      await addSubscription(accountId, LOWER, 'active');
      await addEntitlement(accountId, HIGHER, past());
      const result = await mkRepo().setAccountTierToBestActive({ accountId, at: new Date() });
      expect(result.appliedTier, 'the lapsed entitlement is not ranked in').toBe(LOWER);
      expect(await tierOf(accountId)).toBe(LOWER);
    });

    it('CRITICAL a CANCELLED subscription grants nothing, so a lapsed customer does not keep the tier', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount('free');
      await addSubscription(accountId, HIGHER, 'canceled');
      const result = await mkRepo().setAccountTierToBestActive({ accountId, at: new Date() });
      // With no active set the method deliberately leaves the tier alone rather
      // than downgrading to a fallback, so `appliedTier` echoes the previous one.
      expect(result.appliedTier, 'a cancelled sub is not an active set').toBe('free');
      expect(await tierOf(accountId), 'and it certainly does not grant its tier').toBe('free');
    });

    it('CRITICAL the recompute is taken under a ROW LOCK, so it waits for a competing transaction', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount('free');
      // No active subscription and no entitlement, so this call takes the
      // write-free path. Only `.for('update')` can make it wait; a version
      // without the lock is a plain SELECT and an early return. (The write path
      // would block on the UPDATE regardless, which is why it cannot be used to
      // isolate the lock.)
      const holder = postgres(DB_URL, { max: 1 });
      let settled = false;
      try {
        await holder`BEGIN`;
        await holder`SELECT tier FROM accounts WHERE id = ${accountId} FOR UPDATE`;
        const pending = mkRepo()
          .setAccountTierToBestActive({ accountId, at: new Date() })
          .then((r) => {
            settled = true;
            return r;
          });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled, 'the recompute must still be waiting on the row lock').toBe(false);
        await holder`COMMIT`;
        await pending;
        expect(settled, 'releasing the lock lets it through — so the wait was the lock').toBe(true);
      } finally {
        await holder.end({ timeout: 5 }).catch(() => {});
      }
    });
  },
);
