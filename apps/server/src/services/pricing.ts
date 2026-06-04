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
import { ValidationError } from '../lib/errors.js';

export interface PricingRow {
  tier: AccountTier;
  monthlyCents: number;
}

export interface PricingRepo {
  /** All persisted per-tier price rows (Phase A: the 6 paid tiers, seeded). */
  listAll(): Promise<PricingRow[]>;
  /**
   * Persist (insert-or-update) a tier's monthly price. `updatedByKeyId` records
   * the owner API key that made the edit (null for the seeded default). This is
   * the owner price-edit write path; the audited owner route is the next
   * increment, so for now it has no production caller.
   */
  upsert(tier: AccountTier, monthlyCents: number, updatedByKeyId?: string): Promise<void>;
}

/**
 * Maximum editable monthly price (cents) = $10,000/mo. A sane ceiling that
 * matches the crypto-checkout `price_cents` bound and guards against a
 * fat-finger edit (an extra zero) writing an absurd charge. Unlike a READ,
 * a price WRITE is not protected by the constant fallback, so it must be
 * validated at the service boundary even though the owner route also
 * Zod-validates its body.
 */
const MAX_MONTHLY_CENTS = 1_000_000;

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

  /**
   * Set (insert-or-update) a tier's monthly price in cents and return the
   * effective row. Validates the amount is a positive integer within
   * [1, MAX_MONTHLY_CENTS] — a write isn't shielded by the constant fallback
   * (a read is), so a bad value would persist and become the charged price.
   * Once this lands, both readers reflect the edit: the owner /pricing view
   * and the crypto-checkout charge both source `listEffective()` (whose DB
   * row now overrides the constant), so an edit moves the price customers pay
   * — that is the pricing-as-data goal (no editable-price-that-doesn't-charge
   * footgun).
   */
  async setPrice(
    tier: AccountTier,
    monthlyCents: number,
    updatedByKeyId?: string,
  ): Promise<PricingRow> {
    if (!Number.isInteger(monthlyCents) || monthlyCents <= 0 || monthlyCents > MAX_MONTHLY_CENTS) {
      throw new ValidationError({
        fieldErrors: {},
        formErrors: [`monthly_cents must be an integer between 1 and ${MAX_MONTHLY_CENTS}.`],
      });
    }
    await this.repo.upsert(tier, monthlyCents, updatedByKeyId);
    return { tier, monthlyCents };
  }
}
