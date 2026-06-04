// Unit tests for PricingService (pricing-as-data Phase A) — the
// DB-row-overrides-constant merge + safe constant-fallback.

import { describe, expect, it } from 'vitest';
import { PricingService, type PricingRepo, type PricingRow } from '../../src/services/pricing.js';
import { InMemoryPricingRepo } from '../integration/_helpers/in-memory-pricing-repo.js';
import { TIER_MONTHLY_PRICE_CENTS } from '../../src/lib/cost-defaults.js';

describe('PricingService.listEffective', () => {
  it('empty DB → every constant-defined tier at its constant price', async () => {
    const svc = new PricingService(new InMemoryPricingRepo());
    const rows = await svc.listEffective();
    const byTier = new Map(rows.map((r) => [r.tier, r.monthlyCents]));
    // One row per constant-defined tier, all equal to the constant.
    expect(rows.length).toBe(Object.keys(TIER_MONTHLY_PRICE_CENTS).length);
    expect(byTier.get('solo_manual')).toBe(7900);
    expect(byTier.get('api_scale')).toBe(149900);
  });

  it('a persisted DB row OVERRIDES the constant for that tier only', async () => {
    const repo = new InMemoryPricingRepo();
    repo.upsert('solo_manual', 8900); // owner raised solo from $79 → $89
    const rows = await new PricingService(repo).listEffective();
    const byTier = new Map(rows.map((r) => [r.tier, r.monthlyCents]));
    expect(byTier.get('solo_manual')).toBe(8900); // overridden
    expect(byTier.get('team_manual')).toBe(24900); // others = constant
  });

  it('DB-read failure falls back ENTIRELY to the constants (pricing never throws)', async () => {
    const throwingRepo: PricingRepo = {
      listAll: () => Promise.reject(new Error('db down')),
    };
    const rows = await new PricingService(throwingRepo).listEffective();
    const byTier = new Map<string, number>(rows.map((r: PricingRow) => [r.tier, r.monthlyCents]));
    expect(rows.length).toBe(Object.keys(TIER_MONTHLY_PRICE_CENTS).length);
    expect(byTier.get('api_builder')).toBe(49900); // constant, no throw
  });
});
