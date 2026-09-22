// S15 — the PURE half of the AI-credits admin tools: `candidateRateCardModels`
// (credit-rate-card-publisher.ts) and every composer in services/admin-credits.ts.
// No clock, no database, no HTTP — the integration suite
// (admin-ai-credits-routes.test.ts) proves these wired into the real routes
// against a real database; this file proves the arithmetic and the policy
// decisions on their own, with every input named.

import { describe, expect, it } from 'vitest';
import {
  AI_CREDITS_MODEL_DECISION,
  CLAUDE_MODELS,
  CLAUDE_MODEL_KEY_POLICY,
  CREDIT_RATE_CARD_V1,
} from '@driftstack/api-types';
import {
  candidateRateCardModels,
  type RateCardDraftRefusal,
  type RateCardSources,
} from '../../src/services/credit-rate-card-publisher.js';
import {
  buildAdminCreditsAccountState,
  buildAdminCreditLotView,
  buildAdminRateCardView,
  buildForgiveDebtAdjustmentResponse,
  buildGoodwillAdjustmentResponse,
  classifyRateCardRefusals,
  clearsNoticeWindow,
  goodwillGrantKey,
  rateCardStatus,
  RATE_CARD_NOTICE_HOURS,
} from '../../src/services/admin-credits.js';
import type { CreditLotRecord } from '../../src/db/credit-ledger-repo.js';
import type { CreditRateCardRecord } from '../../src/db/credit-rate-card-repo.js';

const MICRO = 1_000_000;

describe('candidateRateCardModels', () => {
  it('scales every on-credits model’s bounds off Sonnet 5’s 6/60 by output-price ratio, matching CREDIT_RATE_CARD_V1 exactly', () => {
    const terms = candidateRateCardModels();
    const byModel = new Map(terms.map((t) => [t.model, t]));
    for (const [model, row] of Object.entries(CREDIT_RATE_CARD_V1.models)) {
      const t = byModel.get(model);
      expect(t, `${model} is a candidate`).toBeDefined();
      expect(t?.minStartMicro, `${model} min start`).toBe(row.minStartMicro);
      expect(t?.maxReserveMicro, `${model} max reserve`).toBe(row.maxReserveMicro);
    }
  });

  it('CRITICAL never offers an Opus-class or own-key-only model — the publish path would refuse itself forever otherwise', () => {
    const terms = candidateRateCardModels();
    expect(
      terms.some((t) => /opus/i.test(t.model)),
      'no Opus id is a candidate',
    ).toBe(false);
  });

  it('is deterministic — the same registry produces the same model list in the same order twice', () => {
    expect(candidateRateCardModels()).toEqual(candidateRateCardModels());
  });

  it('excludes a model whose key policy is own_key_only, even when its decision says on_credits — a normally-creditable model turned own-key-only by an injected override, not a real Opus id (real production sources never do this; only a test can)', () => {
    const sources: RateCardSources = {
      registry: CLAUDE_MODELS,
      keyPolicy: { ...CLAUDE_MODEL_KEY_POLICY, 'claude-sonnet-4-6': 'own_key_only' },
      decisions: AI_CREDITS_MODEL_DECISION,
    };
    const terms = candidateRateCardModels(sources);
    expect(terms.map((t) => t.model)).not.toContain('claude-sonnet-4-6');
    expect(terms.map((t) => t.model)).toContain('claude-sonnet-5');
  });
});

describe('buildAdminCreditLotView / buildAdminCreditsAccountState', () => {
  const lot: CreditLotRecord = {
    id: 'lot-1',
    accountId: 'acc-1',
    kind: 'adjustment',
    spendRank: 1,
    windowId: null,
    grantKey: 'k',
    grantedMicro: 25 * MICRO,
    remainingMicro: 25 * MICRO,
    heldMicro: 0,
    startsAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-02-01T00:00:00Z'),
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('converts a lot to credits, not microcredits, and keeps the kind', () => {
    const view = buildAdminCreditLotView(lot);
    expect(view).toEqual({
      id: 'lot-1',
      kind: 'adjustment',
      granted_credits: 25,
      remaining_credits: 25,
      held_credits: 0,
      starts_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-02-01T00:00:00.000Z',
    });
  });

  it('shows debt_reason only while debt_credits > 0 — the newest reason stays on file forever and must not outlive the debt it explains', () => {
    const base = {
      publicAccountId: 'acc_1',
      billingMode: 'credits' as const,
      aiSource: null,
      aiSourceSetBy: null,
      aiSourceSetAt: null,
      currentWindow: null,
      lots: [] as CreditLotRecord[],
      availableMicro: 0,
      reservationsInFlight: 0,
      planOverride: null,
      ledger: [],
    };
    const withDebt = buildAdminCreditsAccountState({
      ...base,
      debtMicro: 5 * MICRO,
      debtReason: 'payment_reversed',
    });
    expect(withDebt.debt_reason).toBe('payment_reversed');

    const noDebt = buildAdminCreditsAccountState({
      ...base,
      debtMicro: 0,
      debtReason: 'payment_reversed',
    });
    expect(noDebt.debt_reason, 'a stale reason from before repayment is not shown').toBeNull();
  });
});

describe('goodwillGrantKey', () => {
  it('namespaces the idempotency key by account, so two accounts using the same literal key never collide on the globally-unique grant_key column', () => {
    const a = goodwillGrantKey('acc-a', 'promo-2026-09');
    const b = goodwillGrantKey('acc-b', 'promo-2026-09');
    expect(a).not.toBe(b);
    expect(a).toBe('admin_goodwill:acc-a:promo-2026-09');
  });
});

describe('buildGoodwillAdjustmentResponse / buildForgiveDebtAdjustmentResponse', () => {
  const lot: CreditLotRecord = {
    id: 'lot-2',
    accountId: 'acc-1',
    kind: 'adjustment',
    spendRank: 1,
    windowId: null,
    grantKey: 'k',
    grantedMicro: 10 * MICRO,
    remainingMicro: 4 * MICRO,
    heldMicro: 0,
    startsAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-02-01T00:00:00Z'),
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('a goodwill response names the lot and carries no forgiven_credits', () => {
    const r = buildGoodwillAdjustmentResponse({ applied: true, lot, debtMicro: 0 });
    expect(r.kind).toBe('goodwill');
    expect(r.lot?.remaining_credits).toBe(4);
    expect(r.forgiven_credits).toBeNull();
    expect(r.applied).toBe(true);
  });

  it('a forgive-debt response names forgiven_credits and carries no lot', () => {
    const r = buildForgiveDebtAdjustmentResponse({
      applied: true,
      forgivenMicro: 5 * MICRO,
      debtMicro: 0,
    });
    expect(r.kind).toBe('forgive_debt');
    expect(r.lot).toBeNull();
    expect(r.forgiven_credits).toBe(5);
    expect(r.debt_credits).toBe(0);
  });
});

describe('classifyRateCardRefusals', () => {
  it('CRITICAL an own_key_only refusal is 403, even mixed with other refusals — the policy refusal is the one the caller cannot fix by resubmitting different numbers', () => {
    const refusals: RateCardDraftRefusal[] = [
      { reason: 'own_key_only', model: 'claude-opus-5' },
      { reason: 'markup_out_of_range', markupBp: 5 },
    ];
    const c = classifyRateCardRefusals(refusals);
    expect(c.status).toBe(403);
    expect(c.detail).toContain('claude-opus-5');
  });

  it('every other refusal reason is 400', () => {
    const refusals: RateCardDraftRefusal[] = [{ reason: 'no_models' }];
    expect(classifyRateCardRefusals(refusals).status).toBe(400);
  });
});

describe('rateCardStatus / buildAdminRateCardView', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const base: Pick<CreditRateCardRecord, 'version' | 'effectiveAt' | 'withdrawnAt'> = {
    version: 2,
    effectiveAt: new Date('2026-05-01T00:00:00Z'),
    withdrawnAt: null,
  };

  it('withdrawn beats everything else', () => {
    expect(rateCardStatus({ ...base, withdrawnAt: now }, 2, now)).toBe('withdrawn');
  });

  it('announced when effective_at is still in the future, whatever is in force', () => {
    expect(rateCardStatus({ ...base, effectiveAt: new Date('2026-07-01T00:00:00Z') }, 1, now)).toBe(
      'announced',
    );
  });

  it('in_force when it is the card cardInForce names', () => {
    expect(rateCardStatus(base, 2, now)).toBe('in_force');
  });

  it('superseded when it has taken effect but a later card is now in force', () => {
    expect(rateCardStatus(base, 3, now)).toBe('superseded');
  });

  it('buildAdminRateCardView carries the model_count through unchanged', () => {
    const card: CreditRateCardRecord = {
      version: 2,
      markupBp: 20000,
      announcedAt: new Date('2026-04-01T00:00:00Z'),
      effectiveAt: base.effectiveAt,
      withdrawnAt: null,
      createdByKeyId: null,
      note: '',
    };
    const view = buildAdminRateCardView(card, 3, 2, now);
    expect(view.model_count).toBe(3);
    expect(view.status).toBe('in_force');
  });
});

describe('clearsNoticeWindow', () => {
  const announced = new Date('2026-01-01T00:00:00Z');

  it('CRITICAL exactly 720 hours clears the notice — the boundary is inclusive, matching credit_rate_cards_thirty_days_notice', () => {
    const effective = new Date(announced.getTime() + RATE_CARD_NOTICE_HOURS * 60 * 60 * 1000);
    expect(clearsNoticeWindow(announced, effective)).toBe(true);
  });

  it('CRITICAL one millisecond short of 720 hours refuses', () => {
    const effective = new Date(announced.getTime() + RATE_CARD_NOTICE_HOURS * 60 * 60 * 1000 - 1);
    expect(clearsNoticeWindow(announced, effective)).toBe(false);
  });

  it('well past the notice window clears', () => {
    const effective = new Date(announced.getTime() + 40 * 24 * 60 * 60 * 1000);
    expect(clearsNoticeWindow(announced, effective)).toBe(true);
  });
});
