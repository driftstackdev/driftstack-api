// Every usage row records what its model call COST at the provider's list price,
// beside — never instead of — the flat price the bundled soft cap sums.
//
// Why this exists: the credit ledger (monthly credits, burn = real cost × 2) has
// to be built on true numbers. Until now a bundled row carried only a flat 10
// cents per turn, and an own-key row carried a per-call figure rounded UP to a
// whole cent — which overstates a 200-call session by up to $2. Neither is the
// cost of anything. `list_price_cost_millicents` is: every part of the call at
// its own rate, nothing rounded up.
//
// The two fields must never be confused. The soft cap sums `cost_usd_cents`;
// summing the list price there would change what every customer's cap means,
// and summing the flat price into a ledger would bill a 40-call turn like a
// 1-call turn. The DB half of that — the cap's SQL really does sum only the
// posted field — is in tests/integration/the-bundled-cap-sums-the-posted-price-
// not-the-list-price.test.ts.

import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import {
  AgentModelSchema,
  CLAUDE_MODELS,
  agentModelListPrice,
  listPriceCostMillicents,
  type ModelCallTokens,
} from '@driftstack/api-types';
import {
  DrizzleAgentDecomposerUsageRecorder,
  LIST_PRICE_COST_FIELD,
  POSTED_COST_FIELD,
  listPriceOfCall,
  modelCallTokens,
} from '../../src/db/agent-decomposer-usage-recorder.js';
import type { Database } from '../../src/db/client.js';
import type { AccountAuditService } from '../../src/services/account-audit.js';
import type { DecomposeUsage } from '../../src/services/agent-decomposer.js';
import { abortedCallEvidence } from '../../src/services/agent-runtime.js';

const NONE: ModelCallTokens = {
  uncachedInput: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
};

interface CapturedInsert {
  recordType: string;
  metadata: Record<string, unknown>;
}

function recorderWithCapture(): {
  recorder: DrizzleAgentDecomposerUsageRecorder;
  rows: CapturedInsert[];
  auditPayloads: Array<Record<string, unknown>>;
} {
  const rows: CapturedInsert[] = [];
  const auditPayloads: Array<Record<string, unknown>> = [];
  const database = {
    db: {
      insert: () => ({
        values: (row: CapturedInsert) => {
          rows.push(row);
          return { onConflictDoNothing: () => Promise.resolve() };
        },
      }),
    },
  } as unknown as Database;
  const logger = { warn: () => undefined, error: () => undefined } as unknown as Logger;
  const accountAudit = {
    record: (entry: { payload: Record<string, unknown> }) => {
      auditPayloads.push(entry.payload);
      return Promise.resolve();
    },
  } as unknown as AccountAuditService;
  return {
    recorder: new DrizzleAgentDecomposerUsageRecorder(database, logger, accountAudit),
    rows,
    auditPayloads,
  };
}

/** A Sonnet 5 call with every billed part present, so each rate is exercised. */
const SONNET_CALL: DecomposeUsage = {
  decomposerKind: 'claude',
  model: 'claude-sonnet-5',
  anthropicInputTokens: 1_000,
  anthropicOutputTokens: 1_000,
  anthropicCacheReadInputTokens: 1_000,
  anthropicCacheCreationInputTokens: 2_000,
  anthropicCacheCreation5mInputTokens: 1_000,
  anthropicCacheCreation1hInputTokens: 1_000,
  // The ceilinged per-call figure the adapter reports; deliberately NOT the
  // list price, so a test can tell the two apart.
  costUsdCents: 3,
};
// Sonnet 5: input 0.2 c/1k, output 1.0 c/1k → per 1,000 tokens, in millicents:
//   uncached 200 + output 1000 + read (0.1x) 20 + 5m write (1.25x) 250 + 1h write (2x) 400
const SONNET_CALL_MILLICENTS = 200 + 1_000 + 20 + 250 + 400;

const base = {
  accountId: '00000000-0000-4000-8000-0000000000b1',
  recordId: '00000000-0000-4000-8000-0000000000b3',
  driftstackSessionId: null,
  agentSessionId: 'agt_00000000-0000-4000-8000-0000000000b2',
  decomposeResultKind: 'plan' as const,
  tokensConsumed: 100,
  now: new Date('2026-09-19T00:00:00.000Z'),
};

describe('the list-price cost of one call', () => {
  it('CRITICAL prices every part of the call at its own rate', () => {
    expect(listPriceCostMillicents('claude-sonnet-5', { ...NONE, uncachedInput: 1_000 })).toBe(200);
    expect(listPriceCostMillicents('claude-sonnet-5', { ...NONE, output: 1_000 })).toBe(1_000);
    expect(listPriceCostMillicents('claude-sonnet-5', { ...NONE, cacheRead: 1_000 })).toBe(20);
    expect(listPriceCostMillicents('claude-sonnet-5', { ...NONE, cacheWrite5m: 1_000 })).toBe(250);
    expect(listPriceCostMillicents('claude-sonnet-5', { ...NONE, cacheWrite1h: 1_000 })).toBe(400);
    expect(listPriceCostMillicents('claude-opus-5', { ...NONE, output: 1_000 })).toBe(2_500);
  });

  it('CRITICAL never rounds up: one uncached Haiku token costs a tenth of a millicent, not a whole one — and not a whole cent', () => {
    expect(listPriceCostMillicents('claude-haiku-4-5', { ...NONE, uncachedInput: 1 })).toBe(0.1);
    // 200 one-token calls cost exactly what one 200-token call costs. A per-call
    // ceiling (the flaw of the cent-rounded figure) breaks exactly this.
    let sum = 0;
    for (let i = 0; i < 200; i++) {
      sum += listPriceCostMillicents('claude-haiku-4-5', { ...NONE, uncachedInput: 1 }) ?? NaN;
    }
    expect(Math.round(sum * 1000) / 1000).toBe(
      listPriceCostMillicents('claude-haiku-4-5', { ...NONE, uncachedInput: 200 }),
    );
  });

  it('is exact for every model in the registry: each rate is a whole number of microcents per token, so the result carries no float noise', () => {
    for (const model of AgentModelSchema.options) {
      const r = CLAUDE_MODELS[model];
      for (const perToken of [
        r.inputCentsPer1k * 1000,
        r.outputCentsPer1k * 1000,
        r.inputCentsPer1k * r.cacheReadMultiplier * 1000,
        r.inputCentsPer1k * r.cacheWrite5mMultiplier * 1000,
        r.inputCentsPer1k * r.cacheWrite1hMultiplier * 1000,
      ]) {
        expect(Math.abs(perToken - Math.round(perToken)), model).toBeLessThan(1e-9);
      }
    }
  });

  it('CRITICAL a model the registry cannot price is null — never a default rate, never zero', () => {
    expect(listPriceCostMillicents('claude-mystery-9', { ...NONE, output: 1_000 })).toBeNull();
    expect(listPriceCostMillicents('claude-opus-6', { ...NONE, output: 1_000 })).toBeNull();
    // A plain index into the registry would answer these with Object.prototype.
    expect(agentModelListPrice('toString')).toBeNull();
    expect(agentModelListPrice('__proto__')).toBeNull();
    expect(agentModelListPrice('constructor')).toBeNull();
  });

  it('a count that is not a non-negative finite number is null, not a number built on it', () => {
    expect(listPriceCostMillicents('claude-sonnet-5', { ...NONE, output: -1 })).toBeNull();
    expect(listPriceCostMillicents('claude-sonnet-5', { ...NONE, output: Number.NaN })).toBeNull();
    expect(
      listPriceCostMillicents('claude-sonnet-5', { ...NONE, cacheRead: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
});

describe('what a usage block says the call cost', () => {
  it('a cache write the provider did not break down by lifetime is priced at the 1-hour rate, so it can overstate but never understate', () => {
    const tokens = modelCallTokens({
      decomposerKind: 'claude',
      model: 'claude-sonnet-5',
      anthropicCacheCreationInputTokens: 1_000,
    });
    expect(tokens).toEqual({ ...NONE, cacheWrite5m: 0, cacheWrite1h: 1_000 });
    expect(listPriceCostMillicents('claude-sonnet-5', tokens)).toBe(400);
  });

  it('a partially broken-down write keeps the reported 5-minute part at its own rate', () => {
    expect(
      modelCallTokens({
        decomposerKind: 'claude',
        anthropicCacheCreationInputTokens: 1_500,
        anthropicCacheCreation5mInputTokens: 1_000,
      }),
    ).toEqual({ ...NONE, cacheWrite5m: 1_000, cacheWrite1h: 500 });
  });

  it('no model call (the deterministic decomposer) costs exactly 0; a model call with no model named is null', () => {
    expect(listPriceOfCall({ decomposerKind: 'deterministic' })).toBe(0);
    expect(listPriceOfCall({ decomposerKind: 'claude', anthropicOutputTokens: 10 })).toBeNull();
    expect(listPriceOfCall(SONNET_CALL)).toBe(SONNET_CALL_MILLICENTS);
  });

  it('CRITICAL a call stopped before the provider reported its usage is null, not free — the provider still billed it', () => {
    // Exactly the block the runtime builds when the customer's Stop cuts a call
    // off with no usage on the error: a model, and no counts at all.
    const stopped = abortedCallEvidence(new Error('aborted'), 'claude-sonnet-5').usage;
    expect(stopped.model).toBe('claude-sonnet-5');
    expect(listPriceOfCall(stopped)).toBeNull();
    // Either count missing is enough; cache counts may legitimately be absent.
    expect(
      listPriceOfCall({
        decomposerKind: 'claude',
        model: 'claude-sonnet-5',
        anthropicInputTokens: 10,
      }),
    ).toBeNull();
    expect(
      listPriceOfCall({
        decomposerKind: 'claude',
        model: 'claude-sonnet-5',
        anthropicOutputTokens: 10,
      }),
    ).toBeNull();
    expect(
      listPriceOfCall({
        decomposerKind: 'claude',
        model: 'claude-sonnet-5',
        anthropicInputTokens: 1_000,
        anthropicOutputTokens: 0,
      }),
    ).toBe(200);
  });
});

describe('the usage row', () => {
  it('CRITICAL the two cost fields have different names in different units', () => {
    expect(POSTED_COST_FIELD).toBe('cost_usd_cents');
    expect(LIST_PRICE_COST_FIELD).toBe('list_price_cost_millicents');
  });

  it('CRITICAL a bundled row carries the flat posted price AND the true list-price cost, each in its own field', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({ ...base, usage: SONNET_CALL, keySource: 'bundled' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recordType).toBe('agent_decomposer_bundled');
    expect(rows[0]!.metadata[POSTED_COST_FIELD], 'the soft cap still sees the flat price').toBe(10);
    expect(rows[0]!.metadata[LIST_PRICE_COST_FIELD]).toBe(SONNET_CALL_MILLICENTS);
  });

  it('CRITICAL the second row of a bundled turn posts 0 flat but still records what its call cost — every call is a real cost', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({
      ...base,
      usage: SONNET_CALL,
      keySource: 'bundled',
      bundledFlatCostAlreadyPosted: true,
    });
    expect(rows[0]!.metadata[POSTED_COST_FIELD]).toBe(0);
    expect(rows[0]!.metadata[LIST_PRICE_COST_FIELD]).toBe(SONNET_CALL_MILLICENTS);
  });

  it('CRITICAL an own-key row carries the list price too, and keeps its rounded per-call figure where it was', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({ ...base, usage: SONNET_CALL, keySource: 'cached' });
    expect(rows[0]!.recordType).toBe('agent_decomposer');
    expect(rows[0]!.metadata[POSTED_COST_FIELD]).toBe(3);
    expect(rows[0]!.metadata[LIST_PRICE_COST_FIELD]).toBe(SONNET_CALL_MILLICENTS);
  });

  it('an unpriceable call is written as null, so "we could not price it" is never stored as "free"', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({
      ...base,
      usage: { ...SONNET_CALL, model: 'claude-mystery-9' },
      keySource: 'header',
    });
    expect(rows[0]!.metadata).toHaveProperty(LIST_PRICE_COST_FIELD, null);
  });

  it('CRITICAL a stopped call with no reported usage lands on its row as null, while the flat price is still posted', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({
      ...base,
      usage: abortedCallEvidence(new Error('aborted'), 'claude-sonnet-5').usage,
      // What accountForAbortedCall records for a stopped first call.
      decomposeResultKind: 'refuse',
      keySource: 'bundled',
    });
    expect(rows[0]!.metadata[POSTED_COST_FIELD]).toBe(10);
    expect(rows[0]!.metadata).toHaveProperty(LIST_PRICE_COST_FIELD, null);
  });

  it('CRITICAL S11 — a metered turn’s row names the AI-credits task it was measured against, so the shadow report can put what the call COST beside what it was CHARGED. Without it the two sides are separate populations: an own-key turn writes a row here and no call there, and "the charge is twice the list price" becomes a statement about whatever the window held.', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({
      ...base,
      usage: SONNET_CALL,
      keySource: 'bundled',
      creditReservationId: 'a2f0f1d4-0000-4000-8000-000000000001',
    });
    expect(rows[0]!.metadata.credit_reservation_id).toBe('a2f0f1d4-0000-4000-8000-000000000001');
  });

  it('CRITICAL a turn with no meter writes no credits field at all — the row a deployment with credits off produces is the same shape it has always been', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({ ...base, usage: SONNET_CALL, keySource: 'bundled' });
    expect(rows[0]!.metadata).not.toHaveProperty('credit_reservation_id');
  });

  it('CRITICAL the reservation id stays OFF the customer-visible audit payload, for the same reason the list price does: until AI credits launch, nothing a customer can read may mention them', async () => {
    const { recorder, rows, auditPayloads } = recorderWithCapture();
    await recorder.record({
      ...base,
      usage: SONNET_CALL,
      keySource: 'bundled',
      creditReservationId: 'a2f0f1d4-0000-4000-8000-000000000002',
    });
    expect(rows[0]!.metadata).toHaveProperty('credit_reservation_id');
    expect(auditPayloads).toHaveLength(1);
    expect(auditPayloads[0]).not.toHaveProperty('credit_reservation_id');
  });

  it('CRITICAL the list-price cost stays OFF the customer-visible audit payload, on bundled and own-key rows alike', async () => {
    const { recorder, rows, auditPayloads } = recorderWithCapture();
    await recorder.record({ ...base, usage: SONNET_CALL, keySource: 'bundled' });
    await recorder.record({ ...base, usage: SONNET_CALL, keySource: 'cached' });
    expect(rows.map((r) => r.metadata[LIST_PRICE_COST_FIELD])).toEqual([
      SONNET_CALL_MILLICENTS,
      SONNET_CALL_MILLICENTS,
    ]);
    expect(auditPayloads).toHaveLength(2);
    for (const payload of auditPayloads) expect(payload).not.toHaveProperty(LIST_PRICE_COST_FIELD);
  });
});
