// S14 — services/ai-account-state.ts: buildModelCatalogueEntry, the pure
// per-model composer behind `GET /v1/ai/models`. Pure: no database, no clock.

import { describe, expect, it } from 'vitest';
import { CREDIT_RATE_CARD_V1, DEFAULT_AGENT_MODEL } from '@driftstack/api-types';
import {
  buildModelCatalogueEntry,
  type RateCardModelPrices,
} from '../../src/services/ai-account-state.js';

const CARD_IN_FORCE = { version: 1, effectiveAt: '2026-01-01T00:00:00.000000Z' };
const SONNET_5_PRICES: RateCardModelPrices = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];

describe('buildModelCatalogueEntry — an own-key-only model', () => {
  it('CRITICAL Opus 5 is own_key_only, prices null, and runs only on own_key', () => {
    const entry = buildModelCatalogueEntry({
      model: 'claude-opus-5',
      tier: 'api_scale',
      rateCard: CARD_IN_FORCE,
      pricesInForce: null,
      nextRateCard: null,
      pricesNext: null,
    });
    expect(entry.on_credits_reason).toBe('own_key_only');
    expect(entry.runs_on).toEqual(['own_key']);
    expect(entry.min_credits_to_start).toBeNull();
    expect(entry.max_credits_per_task).toBeNull();
    expect(entry.credits_per_1k).toBeNull();
  });

  it('CRITICAL available_on_your_plan is false for an own-key-only model on Personal (own_key forbidden)', () => {
    const entry = buildModelCatalogueEntry({
      model: 'claude-opus-5',
      tier: 'solo_manual',
      rateCard: CARD_IN_FORCE,
      pricesInForce: null,
      nextRateCard: null,
      pricesNext: null,
    });
    expect(entry.available_on_your_plan).toBe(false);
  });

  it('available_on_your_plan is true for an own-key-only model on a plan that allows one', () => {
    const entry = buildModelCatalogueEntry({
      model: 'claude-opus-5',
      tier: 'team_manual',
      rateCard: CARD_IN_FORCE,
      pricesInForce: null,
      nextRateCard: null,
      pricesNext: null,
    });
    expect(entry.available_on_your_plan).toBe(true);
  });

  it('available_on_your_plan is false on a plan with no AI at all, even for an own-key-only model', () => {
    const entry = buildModelCatalogueEntry({
      model: 'claude-opus-5',
      tier: 'free',
      rateCard: CARD_IN_FORCE,
      pricesInForce: null,
      nextRateCard: null,
      pricesNext: null,
    });
    expect(entry.available_on_your_plan).toBe(false);
  });
});

describe('buildModelCatalogueEntry — Sonnet 5, priced on credits', () => {
  it("CRITICAL shows Sonnet 5's minimum to start, from the card in force", () => {
    expect(DEFAULT_AGENT_MODEL).toBe('claude-sonnet-5');
    const entry = buildModelCatalogueEntry({
      model: 'claude-sonnet-5',
      tier: 'solo_manual',
      rateCard: CARD_IN_FORCE,
      pricesInForce: SONNET_5_PRICES,
      nextRateCard: null,
      pricesNext: null,
    });
    // CREDIT_RATE_CARD_V1's Sonnet 5 row: minStartMicro 6_000_000 µcr = 6 credits.
    expect(entry.min_credits_to_start).toBe(6);
    expect(entry.max_credits_per_task).toBe(60);
    expect(entry.on_credits_reason).toBeNull();
    expect(entry.runs_on).toEqual(['credits', 'own_key']);
  });

  it('available_on_your_plan is true on Personal (own_key forbidden, but credits fund it)', () => {
    const entry = buildModelCatalogueEntry({
      model: 'claude-sonnet-5',
      tier: 'solo_manual',
      rateCard: CARD_IN_FORCE,
      pricesInForce: SONNET_5_PRICES,
      nextRateCard: null,
      pricesNext: null,
    });
    expect(entry.available_on_your_plan).toBe(true);
  });

  it('credits_per_1k is derived from the per-token rate, rounded up like any charge', () => {
    const entry = buildModelCatalogueEntry({
      model: 'claude-sonnet-5',
      tier: 'solo_manual',
      rateCard: CARD_IN_FORCE,
      pricesInForce: SONNET_5_PRICES,
      nextRateCard: null,
      pricesNext: null,
    });
    // 400 µcr/token input rate × 1000 = 400,000 µcr per 1k tokens = 0.4 credits.
    expect(entry.credits_per_1k).toEqual({
      input: 0.4,
      output: 2,
      cache_read: 0.04,
      cache_write_5m: 0.5,
      cache_write_1h: 0.8,
    });
  });
});

describe('buildModelCatalogueEntry — a model the card in force does not price (unpriced)', () => {
  it('CRITICAL an on_credits-decision model with no row on the current card reads unpriced, not own_key_only', () => {
    const entry = buildModelCatalogueEntry({
      model: 'claude-haiku-4-5',
      tier: 'api_scale',
      rateCard: CARD_IN_FORCE,
      pricesInForce: null,
      nextRateCard: null,
      pricesNext: null,
    });
    expect(entry.on_credits_reason).toBe('unpriced');
    expect(entry.runs_on).toEqual(['own_key']);
  });
});

describe('buildModelCatalogueEntry — the next announced card', () => {
  it('next is populated only when both a next card exists AND it prices this model', () => {
    const nextCard = { version: 2, effectiveAt: '2027-01-01T00:00:00.000000Z' };
    const withNext = buildModelCatalogueEntry({
      model: 'claude-sonnet-5',
      tier: 'solo_manual',
      rateCard: CARD_IN_FORCE,
      pricesInForce: SONNET_5_PRICES,
      nextRateCard: nextCard,
      pricesNext: { ...SONNET_5_PRICES, minStartMicro: 5_000_000 },
    });
    expect(withNext.next).not.toBeNull();
    expect(withNext.next?.rate_card_version).toBe(2);
    expect(withNext.next?.min_credits_to_start).toBe(5);

    const withoutPricedNext = buildModelCatalogueEntry({
      model: 'claude-sonnet-5',
      tier: 'solo_manual',
      rateCard: CARD_IN_FORCE,
      pricesInForce: SONNET_5_PRICES,
      nextRateCard: nextCard,
      pricesNext: null,
    });
    expect(withoutPricedNext.next).toBeNull();
  });
});
