// `DrizzleStripeWebhooksRepo.setAccountTierIfUpgrade` against real Postgres.
//
// This is the write that a paid crypto activation performs on an account's tier.
// Two properties carry it, and BOTH were uncovered:
//
//   the upgrade-only rule  — a stale or replayed order must never move a tier
//                            DOWN. Inverting `isCryptoTierUpgrade`'s arguments,
//                            so downgrades apply and upgrades are refused, left
//                            all 22,435 tests green.
//   the FOR UPDATE lock    — the decision is taken against the LOCKED committed
//                            tier so two activations serialise. Deleting
//                            `.for('update')` also left the suite green.
//
// The method's only test references were an in-memory twin and content-parity
// pins over the source text. A fake reimplements the method, so it can reproduce
// the rule while proving nothing about the SQL, and it has no notion of a row
// lock at all — the lock is only meaningful across real connections.
//
// The lock arm holds the row from an INDEPENDENT connection rather than racing
// two activations. A plain `Promise.all` of two calls does not distinguish the
// lock at all — both transactions are short enough that they rarely overlap, and
// deleting `.for('update')` left such an arm green on every run of three. That
// is the usual trap with concurrency tests: they pass for the wrong reason and
// then keep passing after the property is gone.
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

// tierActivationRank: free = 0, then the monthly price in cents.
// api_starter = 14900, api_scale = 149900.
const LOWER = 'api_starter' as const;
const HIGHER = 'api_scale' as const;

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
  // max: 5 so two concurrent transactions get DISTINCT connections — otherwise
  // the pool serialises them and the row lock is never what is being tested.
  client = postgres(DB_URL, { max: 5 });
  try {
    await client`SELECT 1 FROM accounts LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const id of seeded) {
    await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'setAccountTierIfUpgrade (real Postgres) — a paid activation can only move a tier UP',
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
      await client`
        INSERT INTO accounts (id, email, tier, status)
        VALUES (${id}, ${`crypto-tier-${id}@test.local`}, ${tier}::account_tier, 'active')`;
      return id;
    }

    async function tierOf(id: string): Promise<string> {
      if (!client) throw new Error('no client');
      const rows = await client<Array<{ tier: string }>>`
        SELECT tier FROM accounts WHERE id = ${id}`;
      return rows[0]?.tier ?? 'missing';
    }

    it('CRITICAL the database is reachable, so the arms below cannot pass vacuously', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and accounts present').toBe(true);
    });

    it('CRITICAL a stale order can never move a paying account DOWN a tier', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount(HIGHER);
      const result = await mkRepo().setAccountTierIfUpgrade({
        accountId,
        tier: LOWER,
        at: new Date(),
      });
      expect(result.applied, 'a downgrade is refused').toBe(false);
      expect(result.previousTier, 'and it reports what the account actually held').toBe(HIGHER);
      expect(await tierOf(accountId), 'the paid tier survives the stale order').toBe(HIGHER);
    });

    it('a genuine upgrade applies and reports the tier it replaced', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount('free');
      const result = await mkRepo().setAccountTierIfUpgrade({
        accountId,
        tier: LOWER,
        at: new Date(),
      });
      expect(result).toEqual({ previousTier: 'free', applied: true });
      expect(await tierOf(accountId)).toBe(LOWER);
    });

    it('re-applying the SAME tier is refused, so a replayed order is not double-counted', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount(LOWER);
      const result = await mkRepo().setAccountTierIfUpgrade({
        accountId,
        tier: LOWER,
        at: new Date(),
      });
      expect(result.applied, 'equal rank is not an upgrade').toBe(false);
      expect(await tierOf(accountId)).toBe(LOWER);
    });

    it('CRITICAL the decision is taken under a ROW LOCK, so it waits for a competing transaction', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount(HIGHER);

      // Hold the row lock from an independent connection, then drive the
      // DOWNGRADE path, which writes nothing. Without `.for('update')` that path
      // is a plain SELECT plus an early return and finishes in single-digit
      // milliseconds; with it, the SELECT must wait for the holder to commit. The
      // write path would block on the UPDATE either way, which is exactly why the
      // no-write path is the one that isolates the lock.
      //
      // `max: 1` so every statement below reuses the SAME connection and the
      // explicit BEGIN/COMMIT actually brackets the lock. The first attempt used
      // `holder.begin(cb)` and awaited the activation inside the callback, which
      // deadlocked: the transaction waited on the call that was waiting on the
      // transaction.
      const holder = postgres(DB_URL, { max: 1 });
      let settled = false;
      try {
        await holder`BEGIN`;
        await holder`SELECT tier FROM accounts WHERE id = ${accountId} FOR UPDATE`;

        const pending = mkRepo()
          .setAccountTierIfUpgrade({ accountId, tier: LOWER, at: new Date() })
          .then((r) => {
            settled = true;
            return r;
          });

        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled, 'the activation must still be waiting on the row lock').toBe(false);

        await holder`COMMIT`;
        const result = await pending;
        expect(settled, 'releasing the lock lets it through — so the wait was the lock').toBe(true);
        expect(result.applied, 'and the downgrade is still refused').toBe(false);
      } finally {
        await holder.end({ timeout: 5 }).catch(() => {});
      }

      expect(await tierOf(accountId), 'the paid tier survives').toBe(HIGHER);
    });
  },
);
