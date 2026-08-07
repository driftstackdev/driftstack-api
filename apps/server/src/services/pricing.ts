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
// never throw) — the seeded constant is always a known-good value, and failing
// checkout outright would be worse than charging the seeded price.
//
// V-746 — but that fallback is NOT free, and the original framing of it ("worst
// case it charges the same constant it does today") stopped being true the moment
// the owner price-edit route went live. Once a price has been edited, DB != the
// constants, so a read failure charges the PRE-EDIT price: if the edit was a
// discount the customer is silently overcharged, and if it was a rise the
// business silently undercharges. The order row records only the amount actually
// charged, so nothing downstream can tell that the intended price was different.
// Hence the fallback now raises an integrity alarm. The BEHAVIOUR is unchanged on
// purpose — the defect was that it was invisible.

import type { AccountTier } from '@driftstack/api-types';
import { TIER_MONTHLY_PRICE_CENTS } from '../lib/cost-defaults.js';
import { ValidationError } from '../lib/errors.js';

/** Integrity-alarm sink. Optional so tests can omit it; same shape as the
 *  crypto-orders billing-integrity logger. */
export interface PricingLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

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
  /** Set once a missing-row warning has been emitted, so a deployment whose
   *  pricing table was never seeded warns ONCE rather than on every checkout
   *  (mirrors the bounded-relay `overflowReported` flag). */
  private missingRowsReported = false;

  constructor(
    private readonly repo: PricingRepo,
    private readonly logger?: PricingLogger,
  ) {}

  /**
   * Effective per-tier monthly price (cents) for every tier the constant
   * defines, with a persisted DB row overriding the constant. DB-read failure
   * falls back entirely to the constants (pricing never breaks). Order follows
   * the constant's insertion order (the canonical paid-tier ladder).
   */
  async listEffective(): Promise<PricingRow[]> {
    let dbRows: PricingRow[] = [];
    let readFailed = false;
    try {
      dbRows = await this.repo.listAll();
    } catch (err) {
      dbRows = [];
      readFailed = true;
      // Alarm, don't throw: checkout still completes at the seeded price. But an
      // owner edit is invisible to this request, so prices served here may be
      // stale in either direction and support cannot reconstruct that later.
      //
      // Deliberately NOT rate-limited the way the missing-row warning below is:
      // each occurrence is a DIFFERENT customer request that may have been quoted
      // or charged a stale amount, so each one is individually actionable. The
      // missing-row case is one static condition, hence warned once.
      this.logger?.error(
        {
          component: 'pricing-service',
          event: 'pricing_db_read_failed_serving_constants',
          err: err instanceof Error ? err.message : String(err),
        },
        'pricing table read FAILED — serving seeded constant prices; any owner price edit is NOT reflected in prices quoted or charged until this recovers (integrity alarm)',
      );
    }
    const dbByTier = new Map<string, number>(dbRows.map((r) => [r.tier, r.monthlyCents]));
    const rows = (Object.entries(TIER_MONTHLY_PRICE_CENTS) as Array<[AccountTier, number]>).map(
      ([tier, constantCents]) => ({
        tier,
        monthlyCents: dbByTier.get(tier) ?? constantCents,
      }),
    );
    // A SUCCESSFUL read that is missing a priced tier has the same consequence as
    // a failed one for that tier, and is equally invisible. Migration 0067 seeds
    // every priced tier, so a gap means the table was never seeded or lost rows.
    if (!readFailed && !this.missingRowsReported) {
      const missing = rows.filter((r) => !dbByTier.has(r.tier)).map((r) => r.tier);
      if (missing.length > 0) {
        this.missingRowsReported = true;
        this.logger?.warn?.(
          {
            component: 'pricing-service',
            event: 'pricing_rows_missing_serving_constants',
            missing_tiers: missing,
            db_row_count: dbRows.length,
          },
          'pricing table is missing rows for priced tiers — serving seeded constants for them (migration 0067 should have seeded every priced tier); warned once per process',
        );
      }
    }
    return rows;
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
  /**
   * V-746 — an edit here moves the CHARGED price only. The advertised price on the
   * marketing site is a static build artefact
   * (`apps/marketing-site/src/data/pricing.ts`) with no link to this table, so an
   * edit that is not mirrored there leaves the site advertising one price while
   * checkout charges another. Nothing detects that divergence: the
   * marketing-pricing drift guard pins the marketing file's own literals and has
   * no view of this table. Mirror the edit and redeploy the marketing site — see
   * docs/runbooks/crypto-payments.md.
   */
  async setPrice(
    tier: AccountTier,
    monthlyCents: number,
    updatedByKeyId?: string,
  ): Promise<PricingRow> {
    // The owner route restricts `tier` to the priced tiers, but this service is
    // the boundary and its own docs promise a backstop. Without this, a price
    // written for a tier that has no constant entry (`free`, `enterprise`)
    // persists and is then dropped by listEffective, which only maps over the
    // constants — an edit that appears to succeed and silently never charges.
    // That is precisely the footgun this module exists to close.
    if (TIER_MONTHLY_PRICE_CENTS[tier] === undefined) {
      throw new ValidationError({
        fieldErrors: {},
        formErrors: [`tier '${tier}' has no self-serve price and cannot be priced.`],
      });
    }
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
