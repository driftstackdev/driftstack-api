// S14 — pure composition for the Phase-2-facing read/settings API
// (`GET /v1/account/me/ai`, `GET /v1/account/me/ai/ledger`, `GET /v1/ai/models`).
//
// ⛔ PURE, same discipline as `services/ai-source.ts` and `services/bundled-llm.ts`'s
// S13 half: every fact these functions need — the plan entitlement, the
// account's stored `ai_source`, the current window, its monthly lot, the
// account's other live lots, its balances, the rate card in force — is read by
// the ROUTE first. This file only shapes what the route already has into the
// published response, so blocked-reason derivation, the ledger's kind mapping
// and the amount conversions can all be tested without a database, a request
// or a clock.
//
// ⛔ `effective_source`/`blocked_reason` REUSE `decideAiSource` (S12,
// `services/ai-source.ts`), not a second arbiter. That function is the one a
// real turn is decided by (§4.3); computing the SAME account's answer a
// different way here would let this endpoint tell a customer one thing while
// their next turn does another — exactly the drift H3 warns about for
// `ai_source`. `headerKeyPresent` is always `false` here: there is no
// per-request header on a GET, so rule 2's `own_key_not_on_plan` refusal
// cannot arise from this call site (asserted in a unit test, not just assumed).

import {
  AgentModelSchema,
  agentModelListPrice,
  AI_CREDITS_MODEL_DECISION,
  aiSourcesAllowedOnPlan,
  balanceCreditsForDisplay,
  chargeCreditsForDisplay,
  CREDIT_LOT_EXTRA_KIND,
  creditsPer1kTokens,
  MAX_AI_TASKS_IN_FLIGHT,
  type AccountAiState,
  type AccountTier,
  type AgentModel,
  type AiBlockedReason,
  type AiCreditsModelDecision,
  type AiDebtReason,
  type AiLedgerEntry,
  type AiLedgerEntryKind,
  type AiModelCatalogueEntry,
  type AiModelOffCreditsReason,
  type AiSource,
  type AiSourceSetBy,
  type CreditLotKind,
} from '@driftstack/api-types';
import { aiEntitlementFor, aiIncludedForTier, ownKeyAllowedForTier } from './ai-entitlements.js';
import { decideAiSource } from './ai-source.js';
import type { CreditLedgerKind } from '../db/credit-ledger-repo.js';

/** A timestamp as any of the shapes the repos hand back: a `Date`, or a
 *  microsecond-precision `PgInstant` string already fit to print. */
type WireInstant = Date | string;

function isoOf(value: WireInstant): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function isoOfNullable(value: WireInstant | null): string | null {
  return value === null ? null : isoOf(value);
}

/**
 * A stored `credit_ledger.model` value as the ledger's `task.model`, or null
 * when it is no longer in `AgentModelSchema`.
 *
 * ⛔ NULL, NOT A THROW AND NOT THE RAW STRING (S14 audit #11). The column is
 * plain text and history never changes, so a model later retired from the enum
 * stays on every charge it ever made: parsing it strictly turned each page
 * holding one of those charges into a 500, forever. Echoing the raw string
 * would need the published field widened from the model enum to any string;
 * null is the fallback the schema admits without that (`task.model` is
 * `AgentModelSchema.nullable()`), and the entry's credits, session and rate
 * card still say what the task cost.
 */
function agentModelOrNull(model: string): AgentModel | null {
  const parsed = AgentModelSchema.safeParse(model);
  return parsed.success ? parsed.data : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// effective_source / blocked_reason — one arbiter, reused
// ─────────────────────────────────────────────────────────────────────────────

export interface DeriveAiStateInputs {
  readonly aiIncluded: boolean;
  readonly ownKeyAllowed: boolean;
  /** `credit_accounts.ai_source`. Null means automatic. */
  readonly aiSource: AiSource | null;
  /** The stored own-key's usability, from `BYOKAnthropicService.getUsabilityFacts`. */
  readonly ownKeyUsable: boolean;
  readonly debtMicro: number;
  readonly tasksInFlight: number;
  readonly availableMicro: number;
  /**
   * The SMALLEST minimum to start among the models the account can run on
   * credits right now — every model the deployment's key may run that has a
   * row on the card in force, the same two questions `reserve()`'s
   * `priceModel` asks. Below it no task can start; at or above it at least one
   * can. Null when the card prices none of them, so every credits task would
   * be refused.
   */
  readonly minStartMicro: number | null;
}

export interface DerivedAiState {
  readonly effectiveSource: AiSource | null;
  readonly blockedReason: AiBlockedReason | null;
}

/**
 * `reserve()`'s refusals, in the order `CreditReservationsService.reserveEnforce`
 * (services/credit-reservations.ts) asks them — the model, the task cap, debt,
 * then the balance against the model's minimum to start.
 *
 * ⛔ A MIRROR, NOT AN IMPORT. That file expresses its order only as the
 * `CreditReserveRefusal` type and the sequence of its `if`s, and it is not this
 * slice's to change. So the order is written again here, `deriveAiState` walks
 * THIS array, and
 * the-ai-state-blocks-in-the-order-reserve-refuses-at-the-cheapest-models-minimum.test.ts
 * reads both files and fails the moment the two stop agreeing. (S14 audit #4:
 * this GET used to ask debt before the task cap, so an account in debt with
 * three tasks running read `debt` while `reserve()` answered
 * `tasks_in_flight`.)
 */
export const RESERVE_REFUSAL_ORDER = ['model', 'tasks_in_flight', 'debt', 'balance'] as const;
type ReserveRefusal = (typeof RESERVE_REFUSAL_ORDER)[number];

/**
 * Each of `reserve()`'s refusals as the account-level `blocked_reason` it reads
 * as, or null when that check passes.
 *
 * `model` — `reserve()` asks it per MODEL, and this GET is not per-model, so its
 * only account-level form is "the card prices no model the account can run":
 * then every credits task is refused. The published vocabulary has no reason for
 * that, and `no_credits` ("nothing can start on credits right now") is the
 * nearest honest one; answering null would say a task could start when none can.
 *
 * `balance` — `reserve()` refuses `available < min_start` for the model asked
 * for; against the CHEAPEST runnable model's minimum, "blocked" here means no
 * model at all could start, never merely the one the customer might pick.
 */
const CREDITS_CHECKS: Readonly<
  Record<ReserveRefusal, (args: DeriveAiStateInputs) => AiBlockedReason | null>
> = {
  model: (args) => (args.minStartMicro === null ? 'no_credits' : null),
  tasks_in_flight: (args) =>
    args.tasksInFlight >= MAX_AI_TASKS_IN_FLIGHT ? 'tasks_in_flight' : null,
  debt: (args) => (args.debtMicro > 0 ? 'debt' : null),
  balance: (args) =>
    args.minStartMicro !== null && args.availableMicro < args.minStartMicro ? 'no_credits' : null,
};

/**
 * `effective_source` and `blocked_reason`, in one pass so the two can never
 * disagree about which source is being evaluated.
 *
 * Order, and why: `decideAiSource` first rules out the two refusals a task
 * cannot get past regardless of balance (no AI on the plan at all; an
 * explicit own-key choice with nothing usable to spend). Only once a task
 * WOULD run on credits do `reserve()`'s own checks get to block it, in
 * `reserve()`'s own order ({@link RESERVE_REFUSAL_ORDER}) — an own-key-funded
 * task costs this account nothing on the credits ledger, so none of them ever
 * block one (§2, §4.3 rule 3).
 */
export function deriveAiState(args: DeriveAiStateInputs): DerivedAiState {
  const decision = decideAiSource({
    entitlement: { aiIncluded: args.aiIncluded, ownKeyAllowed: args.ownKeyAllowed },
    aiSource: args.aiSource,
    headerKeyPresent: false,
    storedKeyUsable: args.ownKeyUsable,
  });
  if (decision.outcome === 'refuse') {
    // `own_key_not_on_plan` is rule 2's refusal and rule 2 only fires on a
    // header key, which this call site never sends (see the file header) —
    // so only the other two of `decideAiSource`'s three refusal kinds can
    // reach here. A third branch would be silently unreachable dead code;
    // the exhaustiveness check below is the one that would catch a widened
    // refusal union quietly starting to reach this call site.
    const blockedReason: AiBlockedReason =
      decision.kind === 'ai_not_on_plan'
        ? 'ai_not_on_plan'
        : decision.kind === 'own_key_missing'
          ? 'own_key_missing'
          : unreachableRefusal(decision.kind);
    return { effectiveSource: null, blockedReason };
  }
  if (decision.kind === 'stored_key') {
    return { effectiveSource: 'own_key', blockedReason: null };
  }
  // `decision.kind === 'credits'` is the only case left — `header_key` cannot
  // occur either, for the same reason `own_key_not_on_plan` cannot above.
  for (const check of RESERVE_REFUSAL_ORDER) {
    const blockedReason = CREDITS_CHECKS[check](args);
    if (blockedReason !== null) return { effectiveSource: 'credits', blockedReason };
  }
  return { effectiveSource: 'credits', blockedReason: null };
}

function unreachableRefusal(kind: 'own_key_not_on_plan'): never {
  throw new Error(
    `deriveAiState reached decideAiSource's header-key refusal (${kind}) from a call site that never sends a header key`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/account/me/ai
// ─────────────────────────────────────────────────────────────────────────────

export interface OwnKeyFacts {
  readonly hasKey: boolean;
  readonly usable: boolean;
  readonly setAt: Date | null;
  readonly expiresAt: Date | null;
}

export interface RateCardFacts {
  readonly version: number;
  readonly effectiveAt: WireInstant;
}

export interface MonthlyLotFacts {
  readonly grantedMicro: number;
  readonly remainingMicro: number;
  readonly heldMicro: number;
}

export interface ExtraLotFacts {
  readonly kind: Exclude<CreditLotKind, 'monthly'>;
  readonly remainingMicro: number;
  /** What running tasks hold on this lot — not spendable by a new one. */
  readonly heldMicro: number;
  readonly expiresAt: Date;
}

/** What a lot has left that a NEW task could draw on: remaining minus held,
 *  never below zero. The monthly lot and every extra use this one rule, so
 *  their parts add up to `available_credits` (S14 audit #3). */
function unheldMicro(lot: { readonly remainingMicro: number; readonly heldMicro: number }): number {
  return Math.max(0, lot.remainingMicro - lot.heldMicro);
}

/** The `credit_plan_overrides` facts that decide whether an override is in force. */
export interface PlanOverrideFacts {
  /** Whole credits a month. */
  readonly monthlyCredits: number;
  readonly anchorAt: Date;
  readonly effectiveSince: Date;
  readonly endsAt: Date | null;
}

/**
 * The monthly figure of the account's plan override when one is IN FORCE at
 * `at`, else null — the same predicate the monthly grants read coverage with
 * (`credit-windows-repo.ts`: `anchor_at <= t AND effective_since <= t AND
 * (ends_at IS NULL OR t < ends_at)`), so the plan shows exactly the figure
 * that is being granted. Both reasons count: a `contract` override IS the
 * contract's figure, and an `admin_tier` override IS the figure of the tier an
 * admin assigned (S14 audit #6).
 *
 * A zero-credit override is a real figure (0), not "no override": an admin
 * wrote it on purpose.
 */
export function livePlanOverrideCredits(
  override: PlanOverrideFacts | null,
  at: Date,
): number | null {
  if (override === null) return null;
  const t = at.getTime();
  if (override.anchorAt.getTime() > t || override.effectiveSince.getTime() > t) return null;
  if (override.endsAt !== null && override.endsAt.getTime() <= t) return null;
  return override.monthlyCredits;
}

function ownKeyForWire(facts: OwnKeyFacts): AccountAiState['own_key'] {
  return {
    has_key: facts.hasKey,
    usable: facts.usable,
    set_at: isoOfNullable(facts.setAt),
    expires_at: isoOfNullable(facts.expiresAt),
  };
}

function rateCardForWire(
  inForce: RateCardFacts,
  next: RateCardFacts | null,
): AccountAiState['rate_card'] {
  return {
    version: inForce.version,
    effective_at: isoOf(inForce.effectiveAt),
    next: next === null ? null : { version: next.version, effective_at: isoOf(next.effectiveAt) },
  };
}

/**
 * `plan`. `monthly_included_credits` is a LIVE plan override's figure when
 * there is one (see {@link livePlanOverrideCredits}); otherwise the tier's own
 * figure — null only for a tier whose figure is set per contract (Enterprise)
 * and has none in force.
 */
function planForWire(
  tier: AccountTier,
  planOverrideMonthlyCredits: number | null,
): AccountAiState['plan'] {
  const entitlement = aiEntitlementFor(tier);
  return {
    tier,
    ai_included: entitlement.aiIncluded,
    monthly_included_credits:
      planOverrideMonthlyCredits ??
      (entitlement.monthlyCredits === 'contract' ? null : entitlement.monthlyCredits),
    own_key_allowed: entitlement.ownKeyAllowed,
    allowed_sources: [...aiSourcesAllowedOnPlan(tier)],
  };
}

/**
 * `GET /v1/account/me/ai` for a LEGACY account — including a MOVED account
 * read under `shadow` mode, which §4.1's table treats as legacy for every
 * customer-facing purpose (the same gate `resolveMovedAccount` in
 * `routes/account-bundled-llm.ts` already applies).
 *
 * ⚠️ A DECISION, NOT SOMETHING THE PLAN OR THE DESIGN STATES OUTRIGHT — see
 * the brief item this slice rests on (S14 brief, addition 1). §9.1 gives the
 * MOVED shape in full and is silent on a legacy account's `ai_source`/
 * `balance`/`blocked_reason`; running the credits-account composer unchanged
 * over a legacy account's (mostly empty) credit row would derive
 * `blocked_reason: 'no_credits'` from a balance of zero — true of the
 * NUMBER and false of the ACCOUNT, which is not gated by AI credits at all
 * and runs on the old consent/BYOK system this endpoint does not represent.
 * So a legacy account gets a fixed, honest shape instead: real `plan` and
 * `own_key` facts (both are properties of the account regardless of billing
 * mode), a real `rate_card` (global, not account-scoped), and
 * `blocked_reason: null` / `balance.monthly: null` / every other balance
 * figure at zero — never a reason that names a system the account isn't on.
 */
export function buildLegacyAccountAiState(args: {
  readonly tier: AccountTier;
  readonly ownKey: OwnKeyFacts;
  readonly rateCard: RateCardFacts;
  readonly nextRateCard: RateCardFacts | null;
  /** {@link livePlanOverrideCredits}'s answer for this account. */
  readonly planOverrideMonthlyCredits: number | null;
}): AccountAiState {
  return {
    billing: 'legacy',
    plan: planForWire(args.tier, args.planOverrideMonthlyCredits),
    ai_source: null,
    ai_source_set_by: null,
    effective_source: null,
    own_key: ownKeyForWire(args.ownKey),
    balance: {
      available_credits: 0,
      monthly: null,
      extras: [],
      reserved_in_flight_credits: 0,
      pending_claims_credits: 0,
      debt_credits: 0,
      tasks_in_flight: 0,
      max_tasks_in_flight: MAX_AI_TASKS_IN_FLIGHT,
    },
    blocked_reason: null,
    debt_reason: null,
    auto_top_up: { enabled: false },
    rate_card: rateCardForWire(args.rateCard, args.nextRateCard),
  };
}

export interface AccountAiStateInputs {
  readonly tier: AccountTier;
  readonly aiSource: AiSource | null;
  readonly aiSourceSetBy: AiSourceSetBy | null;
  readonly ownKey: OwnKeyFacts;
  /** Null when the account has no paid coverage right now. */
  readonly currentWindow: {
    readonly windowStart: WireInstant;
    readonly windowEnd: WireInstant;
  } | null;
  /** Null when the window has not been granted its monthly lot yet. */
  readonly monthlyLot: MonthlyLotFacts | null;
  readonly extraLots: readonly ExtraLotFacts[];
  readonly availableMicro: number;
  readonly reservedInFlightMicro: number;
  readonly pendingClaimsMicro: number;
  readonly debtMicro: number;
  /** The newest `debt_incurred` reason on file, whatever the CURRENT debt is.
   *  Shown only while `debtMicro > 0` — see the field's own comment below. */
  readonly debtReason: AiDebtReason | null;
  readonly tasksInFlight: number;
  /** See {@link DeriveAiStateInputs.minStartMicro}. */
  readonly minStartMicro: number | null;
  /** {@link livePlanOverrideCredits}'s answer for this account. */
  readonly planOverrideMonthlyCredits: number | null;
  readonly rateCard: RateCardFacts;
  readonly nextRateCard: RateCardFacts | null;
}

/**
 * `GET /v1/account/me/ai` for an account MOVED onto AI credits (`billing_mode
 * = 'credits'`, and mode `enforce` — see {@link buildLegacyAccountAiState}
 * for every other case).
 *
 * ROUNDING (§9 preamble: charges up, balances down). What the account HAS —
 * `available`, `monthly`, `extras` — rounds DOWN, so it is never shown more
 * than it can spend. What it OWES or has COMMITTED — debt, pending claims,
 * credit a running task holds — rounds UP like a charge, so it is never shown
 * less: rounded down, 500 µcr of debt read `blocked_reason: 'debt'` beside
 * `debt_credits: 0` (S14 audit #2).
 */
export function buildAccountAiState(args: AccountAiStateInputs): AccountAiState {
  const entitlement = aiEntitlementFor(args.tier);
  const { effectiveSource, blockedReason } = deriveAiState({
    aiIncluded: entitlement.aiIncluded,
    ownKeyAllowed: entitlement.ownKeyAllowed,
    aiSource: args.aiSource,
    ownKeyUsable: args.ownKey.usable,
    debtMicro: args.debtMicro,
    tasksInFlight: args.tasksInFlight,
    availableMicro: args.availableMicro,
    minStartMicro: args.minStartMicro,
  });
  const monthly: AccountAiState['balance']['monthly'] =
    args.currentWindow === null || args.monthlyLot === null
      ? null
      : {
          granted_credits: balanceCreditsForDisplay(args.monthlyLot.grantedMicro),
          remaining_credits: balanceCreditsForDisplay(unheldMicro(args.monthlyLot)),
          period_start: isoOf(args.currentWindow.windowStart),
          resets_at: isoOf(args.currentWindow.windowEnd),
        };
  return {
    billing: 'credits',
    plan: planForWire(args.tier, args.planOverrideMonthlyCredits),
    ai_source: args.aiSource,
    ai_source_set_by: args.aiSourceSetBy,
    effective_source: effectiveSource,
    own_key: ownKeyForWire(args.ownKey),
    balance: {
      available_credits: balanceCreditsForDisplay(args.availableMicro),
      monthly,
      extras: args.extraLots.map((lot) => ({
        kind: CREDIT_LOT_EXTRA_KIND[lot.kind],
        remaining_credits: balanceCreditsForDisplay(unheldMicro(lot)),
        expires_at: lot.expiresAt.toISOString(),
      })),
      reserved_in_flight_credits: chargeCreditsForDisplay(args.reservedInFlightMicro),
      pending_claims_credits: chargeCreditsForDisplay(args.pendingClaimsMicro),
      debt_credits: chargeCreditsForDisplay(args.debtMicro),
      tasks_in_flight: Math.max(0, Math.min(args.tasksInFlight, MAX_AI_TASKS_IN_FLIGHT)),
      max_tasks_in_flight: MAX_AI_TASKS_IN_FLIGHT,
    },
    blocked_reason: blockedReason,
    // Shown only while debt is actually outstanding: the newest reason stays
    // on file forever (`latestDebtReason` never resets), and reporting it
    // after the debt is repaid would tell a customer their account is paused
    // for a debt `blocked_reason` no longer names.
    debt_reason: args.debtMicro > 0 ? args.debtReason : null,
    auto_top_up: { enabled: false },
    rate_card: rateCardForWire(args.rateCard, args.nextRateCard),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/ai/models
// ─────────────────────────────────────────────────────────────────────────────

export interface RateCardModelPrices {
  readonly minStartMicro: number;
  readonly maxReserveMicro: number;
  readonly inputMicroPerToken: number;
  readonly outputMicroPerToken: number;
  readonly cacheReadMicroPerToken: number;
  readonly cacheWrite5mMicroPerToken: number;
  readonly cacheWrite1hMicroPerToken: number;
}

/** Credits per 1,000 tokens at each of the five rates — the NON-NULLABLE
 *  shape (both the top-level entry's `credits_per_1k` and its `next`'s are
 *  built from this; only the top-level field is nullable — a model's `next`
 *  block never exists without real prices, see `buildModelCatalogueEntry`). */
function creditsPer1kOf(
  prices: RateCardModelPrices,
): NonNullable<AiModelCatalogueEntry['credits_per_1k']> {
  return {
    input: creditsPer1kTokens(prices.inputMicroPerToken),
    output: creditsPer1kTokens(prices.outputMicroPerToken),
    cache_read: creditsPer1kTokens(prices.cacheReadMicroPerToken),
    cache_write_5m: creditsPer1kTokens(prices.cacheWrite5mMicroPerToken),
    cache_write_1h: creditsPer1kTokens(prices.cacheWrite1hMicroPerToken),
  };
}

export interface ModelCatalogueEntryInputs {
  readonly model: AgentModel;
  readonly tier: AccountTier;
  readonly rateCard: RateCardFacts;
  /** This model's row on the card in force; null when it has none (an
   *  `own_key_only` decision, or an `on_credits` model the card does not
   *  price — the `unpriced` case). */
  readonly pricesInForce: RateCardModelPrices | null;
  readonly nextRateCard: RateCardFacts | null;
  /** This model's row on `nextRateCard`, if any. Ignored when `nextRateCard`
   *  is null. */
  readonly pricesNext: RateCardModelPrices | null;
}

/**
 * One row of `GET /v1/ai/models` — §9.2 plus the design's shape. The decision
 * (`AI_CREDITS_MODEL_DECISION`) says whether a model is EVER priced on
 * credits; whether it is priced on THIS card is a second, independent fact
 * (`pricesInForce`), because a card can omit a model the decision still calls
 * `on_credits` (§9's `unpriced` case) — the two must not be conflated into
 * one boolean or a model dropped from a republished card would silently read
 * as `own_key_only`, the wrong reason.
 */
export function buildModelCatalogueEntry(args: ModelCatalogueEntryInputs): AiModelCatalogueEntry {
  const decision: AiCreditsModelDecision = AI_CREDITS_MODEL_DECISION[args.model];
  const onCreditsNow = decision === 'on_credits' && args.pricesInForce !== null;
  const onCreditsReason: AiModelOffCreditsReason | null = onCreditsNow
    ? null
    : decision === 'own_key_only'
      ? 'own_key_only'
      : 'unpriced';
  const runsOn: readonly AiSource[] = onCreditsNow ? ['credits', 'own_key'] : ['own_key'];
  const aiIncluded = aiIncludedForTier(args.tier);
  const availableOnYourPlan = !aiIncluded
    ? false
    : onCreditsNow
      ? true
      : ownKeyAllowedForTier(args.tier);
  const next =
    args.nextRateCard !== null && args.pricesNext !== null
      ? {
          rate_card_version: args.nextRateCard.version,
          effective_at: isoOf(args.nextRateCard.effectiveAt),
          min_credits_to_start: chargeCreditsForDisplay(args.pricesNext.minStartMicro),
          max_credits_per_task: chargeCreditsForDisplay(args.pricesNext.maxReserveMicro),
          credits_per_1k: creditsPer1kOf(args.pricesNext),
        }
      : null;
  return {
    id: args.model,
    label: agentModelListPrice(args.model)?.label ?? args.model,
    runs_on: [...runsOn],
    on_credits_reason: onCreditsReason,
    available_on_your_plan: availableOnYourPlan,
    min_credits_to_start:
      onCreditsNow && args.pricesInForce !== null
        ? chargeCreditsForDisplay(args.pricesInForce.minStartMicro)
        : null,
    max_credits_per_task:
      onCreditsNow && args.pricesInForce !== null
        ? chargeCreditsForDisplay(args.pricesInForce.maxReserveMicro)
        : null,
    credits_per_1k:
      onCreditsNow && args.pricesInForce !== null ? creditsPer1kOf(args.pricesInForce) : null,
    next,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/account/me/ai/ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The public ledger kind for every internal `CREDIT_LEDGER_KINDS` value — a
 * TOTAL map, `satisfies`-checked against the internal enum, so a new internal
 * kind is a type error here rather than an entry silently falling through to
 * `undefined`.
 *
 * §9.4 — `refund` covers both a clawback's own taking (`proration_clawback`,
 * `refund_clawback`) AND a pending claim's later payment: `payClaims`
 * (`services/credit-reservations.ts`) writes that payment under the SAME
 * internal kind as the clawback that created the claim (`clawbackLedgerKind`),
 * so "a paid pending claim shows as a refund entry" is this mapping applied
 * once, not a second rule.
 */
export const LEDGER_KIND_MAP = {
  grant: 'grant',
  proration_grant: 'grant',
  proration_clawback: 'refund',
  refund_clawback: 'refund',
  task_charge: 'task_charge',
  top_up: 'top_up',
  expiry: 'expiry',
  adjustment: 'adjustment',
  debt_incurred: 'debt',
  debt_repayment: 'debt',
} as const satisfies Record<CreditLedgerKind, AiLedgerEntryKind>;

export function publicLedgerKind(kind: CreditLedgerKind): AiLedgerEntryKind {
  return LEDGER_KIND_MAP[kind];
}

/**
 * A signed ledger movement, in credits at the display precision (§9 preamble):
 * an ARRIVAL (`delta >= 0`) is rounded DOWN in magnitude, same as a balance —
 * never claim more arrived than did; a DEPARTURE (`delta < 0`) is rounded UP
 * in magnitude, same as a charge — never understate what left. Both reuse the
 * ONE pair of conversion helpers in `@driftstack/api-types`
 * (`balanceCreditsForDisplay`/`chargeCreditsForDisplay`); this only picks
 * which one applies from the delta's own sign.
 */
export function signedCreditsForDisplay(deltaMicro: number): number {
  if (deltaMicro >= 0) return balanceCreditsForDisplay(deltaMicro);
  return -chargeCreditsForDisplay(-deltaMicro);
}

export interface LedgerEntryInputs {
  readonly id: string;
  readonly kind: CreditLedgerKind;
  /** `lot_delta_micro − debt_delta_micro` — the same combination the running
   *  balance is built from, so a page's displayed deltas and its
   *  `balance_after_credits` values move together. */
  readonly deltaMicro: number;
  readonly balanceAfterMicro: number;
  readonly createdAt: Date;
  /** The lot's `expires_at`, when this row named a lot AND added credit to
   *  it; null otherwise (see `CreditLedgerRecordWithBalance.lotExpiresAt`'s
   *  own comment). */
  readonly lotExpiresAt: Date | null;
  readonly agentSessionId: string | null;
  readonly model: string | null;
  readonly rateCardVersion: number | null;
}

export function buildLedgerEntry(entry: LedgerEntryInputs): AiLedgerEntry {
  const addedCredit = entry.deltaMicro > 0;
  const task =
    entry.kind === 'task_charge' &&
    entry.agentSessionId !== null &&
    entry.model !== null &&
    entry.rateCardVersion !== null
      ? {
          agent_session_id: entry.agentSessionId,
          // `credit_ledger.model` is a plain text column (§4.4 pins the
          // model at reserve time from `AgentModelSchema`, but the column
          // itself carries no CHECK, and the enum can lose a model later) —
          // see `agentModelOrNull` for why a stranger reads as null.
          model: agentModelOrNull(entry.model),
          rate_card_version: entry.rateCardVersion,
        }
      : null;
  return {
    id: entry.id,
    kind: publicLedgerKind(entry.kind),
    credits: signedCreditsForDisplay(entry.deltaMicro),
    // SIGNED (S14 audit #1): Σ(lot − debt) is negative whenever the account
    // owes more than it holds, and the balance helper refuses a negative —
    // which made every page holding such a row a 500, forever. The signed
    // helper rounds toward minus infinity on both sides of zero: down for a
    // positive balance, as every balance is, and never shows a debt smaller
    // than it is.
    balance_after_credits: signedCreditsForDisplay(entry.balanceAfterMicro),
    created_at: entry.createdAt.toISOString(),
    expires_at: addedCredit ? isoOfNullable(entry.lotExpiresAt) : null,
    task,
  };
}
