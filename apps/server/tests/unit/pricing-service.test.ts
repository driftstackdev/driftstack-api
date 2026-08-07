// Unit tests for PricingService (pricing-as-data Phase A) — the
// DB-row-overrides-constant merge + safe constant-fallback.

import { describe, expect, it, vi } from 'vitest';
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

// V-746 — the constant fallback is the right BEHAVIOUR (charging the seeded price
// beats failing checkout) but it was silent, and it stopped being harmless once the
// owner price-edit route went live: after an edit, DB != constants, so falling back
// serves the PRE-EDIT price to both the quote and the charge.
describe('PricingService fallback observability (V-746)', () => {
  const failingRepo: PricingRepo = {
    listAll: () => Promise.reject(new Error('pricing table unavailable')),
    upsert: () => Promise.resolve(),
  };

  it('alarms when a DB read failure makes it serve constants, naming the stale-price risk', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const svc = new PricingService(failingRepo, logger);

    // Behaviour is deliberately UNCHANGED: still resolves, still every tier.
    const rows = await svc.listEffective();
    expect(rows.length).toBe(Object.keys(TIER_MONTHLY_PRICE_CENTS).length);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [obj, msg] = logger.error.mock.calls[0] ?? [];
    expect(obj).toMatchObject({ event: 'pricing_db_read_failed_serving_constants' });
    expect(msg).toMatch(/owner price edit is NOT reflected/);
    // The failure cause is carried, not swallowed.
    expect(obj).toMatchObject({ err: 'pricing table unavailable' });
    // A read failure is not a missing-row condition; only one alarm fires.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still serves prices with no logger attached (alarm sink is optional)', async () => {
    const svc = new PricingService(failingRepo);
    await expect(svc.listEffective()).resolves.toHaveLength(
      Object.keys(TIER_MONTHLY_PRICE_CENTS).length,
    );
  });

  it('warns ONCE per instance when a successful read is missing priced-tier rows', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    // An unseeded table: the read succeeds and returns nothing.
    const svc = new PricingService(new InMemoryPricingRepo(), logger);

    await svc.listEffective();
    await svc.listEffective();
    await svc.listEffective();

    // Warned once, not once per checkout — a misconfigured deployment must not
    // drown the log.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      event: 'pricing_rows_missing_serving_constants',
      db_row_count: 0,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does NOT warn when every priced tier has a row', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const repo = new InMemoryPricingRepo();
    for (const tier of Object.keys(TIER_MONTHLY_PRICE_CENTS)) {
      await repo.upsert(tier as Parameters<typeof repo.upsert>[0], 12345);
    }
    const svc = new PricingService(repo, logger);
    const rows = await svc.listEffective();

    expect(rows.every((r) => r.monthlyCents === 12345)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('names the partially-seeded tiers rather than just reporting a gap', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const repo = new InMemoryPricingRepo();
    await repo.upsert('api_scale', 149900);
    const svc = new PricingService(repo, logger);
    await svc.listEffective();

    const missing = (logger.warn.mock.calls[0]?.[0] as { missing_tiers: string[] }).missing_tiers;
    expect(missing).not.toContain('api_scale');
    expect(missing.length).toBe(Object.keys(TIER_MONTHLY_PRICE_CENTS).length - 1);
  });
});

describe('PricingService.setPrice tier backstop (V-746)', () => {
  it('rejects a tier with no self-serve price — the row would persist and never charge', async () => {
    const repo = new InMemoryPricingRepo();
    const svc = new PricingService(repo);
    // listEffective only maps over the constants, so an 'enterprise' row would be
    // written, returned as success, and then dropped by every reader.
    await expect(svc.setPrice('enterprise', 500_000)).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.setPrice('free', 100)).rejects.toBeInstanceOf(ValidationError);
    expect(await repo.listAll()).toHaveLength(0);
  });

  it('still accepts every priced tier', async () => {
    const svc = new PricingService(new InMemoryPricingRepo());
    for (const tier of Object.keys(TIER_MONTHLY_PRICE_CENTS)) {
      const row = await svc.setPrice(tier as Parameters<typeof svc.setPrice>[0], 4242);
      expect(row.monthlyCents).toBe(4242);
    }
  });
});
