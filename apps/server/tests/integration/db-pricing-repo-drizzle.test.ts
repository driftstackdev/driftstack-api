// DrizzlePricingRepo against real Postgres (pricing-as-data Phase A).
// Validates that migration 0067 created the `pricing` table AND seeded the 6
// paid tiers from TIER_MONTHLY_PRICE_CENTS — i.e. DB == constants on day one.
//
// CI: always runs (the `driftstack` schema is migrated via the e2e/migrate
// path). Local: skips unless DATABASE_URL is set + reachable + migrated.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzlePricingRepo } from '../../src/db/pricing-repo.js';
import { TIER_MONTHLY_PRICE_CENTS } from '../../src/lib/cost-defaults.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let client: ReturnType<typeof postgres> | null = null;

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
  // Schema-presence probe: skip rather than fail if migrations aren't applied.
  try {
    await client`SELECT 1 FROM pricing LIMIT 0`;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzlePricingRepo.listAll (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable, so nothing below can pass vacuously', () => {
      // Every arm in this file returns early when `client` is null. That is right
      // when the suite runs without a database: the describe is skipped and
      // nothing claims to have tested anything. But when the describe DOES run and
      // Postgres is down or unmigrated, every arm returns early and the file
      // reports as PASSED. A green meaning "the database was missing" is
      // indistinguishable from one meaning "the database agreed", and that is the
      // worse of the two failure modes.
      expect(
        client,
        'postgres unreachable or unmigrated — the arms below never ran',
      ).not.toBeNull();
    });

    it('returns the 6 paid tiers seeded by migration 0067, equal to the constants', async () => {
      if (!client) return; // skipped (unreachable/unmigrated local)
      const repo = new DrizzlePricingRepo({ db: drizzle(client, { schema }) });
      const rows = await repo.listAll();
      const byTier = new Map(rows.map((r) => [r.tier, r.monthlyCents]));
      for (const [tier, cents] of Object.entries(TIER_MONTHLY_PRICE_CENTS)) {
        expect(byTier.get(tier as keyof typeof TIER_MONTHLY_PRICE_CENTS), `tier ${tier}`).toBe(
          cents,
        );
      }
      // No extra/unknown tiers seeded.
      expect(rows.length).toBe(Object.keys(TIER_MONTHLY_PRICE_CENTS).length);
    });

    it('upsert overrides a tier price on the real PK conflict path, then a re-upsert overwrites; restores the seed', async () => {
      if (!client) return; // skipped (unreachable/unmigrated local)
      const repo = new DrizzlePricingRepo({ db: drizzle(client, { schema }) });
      const seed = TIER_MONTHLY_PRICE_CENTS.api_scale ?? 149900;
      try {
        // First upsert hits onConflictDoUpdate (the row was seeded by 0067).
        await repo.upsert('api_scale', 199900);
        let byTier = new Map((await repo.listAll()).map((r) => [r.tier, r.monthlyCents]));
        expect(byTier.get('api_scale')).toBe(199900);
        // Re-upsert overwrites (idempotent on the tier PK).
        await repo.upsert('api_scale', 209900);
        byTier = new Map((await repo.listAll()).map((r) => [r.tier, r.monthlyCents]));
        expect(byTier.get('api_scale')).toBe(209900);
        // Untouched tiers stay at their seed.
        expect(byTier.get('solo_manual')).toBe(TIER_MONTHLY_PRICE_CENTS.solo_manual);
      } finally {
        // Restore the seed so later tests reading pricing see day-one values.
        await repo.upsert('api_scale', seed);
      }
    });
  },
);
