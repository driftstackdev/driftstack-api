// Drizzle-backed PricingRepo — reads/writes the `pricing` table (migration 0067).

import type { AccountTier } from '@driftstack/api-types';
import { sql } from 'drizzle-orm';
import type { PricingRepo, PricingRow } from '../services/pricing.js';
import type { Database } from './client.js';
import { pricing } from './schema.js';

// W197 — only the `db` handle is read; narrow the dependency so e2e fixtures
// stay composable without the full Database envelope.
export class DrizzlePricingRepo implements PricingRepo {
  constructor(private readonly database: Pick<Database, 'db'>) {}

  async listAll(): Promise<PricingRow[]> {
    const rows = await this.database.db
      .select({ tier: pricing.tier, monthlyCents: pricing.monthlyCents })
      .from(pricing);
    return rows.map((r) => ({ tier: r.tier, monthlyCents: r.monthlyCents }));
  }

  // Insert-or-update on the `tier` primary key. Stamps `updated_at` (so the
  // row reflects the edit time, not the seed time) and records which owner
  // key made the change. The PK conflict target makes a re-edit idempotent.
  async upsert(tier: AccountTier, monthlyCents: number, updatedByKeyId?: string): Promise<void> {
    await this.database.db
      .insert(pricing)
      .values({ tier, monthlyCents, updatedByKeyId: updatedByKeyId ?? null })
      .onConflictDoUpdate({
        target: pricing.tier,
        set: { monthlyCents, updatedAt: sql`now()`, updatedByKeyId: updatedByKeyId ?? null },
      });
  }
}
