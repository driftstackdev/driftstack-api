// In-memory PricingRepo for integration tests. Seeded empty; tests upsert rows
// to exercise the DB-overrides-constant path and the owner price-edit write.

import type { AccountTier } from '@driftstack/api-types';
import type { PricingRepo, PricingRow } from '../../../src/services/pricing.js';

export class InMemoryPricingRepo implements PricingRepo {
  private readonly rows = new Map<AccountTier, number>();

  // Mirrors DrizzlePricingRepo.upsert: insert-or-update keyed by tier. The
  // in-memory store doesn't track updated_at / updatedByKeyId (not asserted by
  // any consumer of listAll), so the param is accepted and ignored.
  upsert(tier: AccountTier, monthlyCents: number, _updatedByKeyId?: string): Promise<void> {
    this.rows.set(tier, monthlyCents);
    return Promise.resolve();
  }

  listAll(): Promise<PricingRow[]> {
    return Promise.resolve(
      Array.from(this.rows.entries()).map(([tier, monthlyCents]) => ({ tier, monthlyCents })),
    );
  }
}
