// Unit tests for PricingService (pricing-as-data Phase A) — the
// DB-row-overrides-constant merge + safe constant-fallback.

import { describe, expect, it } from 'vitest';
import { PricingService, type PricingRepo, type PricingRow } from '../../src/services/pricing.js';
import { InMemoryPricingRepo } from '../integration/_helpers/in-memory-pricing-repo.js';
import { TIER_MONTHLY_PRICE_CENTS } from '../../src/lib/cost-defaults.js';
import { ValidationError } from '../../src/lib/errors.js';

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
    await repo.upsert('solo_manual', 8900); // owner raised solo from $79 → $89
    const rows = await new PricingService(repo).listEffective();
    const byTier = new Map(rows.map((r) => [r.tier, r.monthlyCents]));
    expect(byTier.get('solo_manual')).toBe(8900); // overridden
    expect(byTier.get('team_manual')).toBe(24900); // others = constant
  });

  it('DB-read failure falls back ENTIRELY to the constants (pricing never throws)', async () => {
    const throwingRepo: PricingRepo = {
      listAll: () => Promise.reject(new Error('db down')),
      upsert: () => Promise.reject(new Error('db down')),
    };
    const rows = await new PricingService(throwingRepo).listEffective();
    const byTier = new Map<string, number>(rows.map((r: PricingRow) => [r.tier, r.monthlyCents]));
    expect(rows.length).toBe(Object.keys(TIER_MONTHLY_PRICE_CENTS).length);
    expect(byTier.get('api_builder')).toBe(49900); // constant, no throw
  });
});

describe('PricingService.setPrice', () => {
  it('persists a new price and listEffective() reflects it — the edit reaches BOTH readers (owner view + crypto charge both read listEffective), closing the editable-price-that-does-not-charge footgun', async () => {
    const repo = new InMemoryPricingRepo();
    const svc = new PricingService(repo);
    const written = await svc.setPrice('api_scale', 199900, 'key_abc'); // $1,499 → $1,999
    expect(written).toEqual({ tier: 'api_scale', monthlyCents: 199900 });
    // The effective price (what every reader consumes) now reflects the edit,
    // not the seeded constant (149900).
    const rows = await svc.listEffective();
    const byTier = new Map(rows.map((r) => [r.tier, r.monthlyCents]));
    expect(byTier.get('api_scale')).toBe(199900);
    expect(byTier.get('solo_manual')).toBe(7900); // untouched tiers stay constant
  });

  it('re-editing the same tier overwrites (upsert is idempotent on tier)', async () => {
    const svc = new PricingService(new InMemoryPricingRepo());
    await svc.setPrice('team_manual', 30000);
    await svc.setPrice('team_manual', 27500);
    const rows = await svc.listEffective();
    expect(new Map(rows.map((r) => [r.tier, r.monthlyCents])).get('team_manual')).toBe(27500);
  });

  it('rejects a non-positive, non-integer, or over-ceiling amount with a ValidationError (a write is NOT shielded by the constant fallback)', async () => {
    const svc = new PricingService(new InMemoryPricingRepo());
    for (const bad of [0, -100, 79.5, 1_000_001]) {
      await expect(svc.setPrice('solo_manual', bad)).rejects.toBeInstanceOf(ValidationError);
    }
    // The rejection carries the monthly_cents bound in its problem-details issues.
    const err = await svc.setPrice('solo_manual', -1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const issues = (err as ValidationError).extensions?.issues as { formErrors: string[] };
    expect(issues.formErrors.join(' ')).toMatch(/monthly_cents/);
  });

  it('a rejected edit does NOT touch the store (validation happens before the repo write)', async () => {
    const repo = new InMemoryPricingRepo();
    const svc = new PricingService(repo);
    await expect(svc.setPrice('solo_manual', -1)).rejects.toThrow();
    // listEffective still returns the constant — nothing was written.
    const rows = await svc.listEffective();
    expect(new Map(rows.map((r) => [r.tier, r.monthlyCents])).get('solo_manual')).toBe(7900);
  });
});
