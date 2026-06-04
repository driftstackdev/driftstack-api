// In-memory PricingRepo for integration tests. Seeded empty; tests upsert rows
// via the test seam to exercise the DB-overrides-constant path.

import type { AccountTier } from '@driftstack/api-types';
import type { PricingRepo, PricingRow } from '../../../src/services/pricing.js';

export class InMemoryPricingRepo implements PricingRepo {
  private readonly rows = new Map<AccountTier, number>();

  /** Test seam: set a per-tier price row (simulates a seeded/edited row). */
  upsert(tier: AccountTier, monthlyCents: number): void {
    this.rows.set(tier, monthlyCents);
  }

  listAll(): Promise<PricingRow[]> {
    return Promise.resolve(
      Array.from(this.rows.entries()).map(([tier, monthlyCents]) => ({ tier, monthlyCents })),
    );
  }
}
