// Drizzle-backed PricingRepo — reads the `pricing` table (migration 0067).
// Phase A is read-only over the seeded rows; the owner-edit (upsert) path
// lands with the owner-CRUD increment.

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
}
