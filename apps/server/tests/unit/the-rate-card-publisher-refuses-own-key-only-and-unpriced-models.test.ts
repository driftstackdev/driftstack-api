// The rate-card publisher refuses models that may only run on the customer's own
// key, and models nobody can price; everything it does publish is derived from
// the list-price registry × the markup.
//
// `deriveRateCardRows` is the validation half of publishing a card. The database
// refuses an Opus row by CHECK as well (0127); this is the layer that can say
// WHY to the person publishing, and the one that refuses on the key policy and
// the credits decision, which the database cannot see.
//
// The sources are substituted in several arms to show each rule is READ rather
// than assumed: a key policy flipped to own_key_only for a non-Opus model must
// refuse it, and an Opus id whose policy and decision were both (wrongly) opened
// up must still be refused by its name.

import { describe, expect, it } from 'vitest';
import {
  AI_CREDITS_MODEL_DECISION,
  AgentModelSchema,
  CLAUDE_MODELS,
  CLAUDE_MODEL_KEY_POLICY,
  CREDIT_RATE_CARD_V1,
  type AgentModel,
  type AgentModelInfo,
} from '@driftstack/api-types';
import {
  RATE_CARD_MAX_MARKUP_BP,
  RATE_CARD_MIN_MARKUP_BP,
  deriveRateCardRows,
  type RateCardDraftRefusal,
  type RateCardModelTerms,
  type RateCardSources,
} from '../../src/services/credit-rate-card-publisher.js';

const SHIPPED: RateCardSources = {
  registry: CLAUDE_MODELS,
  keyPolicy: CLAUDE_MODEL_KEY_POLICY,
  decisions: AI_CREDITS_MODEL_DECISION,
};

const LAUNCH_TERMS: RateCardModelTerms[] = Object.entries(CREDIT_RATE_CARD_V1.models).map(
  ([model, row]) => ({
    model,
    minStartMicro: row.minStartMicro,
    maxReserveMicro: row.maxReserveMicro,
  }),
);

const terms = (model: string): RateCardModelTerms => ({
  model,
  minStartMicro: 6_000_000,
  maxReserveMicro: 60_000_000,
});

function refusals(result: ReturnType<typeof deriveRateCardRows>): RateCardDraftRefusal[] {
  return result.ok ? [] : [...result.refusals];
}

const OPUS_MODELS = AgentModelSchema.options.filter((m) => /opus/i.test(m));

describe('the rate-card publisher', () => {
  it('CRITICAL the launch terms at 2.0 × derive exactly CREDIT_RATE_CARD_V1 — the positive control every refusal below is measured against', () => {
    const result = deriveRateCardRows({ markupBp: 20_000, models: LAUNCH_TERMS });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.markupBp).toBe(20_000);
    expect(Object.fromEntries(result.rows.map(({ model, ...row }) => [model, row]))).toEqual(
      CREDIT_RATE_CARD_V1.models,
    );
  });

  it('CRITICAL every Opus-class model is refused as own-key-only, and publishing one refuses the whole card', () => {
    expect(OPUS_MODELS.length, 'the registry still has Opus models to refuse').toBeGreaterThan(0);
    for (const model of OPUS_MODELS) {
      const result = deriveRateCardRows({
        markupBp: 20_000,
        models: [...LAUNCH_TERMS, terms(model)],
      });
      expect(result.ok, model).toBe(false);
      expect(refusals(result), model).toEqual([{ reason: 'own_key_only', model }]);
    }
  });

  it('CRITICAL a model the key policy marks own-key-only is refused even when it is not Opus — the policy is read, not inferred from the name', () => {
    const keyPolicy = { ...CLAUDE_MODEL_KEY_POLICY, 'claude-haiku-4-5': 'own_key_only' as const };
    const result = deriveRateCardRows(
      { markupBp: 20_000, models: [terms('claude-haiku-4-5'), terms('claude-sonnet-5')] },
      { ...SHIPPED, keyPolicy },
    );
    expect(refusals(result)).toEqual([{ reason: 'own_key_only', model: 'claude-haiku-4-5' }]);
  });

  it('CRITICAL a model the key policy does not mention is refused — an unknown policy is not permission to run on our key', () => {
    const { 'claude-haiku-4-5': _dropped, ...rest } = CLAUDE_MODEL_KEY_POLICY;
    const result = deriveRateCardRows(
      { markupBp: 20_000, models: [terms('claude-haiku-4-5'), terms('claude-sonnet-5')] },
      { ...SHIPPED, keyPolicy: rest as typeof CLAUDE_MODEL_KEY_POLICY },
    );
    expect(refusals(result)).toEqual([{ reason: 'own_key_only', model: 'claude-haiku-4-5' }]);
  });

  it('CRITICAL a model the credits decision keeps off credits is refused even when its key policy allows our key', () => {
    const decisions = {
      ...AI_CREDITS_MODEL_DECISION,
      'claude-sonnet-4-6': 'own_key_only' as const,
    };
    const result = deriveRateCardRows(
      { markupBp: 20_000, models: [terms('claude-sonnet-4-6')] },
      { ...SHIPPED, decisions },
    );
    expect(refusals(result)).toEqual([{ reason: 'own_key_only', model: 'claude-sonnet-4-6' }]);
  });

  it('CRITICAL an Opus model is refused by its name even if its key policy and credits decision were both opened up — one wrong edit cannot put Opus on credits', () => {
    const model = OPUS_MODELS[0] as AgentModel;
    const result = deriveRateCardRows(
      { markupBp: 20_000, models: [terms(model)] },
      {
        ...SHIPPED,
        keyPolicy: { ...CLAUDE_MODEL_KEY_POLICY, [model]: 'any_key' as const },
        decisions: { ...AI_CREDITS_MODEL_DECISION, [model]: 'on_credits' as const },
      },
    );
    expect(refusals(result)).toEqual([{ reason: 'own_key_only', model }]);
  });

  it('CRITICAL an id the registry does not know is refused as unpriced, including prototype names a plain index would answer', () => {
    for (const model of ['claude-sonnet-99', 'gpt-4o', '', 'toString', '__proto__']) {
      const result = deriveRateCardRows({ markupBp: 20_000, models: [terms(model)] });
      expect(refusals(result), JSON.stringify(model)).toEqual([{ reason: 'unpriced', model }]);
    }
  });

  it('a known model with no list price, or a non-positive one, is refused as unpriced', () => {
    const { 'claude-haiku-4-5': _dropped, ...rest } = CLAUDE_MODELS;
    const missing = deriveRateCardRows(
      { markupBp: 20_000, models: [terms('claude-haiku-4-5')] },
      { ...SHIPPED, registry: rest as Record<AgentModel, AgentModelInfo> },
    );
    expect(refusals(missing)).toEqual([{ reason: 'unpriced', model: 'claude-haiku-4-5' }]);

    const zero = deriveRateCardRows(
      { markupBp: 20_000, models: [terms('claude-haiku-4-5')] },
      {
        ...SHIPPED,
        registry: {
          ...CLAUDE_MODELS,
          'claude-haiku-4-5': { ...CLAUDE_MODELS['claude-haiku-4-5'], outputCentsPer1k: 0 },
        },
      },
    );
    expect(refusals(zero)).toEqual([{ reason: 'unpriced', model: 'claude-haiku-4-5' }]);
  });

  it('CRITICAL prices are derived from the registry at publish time: a registry with every price doubled publishes a card with every price doubled', () => {
    const doubled = Object.fromEntries(
      Object.entries(CLAUDE_MODELS).map(([id, info]) => [
        id,
        {
          ...info,
          inputCentsPer1k: info.inputCentsPer1k * 2,
          outputCentsPer1k: info.outputCentsPer1k * 2,
        },
      ]),
    ) as Record<AgentModel, AgentModelInfo>;
    const result = deriveRateCardRows(
      { markupBp: 20_000, models: LAUNCH_TERMS },
      { ...SHIPPED, registry: doubled },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    for (const { model, ...row } of result.rows) {
      const launch = CREDIT_RATE_CARD_V1.models[model as keyof typeof CREDIT_RATE_CARD_V1.models];
      expect(row.inputMicroPerToken, model).toBe(launch.inputMicroPerToken * 2);
      expect(row.outputMicroPerToken, model).toBe(launch.outputMicroPerToken * 2);
      expect(row.cacheReadMicroPerToken, model).toBe(launch.cacheReadMicroPerToken * 2);
      expect(row.cacheWrite5mMicroPerToken, model).toBe(launch.cacheWrite5mMicroPerToken * 2);
      expect(row.cacheWrite1hMicroPerToken, model).toBe(launch.cacheWrite1hMicroPerToken * 2);
      expect(row.listInputMicrocentsPerToken, model).toBe(launch.listInputMicrocentsPerToken * 2);
      // The per-task limits are policy inputs, not prices: unchanged.
      expect(row.minStartMicro, model).toBe(launch.minStartMicro);
      expect(row.maxReserveMicro, model).toBe(launch.maxReserveMicro);
    }
  });

  it('a markup whose float product is a hair off a whole number still derives the whole number (1.1 × gives Sonnet 5 an input of 220, not 220.00000000000003)', () => {
    expect(0.2 * 1000 * 1.1, 'the float error this arm exists for is real').not.toBe(220);
    const result = deriveRateCardRows({ markupBp: 11_000, models: [terms('claude-sonnet-5')] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({
      inputMicroPerToken: 220,
      outputMicroPerToken: 1_100,
      cacheReadMicroPerToken: 22,
      cacheWrite5mMicroPerToken: 275,
      cacheWrite1hMicroPerToken: 440,
    });
  });

  it('a markup under which one cache price is a genuine fraction is refused for that field alone (1.1 × gives Haiku a 5-minute write of 137.5)', () => {
    const result = deriveRateCardRows({ markupBp: 11_000, models: [terms('claude-haiku-4-5')] });
    expect(refusals(result)).toEqual([
      { reason: 'price_not_whole', model: 'claude-haiku-4-5', field: 'cacheWrite5mMicroPerToken' },
    ]);
  });

  it('CRITICAL a markup that would charge a fraction of a microcredit per token is refused, not rounded', () => {
    const result = deriveRateCardRows({ markupBp: 20_001, models: [terms('claude-haiku-4-5')] });
    expect(result.ok).toBe(false);
    const fields = refusals(result)
      .filter((r) => r.reason === 'price_not_whole')
      .map((r) => (r.reason === 'price_not_whole' ? r.field : ''));
    // 100 × 2.0001 = 200.01 and so on; the list prices themselves stay whole.
    expect(fields.sort()).toEqual(
      [
        'cacheReadMicroPerToken',
        'cacheWrite1hMicroPerToken',
        'cacheWrite5mMicroPerToken',
        'inputMicroPerToken',
        'outputMicroPerToken',
      ].sort(),
    );
  });

  it('CRITICAL the markup must lie within 1.0 × to 10.0 × — the range the database accepts — and both ends are allowed', () => {
    expect(RATE_CARD_MIN_MARKUP_BP).toBe(10_000);
    expect(RATE_CARD_MAX_MARKUP_BP).toBe(100_000);
    for (const markupBp of [9_999, 100_001, 0, -20_000, Number.NaN, 20_000.5]) {
      const result = deriveRateCardRows({ markupBp, models: [terms('claude-sonnet-5')] });
      expect(refusals(result), String(markupBp)).toEqual([
        { reason: 'markup_out_of_range', markupBp },
      ]);
    }
    for (const markupBp of [10_000, 100_000]) {
      expect(
        deriveRateCardRows({ markupBp, models: [terms('claude-sonnet-5')] }).ok,
        String(markupBp),
      ).toBe(true);
    }
  });

  it('a card with no models, or one model twice, is refused', () => {
    expect(refusals(deriveRateCardRows({ markupBp: 20_000, models: [] }))).toEqual([
      { reason: 'no_models' },
    ]);
    expect(
      refusals(
        deriveRateCardRows({
          markupBp: 20_000,
          models: [terms('claude-sonnet-5'), terms('claude-sonnet-5')],
        }),
      ),
    ).toEqual([{ reason: 'duplicate_model', model: 'claude-sonnet-5' }]);
  });

  it('the per-task limits must be a positive start and a reserve no smaller than it, in whole microcredits', () => {
    for (const [minStartMicro, maxReserveMicro] of [
      [0, 60_000_000],
      [-1, 60_000_000],
      [6_000_000, 5_999_999],
      [6_000_000.5, 60_000_000],
    ] as const) {
      const result = deriveRateCardRows({
        markupBp: 20_000,
        models: [{ model: 'claude-sonnet-5', minStartMicro, maxReserveMicro }],
      });
      expect(refusals(result), `${String(minStartMicro)}..${String(maxReserveMicro)}`).toEqual([
        { reason: 'reserve_bounds', model: 'claude-sonnet-5' },
      ]);
    }
    expect(
      deriveRateCardRows({
        markupBp: 20_000,
        models: [
          { model: 'claude-sonnet-5', minStartMicro: 6_000_000, maxReserveMicro: 6_000_000 },
        ],
      }).ok,
      'a reserve equal to the start is allowed',
    ).toBe(true);
  });

  it('a registry whose cache multipliers break read ≤ input ≤ 5-minute ≤ 1-hour is refused, because the call bound relies on that order', () => {
    const result = deriveRateCardRows(
      { markupBp: 20_000, models: [terms('claude-sonnet-5')] },
      {
        ...SHIPPED,
        registry: {
          ...CLAUDE_MODELS,
          'claude-sonnet-5': { ...CLAUDE_MODELS['claude-sonnet-5'], cacheReadMultiplier: 2 },
        },
      },
    );
    expect(refusals(result)).toEqual([{ reason: 'rate_order', model: 'claude-sonnet-5' }]);
  });

  it('a negative cache-read price is refused here, as the database would refuse it, rather than passed on as a publishable card', () => {
    const result = deriveRateCardRows(
      { markupBp: 20_000, models: [terms('claude-sonnet-5')] },
      {
        ...SHIPPED,
        registry: {
          ...CLAUDE_MODELS,
          'claude-sonnet-5': { ...CLAUDE_MODELS['claude-sonnet-5'], cacheReadMultiplier: -0.1 },
        },
      },
    );
    expect(refusals(result)).toEqual([{ reason: 'rate_order', model: 'claude-sonnet-5' }]);
  });

  it('every refusal is reported at once, not only the first', () => {
    const result = deriveRateCardRows({
      markupBp: 9_000,
      models: [
        terms('claude-opus-5'),
        terms('claude-nope'),
        terms('claude-sonnet-5'),
        terms('claude-sonnet-5'),
      ],
    });
    expect(refusals(result)).toEqual([
      { reason: 'markup_out_of_range', markupBp: 9_000 },
      { reason: 'own_key_only', model: 'claude-opus-5' },
      { reason: 'unpriced', model: 'claude-nope' },
      { reason: 'duplicate_model', model: 'claude-sonnet-5' },
    ]);
  });
});
