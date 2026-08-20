// V-767 — the three subscription lookups, against a REAL Postgres.
//
// `BillingRepo` has three superficially similar lookups and picking the wrong one is a money
// bug. Nothing covered them against real SQL before this file, which is how V-758 shipped
// using a DISPLAY helper for a billing operation.
//
//   findCurrentSubscription    newest row by created_at, ANY status. The dashboard's
//                              "your last subscription was canceled on X".
//   findActiveSubscription     status in (active, trialing). Excludes past_due.
//   findCollectingSubscription status in (active, trialing, past_due) — the set whose
//                              collection is still running, and the only correct one to pause.
//
// The case that matters is the third test. `created_at` is frozen at first-webhook insert
// (V-741), so a replayed event for an OLD canceled subscription can sort NEWER than a live one.
// A lookup that picks by recency and then inspects status returns the canceled row — so the
// suspension pause hits a dead subscription, Stripe errors, and the LIVE subscription keeps
// billing a suspended customer. That is the exact AUP §5.2 promise the pause exists to keep.
//
// Run scope: CI (postgres service present) or locally with DATABASE_URL set; skipped otherwise.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleBillingRepo } from '../../src/db/billing-repo.js';
import type { Database } from '../../src/db/client.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const TEST_SCHEMA = `billing_lookups_${randomUUID().replaceAll('-', '')}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;
let reachable = false;

const NOW = new Date('2026-08-14T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
    reachable = true;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    return;
  }
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  for (const table of ['accounts', 'subscriptions']) {
    await admin.unsafe(
      `CREATE TABLE "${TEST_SCHEMA}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  client = postgres(DB_URL, { max: 1 });
  // Built ONCE, before any seeding: drizzle-orm/postgres-js rewrites this client's timestamp
  // and jsonb serializers to a pass-through, after which a raw Date can no longer be bound.
  // The seeds below pass ISO strings for that reason.
  db = drizzle(client);
  try {
    await client.unsafe(`SET search_path TO "${TEST_SCHEMA}", public`);
    await client`SELECT 1 FROM subscriptions LIMIT 0`;
  } catch {
    reachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'billing subscription lookups (V-767, real Postgres)',
  () => {
    async function account(): Promise<string> {
      const id = randomUUID();
      await client!`
        INSERT INTO accounts (id, email, tier, status)
        VALUES (${id}, ${`b-${id}@t.test`}, 'api_scale', 'active')`;
      return id;
    }

    async function sub(accountId: string, status: string, createdAt: Date): Promise<string> {
      const id = randomUUID();
      await client!`
        INSERT INTO subscriptions
          (id, account_id, stripe_subscription_id, stripe_price_id, tier, status, created_at)
        VALUES (${id}, ${accountId}, ${`sub_${id.slice(0, 12)}`}, 'price_test', 'api_scale',
                ${status}, ${createdAt.toISOString()})`;
      return id;
    }

    function repo(): DrizzleBillingRepo {
      return new DrizzleBillingRepo({
        client: client!,
        db: db!,
        close: async () => {},
      } as unknown as Database);
    }

    it('CRITICAL findCollectingSubscription ignores terminal rows — pausing a canceled subscription is a Stripe error, and it alarmed on every suspension of such an account', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const acc = await account();
      await sub(acc, 'canceled', new Date(NOW.getTime() - 10 * DAY));
      await sub(acc, 'unpaid', new Date(NOW.getTime() - 5 * DAY));
      await sub(acc, 'incomplete_expired', new Date(NOW.getTime() - DAY));

      expect(
        await repo().findCollectingSubscription(acc),
        'nothing is collecting, so there is nothing to pause',
      ).toBeNull();

      // The display helper still reports the newest row whatever its status — unchanged, and
      // the reason it must not be reused for a money operation.
      const current = await repo().findCurrentSubscription(acc);
      expect(current?.status).toBe('incomplete_expired');
    });

    it('CRITICAL findCollectingSubscription INCLUDES past_due — the subscription you most want to stop dunning while an account is suspended, and the half of the original reasoning that was right', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const acc = await account();
      await sub(acc, 'past_due', new Date(NOW.getTime() - DAY));

      expect((await repo().findCollectingSubscription(acc))?.status).toBe('past_due');
      // findActiveSubscription would have skipped it, which is why it is not the right lookup.
      expect(await repo().findActiveSubscription(acc)).toBeNull();
    });

    // V-1192 — found by the ownership mutation sweep. Neutralising this method's account
    // predicate left the ENTIRE integration suite green, and the two sibling lookups below
    // are covered while this one was not.
    it('CRITICAL findActiveSubscription does not see another account\'s subscription. It is the guard in front of Checkout: unscoped it returns whoever on the platform subscribed most recently, so EVERY account is refused with "already has an active subscription" — a platform-wide stop on new revenue, and the refusal body carries the other account\'s tier and status.', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const subscriber = await account();
      const newcomer = await account();
      await sub(subscriber, 'active', new Date(NOW.getTime() - DAY));

      expect(
        (await repo().findActiveSubscription(subscriber))?.status,
        'the subscriber cannot see their own active subscription',
      ).toBe('active');
      expect(
        await repo().findActiveSubscription(newcomer),
        "an account with no subscription of its own was handed another account's",
      ).toBeNull();
    });

    it('CRITICAL a canceled row that sorts NEWER than a live one must not win — created_at is frozen at first-webhook insert, so a replayed event can invert the order and the pause would hit the dead subscription while the live one kept billing a suspended customer', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const acc = await account();
      const live = await sub(acc, 'active', new Date(NOW.getTime() - 30 * DAY));
      await sub(acc, 'canceled', new Date(NOW.getTime() - DAY)); // replayed: sorts newer

      const collecting = await repo().findCollectingSubscription(acc);
      expect(collecting?.id, 'must be the LIVE subscription, not the newer canceled row').toBe(
        live,
      );
      expect(collecting?.status).toBe('active');

      // And this is precisely what the recency-then-inspect helper does instead — the trap.
      expect((await repo().findCurrentSubscription(acc))?.status).toBe('canceled');
    });
  },
);
