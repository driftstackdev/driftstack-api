// Pricing service (pricing-as-data Phase A).
//
// A DB-backed source-of-truth for the per-tier monthly price, with the
// TIER_MONTHLY_PRICE_CENTS constant as BOTH the migration seed AND a safe
// runtime fallback: for each tier the constant defines, the DB row's value is
// used if present, else the constant. Migration 0067 seeds the table FROM those
// constants, so DB == constants on day one and behaviour is unchanged until an
// owner edits a price.
//
// SAFE-BY-DEFAULT: a DB read failure falls back to the constants (pricing reads
// never throw) — the seeded constant is always a known-good value. This is why
// the eventual crypto-charge / cost-cap rewire onto this service can't regress
// billing: worst case it charges the same constant it does today.

import type { AccountTier } from '@driftstack/api-types';
import { TIER_MONTHLY_PRICE_CENTS } from '../lib/cost-defaults.js';

export interface PricingRow {
  tier: AccountTier;
  monthlyCents: number;
}

export interface PricingRepo {
  /** All persisted per-tier price rows (Phase A: the 6 paid tiers, seeded). */
  listAll(): Promise<PricingRow[]>;
}

export class PricingService {
  constructor(private readonly repo: PricingRepo) {}

  /**
   * Effective per-tier monthly price (cents) for every tier the constant
   * defines, with a persisted DB row overriding the constant. DB-read failure
   * falls back entirely to the constants (pricing never breaks). Order follows
   * the constant's insertion order (the canonical paid-tier ladder).
   */
  async listEffective(): Promise<PricingRow[]> {
    let dbRows: PricingRow[] = [];
    try {
      dbRows = await this.repo.listAll();
    } catch {
      dbRows = [];
    }
    const dbByTier = new Map<string, number>(dbRows.map((r) => [r.tier, r.monthlyCents]));
    return (Object.entries(TIER_MONTHLY_PRICE_CENTS) as Array<[AccountTier, number]>).map(
      ([tier, constantCents]) => ({
        tier,
        monthlyCents: dbByTier.get(tier) ?? constantCents,
      }),
    );
  }
}
