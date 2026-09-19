// Every model a customer can pick to run on Driftstack's key has a price.
//
// A model with no list price is refused on the deployment's key (a call there
// would be unmetered), and that refusal is OUR fault, not the customer's: they
// picked a model the picker offered and every turn fails. The route counts it
// (`bundled_llm_error_total{kind="model_unpriced"}`) and reports it to Sentry,
// but both of those fire only after a customer has hit it in production. This
// catches it before the deploy exists.
//
// The population is DERIVED from the registry, not listed here: every id the
// create request accepts (`AgentModelSchema`, the list every picker and SDK
// sends from) that the key policy does not reserve for the customer's own key.
// A model added to the enum is in scope the moment it is added.
//
// ⛔ Read from the api-types SOURCE, not the package entry point. The package
// resolves to its built `dist/`, which can be older than the source it was built
// from; a check that passes against a stale build certifies nothing about the
// source that ships.

import { describe, expect, it } from 'vitest';
import {
  AgentModelSchema,
  CLAUDE_MODELS,
  CLAUDE_MODEL_KEY_POLICY,
  DEFAULT_AGENT_MODEL,
  agentModelListPrice,
  deploymentKeyModelRefusal,
  listPriceCostMillicents,
} from '../../../../packages/api-types/src/agent-models.js';

/** Every selectable model the deployment's key does NOT reserve for the
 *  customer's own key. Keyed on "not own_key_only" rather than "is any_key", so
 *  a model whose policy is missing lands IN the population — which is how the
 *  refusal treats it too (only `own_key_only` is refused on policy grounds). */
function modelsSelectableOnOurKey(): string[] {
  return AgentModelSchema.options.filter(
    (m) => (CLAUDE_MODEL_KEY_POLICY as Record<string, string | undefined>)[m] !== 'own_key_only',
  );
}

const ONE_OF_EACH = {
  uncachedInput: 1_000,
  output: 1_000,
  cacheRead: 1_000,
  cacheWrite5m: 1_000,
  cacheWrite1h: 1_000,
};

describe('every model a customer can pick on our key has a price', () => {
  it('the population is real: it is non-empty, and it holds the default — a session that names no model runs on our key, so the default must be priced above all', () => {
    const population = modelsSelectableOnOurKey();
    expect(population.length).toBeGreaterThan(0);
    expect(population).toContain(DEFAULT_AGENT_MODEL);
  });

  it('CRITICAL every such model has a list price with finite, positive rates, so a turn on our key can be metered', () => {
    const unpriced: string[] = [];
    for (const model of modelsSelectableOnOurKey()) {
      const price = agentModelListPrice(model);
      if (price === null) {
        unpriced.push(`${model}: no row in CLAUDE_MODELS`);
        continue;
      }
      const rates = {
        inputCentsPer1k: price.inputCentsPer1k,
        outputCentsPer1k: price.outputCentsPer1k,
        cacheReadMultiplier: price.cacheReadMultiplier,
        cacheWrite5mMultiplier: price.cacheWrite5mMultiplier,
        cacheWrite1hMultiplier: price.cacheWrite1hMultiplier,
      };
      for (const [field, value] of Object.entries(rates)) {
        if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
          unpriced.push(`${model}: ${field} = ${String(value)}`);
        }
      }
      const cost = listPriceCostMillicents(model, ONE_OF_EACH);
      if (!(cost !== null && Number.isFinite(cost) && cost > 0)) {
        unpriced.push(`${model}: a call cannot be costed (${String(cost)})`);
      }
    }
    expect(unpriced, 'model(s) a customer can run on our key that cannot be metered:').toEqual([]);
  });

  it('CRITICAL the deployment key refuses none of them — the same function the route asks answers null for every one', () => {
    const refused = modelsSelectableOnOurKey()
      .map((model) => ({ model, refusal: deploymentKeyModelRefusal(model) }))
      .filter(({ refusal }) => refusal !== null)
      .map(({ model, refusal }) => `${model}: ${String(refusal)}`);
    expect(refused).toEqual([]);
  });

  it('the key policy and the price table are total over the enum — a model missing from either is decided by accident', () => {
    const ids = [...AgentModelSchema.options].sort();
    expect(Object.keys(CLAUDE_MODEL_KEY_POLICY).sort()).toEqual(ids);
    expect(Object.keys(CLAUDE_MODELS).sort()).toEqual(ids);
  });

  it('the checks above can fail: an id the registry does not price reads as unpriced and is refused', () => {
    expect(agentModelListPrice('claude-not-in-the-registry')).toBeNull();
    expect(deploymentKeyModelRefusal('claude-not-in-the-registry')).toBe('unpriced');
    expect(listPriceCostMillicents('claude-not-in-the-registry', ONE_OF_EACH)).toBeNull();
    // …and a priced id that IS reserved for the customer's own key is outside
    // the population, not a false pass: it is refused for policy, not price.
    expect(modelsSelectableOnOurKey()).not.toContain('claude-opus-5');
    expect(deploymentKeyModelRefusal('claude-opus-5')).toBe('own_key_only');
  });
});
