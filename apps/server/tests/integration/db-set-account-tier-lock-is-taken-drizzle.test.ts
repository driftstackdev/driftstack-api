// The tier-change row lock is actually ACQUIRED — forced ordering, not a race.
//
// `setAccountTier` reads the current tier, writes the new one, and returns
// `previousTier`. The source says what the `FOR UPDATE` on that read is for:
//
//   "Without FOR UPDATE both deliveries could read the same old tier and each
//    emit a duplicate tier-changed email/audit; the lock serializes them, so the
//    loser reads previousTier === args.tier and the lifecycle no-op guard
//    (fromTier === toTier) suppresses the dup."
//
// So the whole no-duplicate-email argument rests on the loser observing the
// WINNER'S committed tier — which only happens if the read really waits. Two
// Stripe deliveries for one subscription change is ordinary, not exotic; the
// visible failure is a customer receiving the same tier-change email twice and an
// audit log double-counting it.
//
// No integration test named `setAccountTier` before this file.
//
// Why forced ordering rather than a race: measured twice now (the profile cap and
// the token debit), a race in this repo cannot demonstrate a lock — a localhost
// transaction completes faster than the interleaving the defect needs, so the
// second read lands after the first commit and the bug never materialises. A
// conditional-UPDATE atomicity (like api-key revocation) IS race-detectable,
// because removing its predicate makes every caller win regardless of timing. A
// lock is not. This is a lock.
//
// Lock mode is the experiment, again. The holder takes FOR KEY SHARE on the
// accounts row: it conflicts with the repo's FOR UPDATE (guarded path blocks) and
// is compatible with the plain SELECT + FOR NO KEY UPDATE an unguarded path would
// take (so that sails through). A holder taking FOR UPDATE would block both and
// prove nothing.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let holder: ReturnType<typeof postgres> | null = null;
let worker: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

/** A one-shot latch: `promise` settles when `fire()` is called. */
function gate(): { promise: Promise<void>; fire: () => void } {
  let fire: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    fire = (): void => {
      resolve();
    };
  });
  return { promise, fire };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  holder = postgres(DB_URL, { max: 1 });
  worker = postgres(DB_URL, { max: 1 });
  try {
    await holder`SELECT 1 FROM accounts LIMIT 0`;
  } catch {
    await holder.end({ timeout: 1 }).catch(() => {});
    await worker.end({ timeout: 1 }).catch(() => {});
    holder = null;
    worker = null;
  }
});

afterAll(async () => {
  if (holder) {
    for (const accountId of seeded) {
      await holder`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await holder.end({ timeout: 5 });
  }
  if (worker) await worker.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'setAccountTier takes its row lock (real Postgres, forced ordering)',
  () => {
    it("CRITICAL setAccountTier BLOCKS while another session holds the account row, so a second Stripe delivery reads the WINNER'S tier rather than the stale one. Without that wait both deliveries report the same previousTier, the fromTier === toTier no-op guard never fires, and the customer gets the tier-change email twice.", async () => {
      if (!holder || !worker) {
        if (process.env.CI) {
          throw new Error(
            'real-PG tier-lock test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const h = holder;
      const w = worker;
      const accountId = randomUUID();
      seeded.push(accountId);
      await h`
        INSERT INTO accounts (id, email, tier)
        VALUES (${accountId}, ${`tier-lock-${accountId}@test.local`}, 'free')`;

      const repo = new DrizzleStripeWebhooksRepo({
        client: w,
        db: drizzle(w) as unknown as ReturnType<typeof drizzle<typeof schema>>,
        close: async () => {},
      });

      const lockTaken = gate();
      const release = gate();

      const holderTxn = h.begin(async (tx) => {
        // KEY SHARE, not FOR UPDATE — see the header.
        await tx`SELECT id FROM accounts WHERE id = ${accountId} FOR KEY SHARE`;
        lockTaken.fire();
        await release.promise;
      });

      await lockTaken.promise;

      let settled = false;
      const pending = repo
        .setAccountTier({ accountId, tier: 'api_builder', at: new Date() })
        .then((r) => {
          settled = true;
          return r;
        });

      // Asserting the ABSENCE of progress: the same call finishes in single-digit
      // milliseconds against a free row, so this wants slack, not precision.
      await delay(600);
      expect(
        settled,
        'setAccountTier must be waiting on the account row, not reading a tier past it',
      ).toBe(false);

      release.fire();
      await holderTxn;

      const result = await pending;
      expect(settled).toBe(true);
      expect(result.previousTier, 'it reads the committed tier once the lock is free').toBe('free');

      const rows = await h<Array<{ tier: string }>>`
        SELECT tier FROM accounts WHERE id = ${accountId}`;
      expect(rows[0]?.tier).toBe('api_builder');
    });
  },
);
