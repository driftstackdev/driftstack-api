// The Stripe replay guard, executed as SQL rather than re-implemented.
//
// `StripeWebhooksService.handle` dedupes an event in two steps: a `hasEvent`
// short-circuit, and — for the race where two concurrent deliveries both pass
// that check — an `INSERT … ON CONFLICT DO NOTHING` whose `inserted` flag decides
// which delivery owns the event. The second step is the one that actually holds
// under concurrency, and it is pure SQL: a conflict on the `event_id` primary key
// must return zero rows rather than raise.
//
// The existing coverage exercises both paths, including the race, through
// `buildTestApp` — which wires an InMemory repo that re-implements
// `onConflictDoNothing` by hand. So the assertion has always been about the
// double's behaviour, never the shipped statement's.
//
// The failure that leaves is specific and loud in the wrong place: if the ON
// CONFLICT clause or its target were changed, a duplicate delivery would raise a
// unique-violation instead of returning `inserted: false`. Stripe sees a 500,
// retries on its schedule, and the event is never marked processed — a retry loop
// on an event that can never complete.
//
// Not isolated, deliberately: this is a two-row insert keyed by a random event id,
// not a whole-table sweep, so it does not fall under the global-operation rule
// that governs the purge tests.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];
const seededAccounts: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM processed_stripe_events LIMIT 0`;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const eventId of seeded) {
      await client`DELETE FROM processed_stripe_events WHERE event_id = ${eventId}`.catch(() => {});
    }
    for (const acct of seededAccounts) {
      await client`DELETE FROM subscriptions WHERE account_id = ${acct}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${acct}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'Stripe event idempotency (real Postgres)',
  () => {
    it('CRITICAL a repeated event id returns inserted:false instead of raising. That flag is what resolves two concurrent deliveries; if the conflict clause raised instead, Stripe would see a 500, retry on its own schedule, and the event would never be marked processed.', async () => {
      if (!client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG stripe-idempotency test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const pg = client;
      const db = drizzle(pg) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleStripeWebhooksRepo({ client: pg, db, close: async () => {} });

      const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
      seeded.push(eventId);
      const receivedAt = new Date('2026-07-01T00:00:00.000Z');

      expect(await repo.hasEvent(eventId), 'unknown before the first delivery').toBe(false);

      const first = await repo.recordEvent({
        eventId,
        eventType: 'checkout.session.completed',
        payloadHash: 'a'.repeat(64),
        result: 'handled',
        receivedAt,
      });
      expect(first.inserted, 'the first delivery owns the event').toBe(true);

      // The replay. A DIFFERENT payload hash and result on purpose: the conflict
      // target is the event id alone, so a duplicate must be rejected on identity
      // rather than on the row happening to match.
      const second = await repo.recordEvent({
        eventId,
        eventType: 'checkout.session.completed',
        payloadHash: 'b'.repeat(64),
        result: 'ignored',
        receivedAt: new Date('2026-07-02T00:00:00.000Z'),
      });
      expect(second.inserted, 'the replay must lose, not raise').toBe(false);

      expect(await repo.hasEvent(eventId)).toBe(true);

      // DO NOTHING, not DO UPDATE: the first delivery's record is authoritative,
      // so the replay must not have overwritten the stored outcome. Without this
      // an upsert would satisfy every assertion above while quietly rewriting
      // history on every retry.
      const [row] = await pg<Array<{ result: string; payload_hash: string }>>`
        SELECT result, payload_hash FROM processed_stripe_events WHERE event_id = ${eventId}`;
      expect(row?.result, "the first delivery's outcome stands").toBe('handled');
      expect(row?.payload_hash).toBe('a'.repeat(64));

      // Not destructured: `noUncheckedIndexedAccess` types an index access as
      // possibly-undefined, so `const [{ count }]` fails the tests typecheck even
      // though vitest runs it happily.
      const counted = await pg<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM processed_stripe_events WHERE event_id = ${eventId}`;
      expect(Number(counted[0]?.count), 'exactly one row survives the replay').toBe(1);
    });

    it('CRITICAL the event-recency guard runs against Postgres: a STRICTLY OLDER Stripe event must not overwrite a fresher mirror row, and an EQUAL-time event must still apply. Stripe re-delivers failed events for up to three days with no ordering guarantee, and callers gate the tier mutation on the applied boolean, so a guard that stopped biting lets a stale event move a customer tier. The setWhere uses <= rather than <, deliberately, because event.created is second-granularity -- a boundary no source-text pin can check.', async () => {
      if (!client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleStripeWebhooksRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seededAccounts.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`recency-${accountId}@test.local`})`;
      const subId = `sub_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

      const t1 = new Date('2026-03-01T00:00:00.000Z');
      const t2 = new Date('2026-03-02T00:00:00.000Z');
      const base = {
        accountId,
        stripeSubscriptionId: subId,
        stripePriceId: 'price_test',
        status: 'active' as const,
        currentPeriodEnd: t2,
        cancelAtPeriodEnd: false,
        canceledAt: null,
      };
      const tierOf = async (): Promise<string> => {
        const [r] =
          await client!`SELECT tier FROM subscriptions WHERE stripe_subscription_id = ${subId}`;
        return (r?.tier as string) ?? 'none';
      };
      const rowCount = async (): Promise<number> => {
        const [r] =
          await client!`SELECT count(*)::int AS n FROM subscriptions WHERE stripe_subscription_id = ${subId}`;
        return Number(r?.n ?? 0);
      };

      // 1. A fresh insert always applies.
      expect((await repo.upsertSubscription({ ...base, tier: 'free', at: t1 })).applied).toBe(true);
      expect(await tierOf()).toBe('free');

      // 2. A NEWER event applies and updates in place - one row, never two.
      expect(
        (await repo.upsertSubscription({ ...base, tier: 'solo_manual', at: t2 })).applied,
        'a newer event must apply',
      ).toBe(true);
      expect(await tierOf()).toBe('solo_manual');
      expect(await rowCount(), 'the upsert must update in place, never insert a duplicate').toBe(1);

      // 3. A STRICTLY OLDER event is rejected and must not move the tier.
      expect(
        (await repo.upsertSubscription({ ...base, tier: 'free', at: t1 })).applied,
        'a stale re-delivered event must NOT apply',
      ).toBe(false);
      expect(
        await tierOf(),
        'the stale event moved the tier - the recency guard is not biting',
      ).toBe('solo_manual');

      // 4. The <= boundary: an EQUAL-time event still applies, because
      // event.created is second-granularity and two ordered events can share one.
      expect(
        (await repo.upsertSubscription({ ...base, tier: 'free', at: t2 })).applied,
        'an equal-time event must still apply - the guard uses <= not <',
      ).toBe(true);
      expect(await tierOf()).toBe('free');
    });
  },
);
