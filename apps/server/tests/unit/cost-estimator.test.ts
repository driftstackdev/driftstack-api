// V-658 — unit tests for the cost estimator.
//
// Covers: arithmetic per cost component, total summation, threshold
// classification at boundary conditions, clamp behaviour on
// negative / NaN inputs, default tier-threshold sanity.

import { describe, expect, it } from 'vitest';
import {
  classifyThreshold,
  DEFAULT_TIER_THRESHOLDS,
  estimateCost,
  type AlertThresholds,
  type CostRates,
  type UsageInputs,
} from '../../src/lib/cost-estimator.js';

const RATES: CostRates = {
  computeCentsPerMinute: 1, // 1 cent / minute = €0.60 / hour
  storageCentsPerGbMonth: 2, // €0.02 / GB-month (R2 rate ~$0.015 ≈ €0.014)
  egressCentsPerGb: 5,
  emailCentsPerSend: 1, // Postmark rate at small volume
  llmCentsPer1kInputTokens: 30, // Anthropic Sonnet 4.6 ~$3 / 1M input ≈ €0.30 / 1k
  llmCentsPer1kOutputTokens: 150,
};

const THRESHOLDS: AlertThresholds = { softCents: 1000, hardCents: 5000 };

const EMPTY_USAGE: UsageInputs = {
  sessionMinutes: 0,
  storageGbMonths: 0,
  egressGb: 0,
  emailSends: 0,
  llmInputTokens: 0,
  llmOutputTokens: 0,
};

describe('V-658 estimateCost — per-component math', () => {
  it('compute: session-minutes × rate', () => {
    const b = estimateCost({ ...EMPTY_USAGE, sessionMinutes: 120 }, RATES, THRESHOLDS);
    expect(b.computeCents).toBe(120);
    expect(b.totalCents).toBe(120);
  });

  it('storage: GB-months × rate', () => {
    const b = estimateCost({ ...EMPTY_USAGE, storageGbMonths: 50 }, RATES, THRESHOLDS);
    expect(b.storageCents).toBe(100);
  });

  it('egress: GB × rate', () => {
    const b = estimateCost({ ...EMPTY_USAGE, egressGb: 10 }, RATES, THRESHOLDS);
    expect(b.egressCents).toBe(50);
  });

  it('email: sends × rate', () => {
    const b = estimateCost({ ...EMPTY_USAGE, emailSends: 200 }, RATES, THRESHOLDS);
    expect(b.emailCents).toBe(200);
  });

  it('LLM: input + output tokens with proper per-1k scaling', () => {
    const b = estimateCost(
      { ...EMPTY_USAGE, llmInputTokens: 10_000, llmOutputTokens: 5_000 },
      RATES,
      THRESHOLDS,
    );
    // (10 * 30) + (5 * 150) = 300 + 750 = 1050
    expect(b.llmCents).toBe(1050);
  });

  it('total = sum of components', () => {
    const usage: UsageInputs = {
      sessionMinutes: 60,
      storageGbMonths: 10,
      egressGb: 1,
      emailSends: 5,
      llmInputTokens: 1_000,
      llmOutputTokens: 1_000,
    };
    const b = estimateCost(usage, RATES, THRESHOLDS);
    // 60 + 20 + 5 + 5 + (30+150) = 270
    expect(b.totalCents).toBe(270);
  });
});

describe('V-658 estimateCost — input hardening', () => {
  it('negative inputs clamp to zero (no negative cost)', () => {
    const b = estimateCost(
      { ...EMPTY_USAGE, sessionMinutes: -5, llmInputTokens: -1000 },
      RATES,
      THRESHOLDS,
    );
    expect(b.totalCents).toBe(0);
  });

  it('NaN inputs clamp to zero', () => {
    const b = estimateCost({ ...EMPTY_USAGE, storageGbMonths: NaN }, RATES, THRESHOLDS);
    expect(b.storageCents).toBe(0);
  });

  it('Infinity inputs clamp to zero', () => {
    const b = estimateCost({ ...EMPTY_USAGE, egressGb: Infinity }, RATES, THRESHOLDS);
    expect(b.egressCents).toBe(0);
  });
});

describe('V-658 classifyThreshold', () => {
  const t: AlertThresholds = { softCents: 100, hardCents: 200 };
  it('< soft → under-soft', () => {
    expect(classifyThreshold(99, t)).toBe('under-soft');
    expect(classifyThreshold(0, t)).toBe('under-soft');
  });
  it('soft (boundary) → between-soft-and-hard', () => {
    expect(classifyThreshold(100, t)).toBe('between-soft-and-hard');
    expect(classifyThreshold(150, t)).toBe('between-soft-and-hard');
  });
  it('hard (boundary) → over-hard', () => {
    expect(classifyThreshold(200, t)).toBe('over-hard');
    expect(classifyThreshold(99_999, t)).toBe('over-hard');
  });
});

describe('V-658 DEFAULT_TIER_THRESHOLDS', () => {
  it('every tier has soft < hard', () => {
    for (const [tier, t] of Object.entries(DEFAULT_TIER_THRESHOLDS)) {
      expect(t.softCents, `${tier} softCents must be < hardCents`).toBeLessThan(t.hardCents);
      expect(t.softCents).toBeGreaterThan(0);
    }
  });

  it('contains all 6 pricing tiers', () => {
    const tiers = Object.keys(DEFAULT_TIER_THRESHOLDS).sort();
    expect(tiers).toEqual([
      'agency_manual',
      'api_builder',
      'api_scale',
      'api_starter',
      'solo_manual',
      'team_manual',
    ]);
  });
});
