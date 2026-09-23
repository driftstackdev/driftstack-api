// Drizzle-backed PricingRepo — reads/writes the `pricing` table (migration 0067).

import type { AccountTier } from '@driftstack/api-types';
import { sql } from 'drizzle-orm';
import type { PricingRepo, PricingRow } from '../services/pricing.js';
import type { Database } from './client.js';
import { pricing } from './schema.js';
import { optionalActingKeyColumns } from '../lib/acting-key-columns.js';

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
  // row reflects the edit time, not the seed time) and records who made the
  // change: the owner's key, or (0138) the owner's web session when they edited
  // it signed in to the admin panel — `wsk_<uuid>` cannot go in the uuid key
  // column, and the whole edit used to fail on it. The PK conflict target makes
  // a re-edit idempotent.
  async upsert(tier: AccountTier, monthlyCents: number, updatedByKeyId?: string): Promise<void> {
    const actor = optionalActingKeyColumns(updatedByKeyId);
    const by = { updatedByKeyId: actor.keyId, updatedByWebSessionId: actor.webSessionId };
    await this.database.db
      .insert(pricing)
      .values({ tier, monthlyCents, ...by })
      .onConflictDoUpdate({
        target: pricing.tier,
        set: { monthlyCents, updatedAt: sql`now()`, ...by },
      });
  }
}
