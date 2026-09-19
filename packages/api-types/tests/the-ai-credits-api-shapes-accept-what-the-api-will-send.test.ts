// The AI-credits API shapes accept what the API will send, and refuse what it
// must not: an amount with more than three decimals, a negative balance, an
// "automatic" AI source written through the settings route, a ledger cursor
// that is not an entry id.
//
// No route uses these yet. They are the contract the read and settings routes
// will be built against, so what they accept is pinned now.

import { describe, expect, it } from 'vitest';
import {
  AccountAiStateSchema,
  AiCreditsExhaustedExtensionsSchema,
  AiLedgerEntrySchema,
  AiLedgerPageSchema,
  AiLedgerQuerySchema,
  AiModelCatalogueResponseSchema,
  CreditAmountSchema,
  MAX_AI_TASKS_IN_FLIGHT,
  SignedCreditAmountSchema,
  TurnCreditsUsageSchema,
  UpdateAiSettingsRequestSchema,
  aiSourcesAllowedOnPlan,
  balanceCreditsForDisplay,
  chargeCreditsForDisplay,
  creditsPer1kTokens,
  CREDIT_RATE_CARD_V1,
} from '../src/ai-credits.js';

const STATE = {
  billing: 'credits',
  plan: {
    tier: 'team_manual',
    ai_included: true,
    monthly_included_credits: 5_000,
    own_key_allowed: true,
    allowed_sources: aiSourcesAllowedOnPlan('team_manual'),
  },
  ai_source: null,
  ai_source_set_by: 'cutover',
  effective_source: 'credits',
  own_key: { has_key: false, usable: false, set_at: null, expires_at: null },
  balance: {
    available_credits: balanceCreditsForDisplay(4_321_987_654),
    monthly: {
      granted_credits: 5_000,
      remaining_credits: 4_321.987,
      period_start: '2027-01-15T00:00:00Z',
      resets_at: '2027-02-15T00:00:00Z',
    },
    extras: [{ kind: 'goodwill', remaining_credits: 50, expires_at: '2027-02-15T00:00:00Z' }],
    reserved_in_flight_credits: 60,
    pending_claims_credits: 0,
    debt_credits: 0,
    tasks_in_flight: 1,
    max_tasks_in_flight: MAX_AI_TASKS_IN_FLIGHT,
  },
  blocked_reason: null,
  debt_reason: null,
  auto_top_up: { enabled: false },
  rate_card: { version: 1, effective_at: '2026-10-01T00:00:00Z', next: null },
};

describe('the AI-credits API shapes', () => {
  it('an account AI state parses, and every enum the plan names is accepted', () => {
    expect(AccountAiStateSchema.parse(STATE)).toEqual(STATE);
    for (const blocked of [
      'ai_not_on_plan',
      'no_credits',
      'debt',
      'own_key_missing',
      'tasks_in_flight',
    ]) {
      expect(
        AccountAiStateSchema.safeParse({ ...STATE, blocked_reason: blocked }).success,
        blocked,
      ).toBe(true);
    }
    for (const reason of ['payment_reversed', 'plan_change']) {
      expect(
        AccountAiStateSchema.safeParse({ ...STATE, debt_reason: reason }).success,
        reason,
      ).toBe(true);
    }
  });

  it('a Free account has no effective source and no allowed sources', () => {
    const free = {
      ...STATE,
      plan: {
        ...STATE.plan,
        tier: 'free',
        ai_included: false,
        monthly_included_credits: 0,
        own_key_allowed: false,
        allowed_sources: aiSourcesAllowedOnPlan('free'),
      },
      effective_source: null,
      blocked_reason: 'ai_not_on_plan',
    };
    expect(AccountAiStateSchema.safeParse(free).success).toBe(true);
  });

  it('amounts carry at most three decimals and a balance is never negative', () => {
    expect(CreditAmountSchema.safeParse(1.234).success).toBe(true);
    expect(CreditAmountSchema.safeParse(1.2345).success).toBe(false);
    expect(CreditAmountSchema.safeParse(-0.001).success).toBe(false);
    expect(SignedCreditAmountSchema.safeParse(-0.001).success).toBe(true);
    expect(SignedCreditAmountSchema.safeParse(-0.0015).success).toBe(false);
    expect(
      AccountAiStateSchema.safeParse({
        ...STATE,
        balance: { ...STATE.balance, available_credits: 4_321.9876 },
      }).success,
    ).toBe(false);
    expect(chargeCreditsForDisplay(1_234_567)).toBe(1.235);
  });

  it('tasks in flight never exceed the three an account may hold', () => {
    expect(MAX_AI_TASKS_IN_FLIGHT).toBe(3);
    expect(
      AccountAiStateSchema.safeParse({
        ...STATE,
        balance: { ...STATE.balance, tasks_in_flight: 4 },
      }).success,
    ).toBe(false);
    expect(
      AccountAiStateSchema.safeParse({
        ...STATE,
        balance: { ...STATE.balance, max_tasks_in_flight: 4 },
      }).success,
    ).toBe(false);
  });

  it('the settings route accepts only an explicit choice: credits or own key, never automatic', () => {
    expect(UpdateAiSettingsRequestSchema.parse({ ai_source: 'credits' })).toEqual({
      ai_source: 'credits',
    });
    expect(UpdateAiSettingsRequestSchema.parse({ ai_source: 'own_key' })).toEqual({
      ai_source: 'own_key',
    });
    for (const bad of [null, undefined, 'automatic', 'bundled', '']) {
      expect(UpdateAiSettingsRequestSchema.safeParse({ ai_source: bad }).success, String(bad)).toBe(
        false,
      );
    }
  });

  it('the ledger query takes an entry id as its cursor and defaults to 50 entries', () => {
    expect(AiLedgerQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(AiLedgerQuerySchema.parse({ limit: '10', cursor: '123456789' })).toEqual({
      limit: 10,
      cursor: '123456789',
    });
    for (const cursor of ['0', '-1', 'abc', '1'.repeat(20), '', '01']) {
      expect(AiLedgerQuerySchema.safeParse({ cursor }).success, cursor).toBe(false);
    }
    expect(AiLedgerQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('a ledger cursor the database id cannot hold is refused here, not by a database error', () => {
    // credit_ledger.id is a bigint identity, at most 9,223,372,036,854,775,807.
    // A 19-digit cursor above that passed this schema and would reach Postgres,
    // which refuses it (22003, out of range for type bigint) — a 500 for a
    // request that should have been a 400.
    for (const cursor of ['9223372036854775808', '9'.repeat(19), '1'.repeat(19)]) {
      expect(AiLedgerQuerySchema.safeParse({ cursor }).success, cursor).toBe(false);
    }
    // The largest accepted cursor is well inside the column's range.
    expect(AiLedgerQuerySchema.safeParse({ cursor: '9'.repeat(18) }).success).toBe(true);
    // Every entry id the API emits is a cursor the query accepts.
    const entry = {
      id: '9'.repeat(18),
      kind: 'grant',
      credits: 1,
      balance_after_credits: 1,
      created_at: '2027-01-15T00:00:00Z',
      expires_at: null,
      task: null,
    };
    expect(AiLedgerEntrySchema.safeParse(entry).success).toBe(true);
    expect(AiLedgerEntrySchema.safeParse({ ...entry, id: '1'.repeat(19) }).success).toBe(false);
  });

  it('a ledger page parses, with signed movements and task context', () => {
    const page = {
      data: [
        {
          id: '42',
          kind: 'task_charge',
          credits: -1.42,
          balance_after_credits: 4_998.58,
          created_at: '2027-01-16T09:00:00Z',
          expires_at: null,
          task: { agent_session_id: 'as_123', model: 'claude-sonnet-5', rate_card_version: 1 },
        },
        {
          id: '41',
          kind: 'grant',
          credits: 5_000,
          balance_after_credits: 5_000,
          created_at: '2027-01-15T00:00:00Z',
          expires_at: '2027-02-15T00:00:00Z',
          task: null,
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    expect(AiLedgerPageSchema.parse(page)).toEqual(page);
    for (const kind of [
      'grant',
      'task_charge',
      'refund',
      'top_up',
      'expiry',
      'adjustment',
      'debt',
    ]) {
      expect(AiLedgerEntrySchema.safeParse({ ...page.data[1], kind }).success, kind).toBe(true);
    }
  });

  it('the model catalogue carries card prices for models on credits and none for own-key-only models', () => {
    const sonnet = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
    const catalogue = {
      data: [
        {
          id: 'claude-sonnet-5',
          label: 'Claude Sonnet 5',
          runs_on: ['credits', 'own_key'],
          on_credits_reason: null,
          available_on_your_plan: true,
          min_credits_to_start: chargeCreditsForDisplay(sonnet.minStartMicro),
          max_credits_per_task: chargeCreditsForDisplay(sonnet.maxReserveMicro),
          credits_per_1k: {
            input: creditsPer1kTokens(sonnet.inputMicroPerToken),
            output: creditsPer1kTokens(sonnet.outputMicroPerToken),
            cache_read: creditsPer1kTokens(sonnet.cacheReadMicroPerToken),
            cache_write_5m: creditsPer1kTokens(sonnet.cacheWrite5mMicroPerToken),
            cache_write_1h: creditsPer1kTokens(sonnet.cacheWrite1hMicroPerToken),
          },
          next: null,
        },
        {
          id: 'claude-opus-5',
          label: 'Claude Opus 5',
          runs_on: ['own_key'],
          on_credits_reason: 'own_key_only',
          available_on_your_plan: false,
          min_credits_to_start: null,
          max_credits_per_task: null,
          credits_per_1k: null,
          next: null,
        },
      ],
    };
    expect(AiModelCatalogueResponseSchema.parse(catalogue)).toEqual(catalogue);
    const noSource = { ...catalogue.data[1], runs_on: [] };
    expect(AiModelCatalogueResponseSchema.safeParse({ data: [noSource] }).success).toBe(false);
  });

  it('the credits-exhausted problem carries its reason and the numbers a client needs to explain it', () => {
    for (const reason of ['balance', 'debt', 'task_too_large']) {
      expect(
        AiCreditsExhaustedExtensionsSchema.safeParse({
          reason,
          available_credits: 2.5,
          required_credits: 6,
          debt_credits: reason === 'debt' ? 12.345 : 0,
          debt_reason: reason === 'debt' ? 'payment_reversed' : null,
          resets_at: '2027-02-15T00:00:00Z',
        }).success,
        reason,
      ).toBe(true);
    }
  });

  it("a turn's credits usage names its source and, on credits, the card it was priced on", () => {
    expect(
      TurnCreditsUsageSchema.safeParse({
        source: 'credits',
        reserved: 60,
        charged: 1.42,
        rate_card_version: 1,
      }).success,
    ).toBe(true);
    expect(
      TurnCreditsUsageSchema.safeParse({
        source: 'own_key',
        reserved: 0,
        charged: 0,
        rate_card_version: null,
      }).success,
    ).toBe(true);
  });
});
