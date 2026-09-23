// In-memory PricingRepo for integration tests. Seeded empty; tests upsert rows
// to exercise the DB-overrides-constant path and the owner price-edit write.

import type { AccountTier } from '@driftstack/api-types';
import type { PricingRepo, PricingRow } from '../../../src/services/pricing.js';
import { optionalActingKeyColumns } from '../../../src/lib/acting-key-columns.js';

export class InMemoryPricingRepo implements PricingRepo {
  private readonly rows = new Map<AccountTier, number>();

  // Mirrors DrizzlePricingRepo.upsert: insert-or-update keyed by tier. The
  // in-memory store doesn't track updated_at / updatedByKeyId (not asserted by
  // any consumer of listAll) — but the id is VALIDATED exactly as the real
  // columns are (0138): a key's uuid, a web session's `wsk_<uuid>`, or none.
  // Ignoring it is how a web session's price edit passed here while production
  // could not store it.
  upsert(tier: AccountTier, monthlyCents: number, updatedByKeyId?: string): Promise<void> {
    optionalActingKeyColumns(updatedByKeyId);
    this.rows.set(tier, monthlyCents);
    return Promise.resolve();
  }

  listAll(): Promise<PricingRow[]> {
    return Promise.resolve(
      Array.from(this.rows.entries()).map(([tier, monthlyCents]) => ({ tier, monthlyCents })),
    );
  }
}
