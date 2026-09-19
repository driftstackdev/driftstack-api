// The credits rate card is provider list price × 2.0, and it never prices Opus.
//
// Every expected figure below is DERIVED from `CLAUDE_MODELS` (the list-price
// registry) × the card's markup; none is typed into this file. The card itself
// holds literal numbers on purpose — what a customer pays must not move when
// the registry is edited — so this is the arm that says the two agree today.
// When the provider's price moves, this fails, and the answer is a new card
// published with notice, not an edit to version 1.
//
// The row checks mirror the constraints the database will enforce on the same
// rows (positive rates, read ≤ input ≤ 5-minute write ≤ 1-hour write, a minimum
// below the maximum, no `claude-opus-*` model), so the seed cannot be refused.

import { describe, expect, it } from 'vitest';
import {
  AI_CREDITS_MODEL_DECISION,
  CREDIT_RATE_CARD_V1,
  MARKUP_BASIS_POINTS_PER_UNIT,
  MICROCREDITS_PER_CREDIT,
  type CreditRateCard,
  type CreditRateCardModelRow,
} from '../src/ai-credits.js';
import {
  AgentModelSchema,
  CLAUDE_MODELS,
  CLAUDE_MODEL_KEY_POLICY,
  deploymentKeyModelRefusal,
  type AgentModel,
} from '../src/agent-models.js';

const pricedModels = (): string[] => Object.keys(CREDIT_RATE_CARD_V1.models).sort();

/** A list price in microcents per token × a multiplier × the markup, required to be a whole number. */
function derive(centsPer1k: number, multiplier: number, markup: number, what: string): number {
  // cents per 1k tokens × 1000 = microcents per token.
  const value = centsPer1k * 1000 * multiplier * markup;
  const whole = Math.round(value);
  expect(
    Math.abs(value - whole),
    `${what} = ${String(value)} is not a whole microcredit`,
  ).toBeLessThan(1e-6);
  return whole;
}

describe('the credits rate card', () => {
  it('version 1 is the launch card at a markup of 2.0', () => {
    expect(CREDIT_RATE_CARD_V1.version).toBe(1);
    expect(CREDIT_RATE_CARD_V1.markupBp / MARKUP_BASIS_POINTS_PER_UNIT).toBe(2);
    expect(CREDIT_RATE_CARD_V1.note).toBe('Launch card: list price x 2.0');
  });

  it('every price equals the registry list price × the markup, derived per model and per kind of token', () => {
    const markup = CREDIT_RATE_CARD_V1.markupBp / MARKUP_BASIS_POINTS_PER_UNIT;
    const models = Object.entries(CREDIT_RATE_CARD_V1.models) as Array<
      [AgentModel, CreditRateCardModelRow]
    >;
    expect(models.length).toBeGreaterThan(0);
    for (const [model, row] of models) {
      const list = CLAUDE_MODELS[model];
      expect(list, `${model} is in the list-price registry`).toBeDefined();
      expect(row.inputMicroPerToken, `${model} input`).toBe(
        derive(list.inputCentsPer1k, 1, markup, `${model} input`),
      );
      expect(row.outputMicroPerToken, `${model} output`).toBe(
        derive(list.outputCentsPer1k, 1, markup, `${model} output`),
      );
      expect(row.cacheReadMicroPerToken, `${model} cache read`).toBe(
        derive(list.inputCentsPer1k, list.cacheReadMultiplier, markup, `${model} cache read`),
      );
      expect(row.cacheWrite5mMicroPerToken, `${model} 5-minute write`).toBe(
        derive(list.inputCentsPer1k, list.cacheWrite5mMultiplier, markup, `${model} 5m write`),
      );
      expect(row.cacheWrite1hMicroPerToken, `${model} 1-hour write`).toBe(
        derive(list.inputCentsPer1k, list.cacheWrite1hMultiplier, markup, `${model} 1h write`),
      );
      expect(row.listInputMicrocentsPerToken, `${model} list input`).toBe(
        derive(list.inputCentsPer1k, 1, 1, `${model} list input`),
      );
      expect(row.listOutputMicrocentsPerToken, `${model} list output`).toBe(
        derive(list.outputCentsPer1k, 1, 1, `${model} list output`),
      );
    }
  });

  it("Sonnet 5 starts at 6 credits and reserves at most 60 (the owner's figures); the others scale with their output price", () => {
    const sonnet = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
    expect(sonnet.minStartMicro).toBe(6 * MICROCREDITS_PER_CREDIT);
    expect(sonnet.maxReserveMicro).toBe(60 * MICROCREDITS_PER_CREDIT);
    for (const [model, row] of Object.entries(CREDIT_RATE_CARD_V1.models)) {
      const scale = row.outputMicroPerToken / sonnet.outputMicroPerToken;
      expect(row.minStartMicro, model).toBe(Math.round(sonnet.minStartMicro * scale));
      expect(row.maxReserveMicro, model).toBe(Math.round(sonnet.maxReserveMicro * scale));
    }
  });

  it('every row satisfies the constraints the database puts on it', () => {
    for (const [model, row] of Object.entries(CREDIT_RATE_CARD_V1.models)) {
      for (const [field, value] of Object.entries(row)) {
        expect(Number.isSafeInteger(value), `${model}.${field}`).toBe(true);
      }
      expect(row.inputMicroPerToken, model).toBeGreaterThan(0);
      expect(row.outputMicroPerToken, model).toBeGreaterThan(0);
      expect(row.cacheReadMicroPerToken, model).toBeGreaterThanOrEqual(0);
      expect(row.cacheReadMicroPerToken, model).toBeLessThanOrEqual(row.inputMicroPerToken);
      expect(row.inputMicroPerToken, model).toBeLessThanOrEqual(row.cacheWrite5mMicroPerToken);
      expect(row.cacheWrite5mMicroPerToken, model).toBeLessThanOrEqual(
        row.cacheWrite1hMicroPerToken,
      );
      expect(row.minStartMicro, model).toBeGreaterThan(0);
      expect(row.maxReserveMicro, model).toBeGreaterThanOrEqual(row.minStartMicro);
      expect(model, 'the database refuses any claude-opus-* row').not.toMatch(/^claude-opus-/);
    }
  });

  it('Opus is not in the credits rate card — no Opus id at all, not only the ones the registry names today', () => {
    const opus = AgentModelSchema.options.filter((m) => m.startsWith('claude-opus-'));
    expect(opus.length, 'the registry still has Opus models to exclude').toBeGreaterThan(0);
    for (const model of opus) {
      expect(Object.prototype.hasOwnProperty.call(CREDIT_RATE_CARD_V1.models, model), model).toBe(
        false,
      );
      expect(AI_CREDITS_MODEL_DECISION[model], model).toBe('own_key_only');
    }
    expect(pricedModels().filter((m) => /opus/i.test(m))).toEqual([]);
  });

  it('every model has a credits decision, and the card prices exactly the models decided on credits', () => {
    expect(Object.keys(AI_CREDITS_MODEL_DECISION).sort()).toEqual(
      [...AgentModelSchema.options].sort(),
    );
    const onCredits = AgentModelSchema.options.filter(
      (m) => AI_CREDITS_MODEL_DECISION[m] === 'on_credits',
    );
    expect(pricedModels()).toEqual([...onCredits].sort());
    expect(Object.isFrozen(AI_CREDITS_MODEL_DECISION)).toBe(true);
  });

  it('no model that may only run on the customer key is on credits, and every priced model may run on ours', () => {
    for (const model of AgentModelSchema.options) {
      if (CLAUDE_MODEL_KEY_POLICY[model] === 'own_key_only') {
        expect(AI_CREDITS_MODEL_DECISION[model], model).toBe('own_key_only');
      }
    }
    for (const model of pricedModels()) {
      expect(deploymentKeyModelRefusal(model), model).toBeNull();
    }
  });

  it('the card cannot be edited at run time', () => {
    expect(Object.isFrozen(CREDIT_RATE_CARD_V1)).toBe(true);
    expect(Object.isFrozen(CREDIT_RATE_CARD_V1.models)).toBe(true);
    expect(Object.isFrozen(CREDIT_RATE_CARD_V1.models['claude-sonnet-5'])).toBe(true);
    expect(() => {
      (
        CREDIT_RATE_CARD_V1.models['claude-sonnet-5'] as { outputMicroPerToken: number }
      ).outputMicroPerToken = 1;
    }).toThrow(TypeError);
  });

  it('a card that prices an Opus model does not type-check (compile-time arm, held by the package test typecheck)', () => {
    const row = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
    const models: CreditRateCard['models'] = {
      ...CREDIT_RATE_CARD_V1.models,
      // @ts-expect-error — 'claude-opus-5' is not a model decided on credits, so no card may price it.
      'claude-opus-5': row,
    };
    expect(Object.keys(models)).toContain('claude-opus-5');
  });
});
