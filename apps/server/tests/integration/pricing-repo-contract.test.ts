// V-1239 — one contract for per-tier pricing, against BOTH implementations of `PricingRepo`.
//
// The twenty-eighth of the twenty-nine. Two methods, and between them they decide what a customer
// is charged, so "the write lands and reads back as itself" is the entire job.
//
//   Drizzle  INSERT … ON CONFLICT (tier) DO UPDATE SET monthly_cents = …, updated_at = now()
//            SELECT tier, monthly_cents FROM pricing        (no ORDER BY)
//
//   double   Map<AccountTier, number>.set / Array.from(entries)
//
// `tier` is the PRIMARY KEY, so the table holds at most one row per tier and a re-edit must REPLACE
// rather than accumulate. On the Drizzle side that is the conflict target doing its job; get the
// target wrong and a second edit either throws or leaves two rows, one of which is the old price
// that `listAll` may hand back instead. On the double it is `Map.set`. Same guarantee, two
// mechanisms, and the arm asserts the guarantee rather than either mechanism.
//
// NEITHER SIDE ORDERS `listAll`, and that is on purpose and already reviewed:
// `pricing-repo.ts::listAll` is in the reviewed-unordered list in
// `an-unordered-read-is-reviewed-not-accidental.test.ts`, because every consumer folds the result
// into a map keyed by tier and tier is the primary key, so the fold cannot be ambiguous. No arm
// here asserts an order — asserting one would freeze a property the repo does not promise.
//
// THIS TEST WRITES TO A SEEDED GLOBAL TABLE. `pricing` is not per-account: it is one small config
// table the local database seeds with real prices, and a contract that upserts into it would leave
// those prices changed. So the Drizzle half snapshots every row up front and restores all four
// columns afterwards, deleting rows that were not there to begin with. That is the fifth distinct
// fixture arrangement in this campaign, after caller-chosen timestamps, stamp-returned-by-the-repo,
// DB-only-arm, and unscoped-so-measure-the-delta.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { AccountTier } from '@driftstack/api-types';
import type { PricingRepo } from '../../src/services/pricing.js';
import { DrizzlePricingRepo } from '../../src/db/pricing-repo.js';
import { InMemoryPricingRepo } from './_helpers/in-memory-pricing-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

// Tiers this file writes to. `free` and `enterprise` are the two AccountTier values that
// migration 0067 does NOT seed a price for, and that is exactly why they were chosen.
//
// The first draft used api_starter and api_scale, which ARE seeded. Its restore hook shared a
// connection pool with the repo, deadlocked, and was killed by vitest's 10s hook timeout — leaving
// the local database holding 4900 and 19900 where the migration seeds 14900 and 149900. The next
// run then snapshotted those corrupted values and faithfully restored them, so the damage looked
// like a clean pass. It was caught only by checking the values against the migration rather than
// counting the rows.
//
// Writing to unseeded tiers makes the failure mode survivable: the worst a dead hook can leave
// behind is two rows that were never there, not two prices that are wrong and look right. The
// snapshot/restore below stays as well — this is a global config table, and defence in depth on it
// is cheap.
const T1: AccountTier = 'free';
const T2: AccountTier = 'enterprise';

interface PricingSnapshotRow {
  tier: string;
  monthly_cents: number;
  updated_at: Date;
  updated_by_key_id: string | null;
}

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
let snapshot: PricingSnapshotRow[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM pricing LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) {
    client = postgres(DB_URL, { max: 2 });
    snapshot = [
      ...(await client<
        PricingSnapshotRow[]
      >`SELECT tier, monthly_cents, updated_at, updated_by_key_id FROM pricing`),
    ];
  }
});

afterAll(async () => {
  if (!client) return;

  // Close the repo's pool BEFORE restoring, and restore over a connection of our own.
  // Sharing one pool between the repo and this hook deadlocks it: the arms run their
  // upserts through `drizzle(client)`, and the restore statements then queue behind
  // connections that pool never frees, so the hook sits there until vitest times it
  // out at 10s — with the seeded prices left overwritten, which is the one outcome
  // this hook exists to prevent. Each statement takes about 2ms on its own.
  await client.end({ timeout: 5 }).catch(() => {});
  client = null;

  const restorer = postgres(DB_URL, { max: 1 });
  try {
    // Restore, do not just delete: these are the seeded prices the rest of the local
    // database is entitled to keep. Rows this file created are removed; rows it edited
    // go back to all four of their original column values.
    const kept = new Set(snapshot.map((r) => r.tier));
    for (const tier of [T1, T2]) {
      if (!kept.has(tier)) {
        await restorer`DELETE FROM pricing WHERE tier = ${tier}::account_tier`.catch(() => {});
      }
    }
    for (const r of snapshot) {
      await restorer`UPDATE pricing
                        SET monthly_cents = ${r.monthly_cents},
                            updated_at = ${r.updated_at},
                            updated_by_key_id = ${r.updated_by_key_id}
                      WHERE tier = ${r.tier}::account_tier`.catch(() => {});
    }
  } finally {
    await restorer.end({ timeout: 5 }).catch(() => {});
  }
});

interface Subject {
  repo: PricingRepo;
}

function inMemorySubject(): Subject {
  return { repo: new InMemoryPricingRepo() };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return { repo: new DrizzlePricingRepo({ db }) };
}

const priceOf = async (s: Subject, tier: AccountTier): Promise<number | undefined> =>
  (await s.repo.listAll()).find((r) => r.tier === tier)?.monthlyCents;

const rowsFor = async (s: Subject, tier: AccountTier): Promise<number> =>
  (await s.repo.listAll()).filter((r) => r.tier === tier).length;

function pricingContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`PricingRepo contract — ${label}`, () => {
    it('CRITICAL a written price reads back as itself, in both. This is the number a customer is charged; a write that does not round-trip is the whole failure, and every other arm here assumes this one.', async () => {
      if (!enabled()) return;
      const s = make();
      await s.repo.upsert(T1, 4900);

      expect(await priceOf(s, T1), 'the written price did not read back').toBe(4900);
    });

    it('CRITICAL re-editing a tier REPLACES its price rather than adding a second row, in both. `tier` is the primary key, so one tier means one price. On the Drizzle side that is the ON CONFLICT target: get it wrong and a second edit leaves the old row in place, which listAll can hand back as the current price — a customer billed at a price nobody can see in the admin panel.', async () => {
      if (!enabled()) return;
      const s = make();
      await s.repo.upsert(T1, 4900);
      await s.repo.upsert(T1, 7900);

      expect(await rowsFor(s, T1), 'the tier has more than one row after a re-edit').toBe(1);
      expect(await priceOf(s, T1), 'the re-edit did not take effect').toBe(7900);
    });

    it('CRITICAL a price of ZERO is stored and read back as zero, not as absent, in both. Zero is a legitimate price — a comped or promotional tier — and it is exactly the value a `?? default` or a truthiness check silently replaces with the old number, which bills a customer who was promised nothing.', async () => {
      if (!enabled()) return;
      const s = make();
      await s.repo.upsert(T1, 4900);
      await s.repo.upsert(T1, 0);

      expect(await priceOf(s, T1), 'a zero price was dropped or replaced by a default').toBe(0);
    });

    it('CRITICAL editing one tier leaves the others alone, in both. Without this the arms above are satisfied by an implementation holding a single global price, and every tier would move whenever any one of them was edited.', async () => {
      if (!enabled()) return;
      const s = make();
      await s.repo.upsert(T1, 4900);
      await s.repo.upsert(T2, 19900);
      await s.repo.upsert(T1, 5900);

      expect(await priceOf(s, T2), "editing one tier moved another tier's price").toBe(19900);
      expect(await priceOf(s, T1), 'the edited tier did not take its new price').toBe(5900);
    });

    it('CRITICAL passing updatedByKeyId changes neither the price nor the number of rows, in both. The Drizzle side records the editing key and the double accepts the argument and drops it, so the attribution itself is not a shared property — but a caller supplying it must not get a different price or a duplicate row, and that much both sides do promise.', async () => {
      if (!enabled()) return;
      const s = make();
      await s.repo.upsert(T1, 4900);
      await s.repo.upsert(T1, 6900, '00000000-0000-4000-8000-0000000000ff');

      expect(await rowsFor(s, T1), 'supplying an editor id duplicated the row').toBe(1);
      expect(await priceOf(s, T1), 'supplying an editor id changed the stored price').toBe(6900);
    });

    it('CRITICAL monthlyCents is a NUMBER at runtime, in both. It is arithmetic input — proration, totals, tax — and a numeric column arriving as a string turns the first addition into concatenation while every type annotation still reads `number`.', async () => {
      if (!enabled()) return;
      const s = make();
      await s.repo.upsert(T1, 4900);

      const row = (await s.repo.listAll()).find((r) => r.tier === T1);
      expect(typeof row?.monthlyCents, 'monthlyCents is not a number at runtime').toBe('number');
    });
  });
}

pricingContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)('PricingRepo contract — real', () => {
  it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
    if (!process.env.CI && !dbReachable) return;
    expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
      true,
    );
  });

  pricingContract('drizzle', drizzleSubject, () => dbReachable);
});
