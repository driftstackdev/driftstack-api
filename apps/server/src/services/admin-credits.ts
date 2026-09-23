// S15 — admin tools: contract credits (plan override), goodwill grants and
// debt forgiveness, and rate-card publishing.
//
// PURE composition only, same discipline as `services/ai-account-state.ts`:
// every fact these functions need is read by the ROUTE first
// (`routes/admin-ai-credits.ts`), which owns every database call, the account
// lock and the audit write. This file only shapes what the route already has
// into the published response, or decides a policy question with no clock and
// no I/O, so it is testable without a database.
//
// The rate-card DERIVATION itself (which models, at what markup) stays in
// `credit-rate-card-publisher.ts` (`deriveRateCardRows`, `candidateRateCardModels`)
// — this file composes those into the shapes the admin route sends and reads,
// and adds the one thing that lives above both: turning a refusal list into an
// HTTP-shaped answer, and turning a card's dates into its lifecycle status.
//
// ROUNDING, the customer view's rule (`ai-account-state.ts`): what an account
// HAS rounds DOWN; what it OWES, and what a forgiveness wiped out, rounds UP
// (`chargeCreditsForDisplay`). Rounded down, 500 µcr of debt read
// `debt_credits: 0` beside a debt reason, and forgiving it read
// `forgiven_credits: 0` (S13–S16 re-audit #6).

import {
  balanceCreditsForDisplay,
  chargeCreditsForDisplay,
  type AdminCreditAdjustmentResponse,
  type AdminCreditLotView,
  type AdminCreditsAccountState,
  type AdminPlanOverrideView,
  type AdminRateCardStatus,
  type AdminRateCardView,
  type AiBilling,
  type AiDebtReason,
  type AiLedgerEntry,
  type AiSource,
  type AiSourceSetBy,
} from '@driftstack/api-types';
import type { RateCardDraftRefusal } from './credit-rate-card-publisher.js';
import type { CreditLotRecord } from '../db/credit-ledger-repo.js';
import type { CreditPlanOverrideRecord } from '../db/credit-plan-overrides-repo.js';
import type { CreditRateCardRecord } from '../db/credit-rate-card-repo.js';

/** A timestamp as any of the shapes the repos hand back — mirrors
 *  `ai-account-state.ts`'s private `WireInstant`, not exported from there. */
type WireInstant = Date | string;

function isoOf(value: WireInstant): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function isoOfNullable(value: WireInstant | null): string | null {
  return value === null ? null : isoOf(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/admin/accounts/:id/credits
// ─────────────────────────────────────────────────────────────────────────────

export function buildAdminCreditLotView(lot: CreditLotRecord): AdminCreditLotView {
  return {
    id: lot.id,
    kind: lot.kind,
    granted_credits: balanceCreditsForDisplay(lot.grantedMicro),
    remaining_credits: balanceCreditsForDisplay(lot.remainingMicro),
    // Held credit rounds UP, as on the customer view: 500 µcr held is 0.001
    // unavailable, never "nothing held" beside a lot that cannot be spent.
    held_credits: chargeCreditsForDisplay(lot.heldMicro),
    starts_at: isoOf(lot.startsAt),
    expires_at: isoOf(lot.expiresAt),
  };
}

/** Exported for `PUT`/`DELETE .../ai-plan-override`, which answer with one
 *  override view directly — not only nested under `GET .../credits`. */
export function buildPlanOverrideView(override: CreditPlanOverrideRecord): AdminPlanOverrideView {
  return {
    monthly_credits: override.monthlyCredits,
    reason: override.reason,
    own_key_allowed: override.ownKeyAllowed,
    anchor_at: isoOf(override.anchorAt),
    ends_at: isoOfNullable(override.endsAt),
    effective_since: isoOf(override.effectiveSince),
    note: override.note,
  };
}

export interface AdminCreditsStateInputs {
  /** The `acc_<uuid>` id as the route received it, echoed back unchanged. */
  readonly publicAccountId: string;
  readonly billingMode: AiBilling;
  readonly aiSource: AiSource | null;
  readonly aiSourceSetBy: AiSourceSetBy | null;
  readonly aiSourceSetAt: Date | null;
  readonly currentWindow: {
    readonly windowStart: WireInstant;
    readonly windowEnd: WireInstant;
  } | null;
  /** The current window's monthly lot (if any) plus every other live lot —
   *  the route's own concatenation, in either order. */
  readonly lots: readonly CreditLotRecord[];
  readonly availableMicro: number;
  readonly debtMicro: number;
  /** The newest debt reason on file. Shown only while `debtMicro > 0`, same
   *  rule `ai-account-state.ts` uses for the customer-facing read. */
  readonly debtReason: AiDebtReason | null;
  readonly reservationsInFlight: number;
  readonly planOverride: CreditPlanOverrideRecord | null;
  /** Newest first, already built (`ai-account-state.ts`'s `buildLedgerEntry`),
   *  at most 20. */
  readonly ledger: readonly AiLedgerEntry[];
}

/** `GET /v1/admin/accounts/:id/credits`. */
export function buildAdminCreditsAccountState(
  args: AdminCreditsStateInputs,
): AdminCreditsAccountState {
  return {
    account_id: args.publicAccountId,
    billing: args.billingMode,
    ai_source: args.aiSource,
    ai_source_set_by: args.aiSourceSetBy,
    ai_source_set_at: isoOfNullable(args.aiSourceSetAt),
    current_window:
      args.currentWindow === null
        ? null
        : {
            window_start: isoOf(args.currentWindow.windowStart),
            window_end: isoOf(args.currentWindow.windowEnd),
          },
    lots: args.lots.map(buildAdminCreditLotView),
    available_credits: balanceCreditsForDisplay(args.availableMicro),
    debt_credits: chargeCreditsForDisplay(args.debtMicro),
    debt_reason: args.debtMicro > 0 ? args.debtReason : null,
    reservations_in_flight: Math.max(0, args.reservationsInFlight),
    plan_override: args.planOverride === null ? null : buildPlanOverrideView(args.planOverride),
    ledger: [...args.ledger],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/admin/accounts/:id/credits/adjustments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A goodwill lot's `grant_key` (globally unique — `credit-ledger-repo.ts`'s
 * `insertLot` dedups on it alone, with no account column) is the client's
 * `idempotency_key` namespaced by account, so two different admins granting
 * goodwill to two different accounts on the same literal key never collide.
 * The LEDGER row's own key stays the raw `idempotency_key`: `append` scopes
 * that one by `(account_id, idempotency_key)` already.
 */
export function goodwillGrantKey(accountId: string, idempotencyKey: string): string {
  return `admin_goodwill:${accountId}:${idempotencyKey}`;
}

export function buildGoodwillAdjustmentResponse(args: {
  readonly applied: boolean;
  readonly lot: CreditLotRecord;
  readonly debtMicro: number;
}): AdminCreditAdjustmentResponse {
  return {
    applied: args.applied,
    kind: 'goodwill',
    lot: buildAdminCreditLotView(args.lot),
    forgiven_credits: null,
    debt_credits: chargeCreditsForDisplay(args.debtMicro),
  };
}

export function buildForgiveDebtAdjustmentResponse(args: {
  readonly applied: boolean;
  readonly forgivenMicro: number;
  readonly debtMicro: number;
}): AdminCreditAdjustmentResponse {
  return {
    applied: args.applied,
    kind: 'forgive_debt',
    lot: null,
    forgiven_credits: chargeCreditsForDisplay(args.forgivenMicro),
    debt_credits: chargeCreditsForDisplay(args.debtMicro),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/admin/credit-rate-cards — turning a refusal list into an HTTP answer
// ─────────────────────────────────────────────────────────────────────────────

export interface RateCardRefusalClassification {
  /** `own_key_only` is a 403 (the model named is forbidden by policy, not by a
   *  bad request); every other reason is a 400 (the request itself is wrong —
   *  an out-of-range markup, a price that will not divide evenly). A card that
   *  fails both ways reports as 403: the policy refusal is the one an owner
   *  cannot fix by resubmitting the same markup with different numbers. */
  readonly status: 403 | 400;
  readonly detail: string;
}

function refusalSentence(r: RateCardDraftRefusal): string {
  switch (r.reason) {
    case 'no_models':
      return 'no models are eligible to be priced';
    case 'markup_out_of_range':
      return `markup_bp ${String(r.markupBp)} is out of range`;
    case 'duplicate_model':
      return `${r.model} is listed twice`;
    case 'unpriced':
      return `${r.model} has no positive list price`;
    case 'price_not_whole':
      return `${r.model} ${r.field} does not divide into a whole microcredit at this markup`;
    case 'rate_order':
      return `${r.model} prices break the cache-rate order`;
    case 'reserve_bounds':
      return `${r.model} has an invalid start minimum or reserve maximum`;
    case 'own_key_only':
      return `${r.model} may only run on the customer's own key`;
  }
}

/**
 * `deriveRateCardRows`'s refusal list, as the route answers it. Every refusal
 * is named in `detail`, not only the first, mirroring the publisher's own
 * "every refusal is reported" discipline.
 */
export function classifyRateCardRefusals(
  refusals: readonly RateCardDraftRefusal[],
): RateCardRefusalClassification {
  const ownKeyOnlyModels = refusals
    .filter((r): r is Extract<RateCardDraftRefusal, { reason: 'own_key_only' }> => {
      return r.reason === 'own_key_only';
    })
    .map((r) => r.model)
    .sort();
  const sentences = refusals.map(refusalSentence);
  if (ownKeyOnlyModels.length > 0) {
    return {
      status: 403,
      detail: `Refused: ${sentences.join('; ')}.`,
    };
  }
  return { status: 400, detail: `Refused: ${sentences.join('; ')}.` };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/admin/credit-rate-cards — a card's lifecycle status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A card's status, derived from its own dates and the version currently in
 * force — never stored (`credit_rate_cards` holds no status column; §
 * migration 0127's own comment: "the card in force is the newest card that
 * has taken effect and was not withdrawn").
 *
 *   · `withdrawn`  — `withdrawn_at` is set. Always final; the database
 *     refuses every other change to a card once written (0127's guard trigger).
 *   · `announced`  — not withdrawn, `effective_at` still in the future.
 *   · `in_force`   — not withdrawn, in effect, and IS the card `cardInForce`
 *     names (the newest such card).
 *   · `superseded` — not withdrawn, in effect, but a later card has since
 *     taken its place.
 */
export function rateCardStatus(
  card: Pick<CreditRateCardRecord, 'version' | 'effectiveAt' | 'withdrawnAt'>,
  inForceVersion: number | null,
  now: Date,
): AdminRateCardStatus {
  if (card.withdrawnAt !== null) return 'withdrawn';
  if (card.effectiveAt.getTime() > now.getTime()) return 'announced';
  if (inForceVersion !== null && card.version === inForceVersion) return 'in_force';
  return 'superseded';
}

export function buildAdminRateCardView(
  card: CreditRateCardRecord,
  modelCount: number,
  inForceVersion: number | null,
  now: Date,
): AdminRateCardView {
  return {
    version: card.version,
    markup_bp: card.markupBp,
    status: rateCardStatus(card, inForceVersion, now),
    announced_at: isoOf(card.announcedAt),
    effective_at: isoOf(card.effectiveAt),
    withdrawn_at: isoOfNullable(card.withdrawnAt),
    note: card.note,
    model_count: modelCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/admin/credit-rate-cards — the 30-day notice, answered before the DB
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors `credit_rate_cards_thirty_days_notice` (migration 0127): 720 hours
 *  = 30 × 24, never a calendar "30 days" (which a day interval evaluates in
 *  the session time zone and can be 719 hours across a DST change). */
export const RATE_CARD_NOTICE_HOURS = 720;

/**
 * Whether `effectiveAt` clears the 30-day notice from `announcedAt` (the
 * database's own now() at publish time — the route passes its own clock
 * reading here only to answer with a clean 400 instead of letting the
 * DEFERRED commit-time trigger raise first; the database re-checks this at
 * INSERT and again at COMMIT regardless, so a clock skew between this process
 * and the database can only make this pre-check STRICTER than the database,
 * never looser).
 *
 * Every card an owner publishes through this route is version > 1 (version 1
 * is the migration seed, effective at once, and this route can never produce
 * it), so the notice always applies — there is no version-1 exception to
 * thread through here.
 */
export function clearsNoticeWindow(announcedAt: Date, effectiveAt: Date): boolean {
  return effectiveAt.getTime() >= announcedAt.getTime() + RATE_CARD_NOTICE_HOURS * 60 * 60 * 1000;
}
