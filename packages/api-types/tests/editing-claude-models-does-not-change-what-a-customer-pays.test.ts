// Editing CLAUDE_MODELS does not change what a customer pays.
//
// `CLAUDE_MODELS` is the cost-to-serve registry: it follows the provider's list
// price and is edited whenever that price moves. What a customer pays moves only
// through a new rate card announced with notice. So the credits module must not
// read its prices from the registry — not at call time, and not once at load
// time either, which a check on already-loaded values cannot tell apart.
//
// This loads the credits module FRESH against a registry whose every price has
// been doubled, and requires the card and a charge computed from it to be
// unchanged. A card derived from the registry at load time would come back
// doubled here.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as loaded from '../src/ai-credits.js';
import type * as AgentModels from '../src/agent-models.js';

const TOKENS = {
  uncachedInput: 12_345,
  output: 678,
  cacheRead: 9_000,
  cacheWrite5m: 1_111,
  cacheWrite1h: 2_222,
};

afterEach(() => {
  vi.doUnmock('../src/agent-models.js');
  vi.resetModules();
});

describe('editing CLAUDE_MODELS does not change what a customer pays', () => {
  it('a registry with every price doubled leaves the card, and the charge, exactly as they were', async () => {
    vi.resetModules();
    vi.doMock('../src/agent-models.js', async (importOriginal) => {
      const original = await importOriginal<typeof AgentModels>();
      const doubled = Object.fromEntries(
        Object.entries(original.CLAUDE_MODELS).map(([id, info]) => [
          id,
          {
            ...info,
            inputCentsPer1k: info.inputCentsPer1k * 2,
            outputCentsPer1k: info.outputCentsPer1k * 2,
          },
        ]),
      ) as typeof original.CLAUDE_MODELS;
      return { ...original, CLAUDE_MODELS: doubled };
    });

    // Positive control: the edited registry really is what a fresh import sees.
    const registry = await import('../src/agent-models.js');
    expect(registry.CLAUDE_MODELS['claude-sonnet-5'].inputCentsPer1k).toBe(0.4);

    const fresh = await import('../src/ai-credits.js');
    expect(fresh).not.toBe(loaded);
    expect(fresh.CREDIT_RATE_CARD_V1).toEqual(loaded.CREDIT_RATE_CARD_V1);
    for (const model of Object.keys(loaded.CREDIT_RATE_CARD_V1.models) as Array<
      keyof typeof loaded.CREDIT_RATE_CARD_V1.models
    >) {
      expect(fresh.callChargeMicro(TOKENS, fresh.CREDIT_RATE_CARD_V1.models[model]), model).toBe(
        loaded.callChargeMicro(TOKENS, loaded.CREDIT_RATE_CARD_V1.models[model]),
      );
    }
  });

  it('a charge is computed from a rate row, never from a model name that could be looked up in the registry', () => {
    // The signature is the guarantee: callChargeMicro takes rates, not an id.
    expect(loaded.callChargeMicro.length).toBe(2);
    const row = loaded.CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
    expect(loaded.callChargeMicro(TOKENS, row)).toBe(
      TOKENS.uncachedInput * row.inputMicroPerToken +
        TOKENS.output * row.outputMicroPerToken +
        TOKENS.cacheRead * row.cacheReadMicroPerToken +
        TOKENS.cacheWrite5m * row.cacheWrite5mMicroPerToken +
        TOKENS.cacheWrite1h * row.cacheWrite1hMicroPerToken,
    );
  });
});
