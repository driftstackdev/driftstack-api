import { z } from 'zod';
import {
  AccountTierSchema,
  Iso8601Schema,
  PaginatedListSchema,
  type AccountTier,
} from './common.js';
import { AgentModelSchema, type AgentModel, type ModelCallTokens } from './agent-models.js';
import { ChangeTierRequestSchema } from './admin.js';

// ───────────────────────────────────────────────────────────────────────────
// AI credits — the unit, the arithmetic, what each plan includes, and the
// calendar included credits follow.
// ───────────────────────────────────────────────────────────────────────────
//
// Everything in this module is PURE: no clock, no I/O, no environment. The
// database ledger is the authority on every balance; this module is where the
// numbers that ledger is checked against are written down once, so the server,
// the database seed and the clients read the same figures.
//
// ⛔ INTEGERS ONLY. Balances, grants, holds and charges are integer
// MICROCREDITS (1 credit = 1,000,000 µcr = US$0.01). Every rate is a whole
// number of µcr per token, so a charge is tokens × rate with no rounding at all.
// Rounding happens in exactly three places, each in the customer's favour or
// towards a refusal, never towards an overspend:
//   · a grant is floored to whole credits;
//   · a charge shown to a customer is rounded UP to 0.001 credit;
//   · a balance shown to a customer is rounded DOWN to 0.001 credit.
//
// Any product that can pass 2^53 (a level × a duration in microseconds) is
// computed in BigInt and brought back only once it is known to be a safe
// integer; a helper that would have to lose precision throws instead.

/** One credit is one US cent of AI use. */
export const CREDIT_VALUE_USD_CENTS = 1;

/** Stored amounts are integer microcredits: this many make one credit. */
export const MICROCREDITS_PER_CREDIT = 1_000_000;

/** Amounts shown to a customer carry at most this many decimals. */
export const AI_CREDIT_DISPLAY_DECIMALS = 3;

/** Microcredits in one displayed step (0.001 credit). */
const MICRO_PER_DISPLAY_STEP = 1_000;

/** At most this many AI tasks may hold credits at once on one account. */
export const MAX_AI_TASKS_IN_FLIGHT = 3;

/** Bought credits (top-ups) stay spendable for this many months. */
export const TOP_UP_VALIDITY_MONTHS = 12;

/** A new rate card takes effect no sooner than this many days after it is announced. */
export const RATE_CARD_CHANGE_NOTICE_DAYS = 30;

/** Markup is stated in basis points: this many mean 1.0 × list price. */
export const MARKUP_BASIS_POINTS_PER_UNIT = 10_000;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MICRO_BIG = BigInt(MICROCREDITS_PER_CREDIT);

function requireSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${String(value)}`);
  }
}

function requireNonNegativeSafeInteger(name: string, value: number): void {
  requireSafeInteger(name, value);
  if (value < 0) throw new RangeError(`${name} must not be negative, got ${String(value)}`);
}

function toSafeNumber(name: string, value: bigint): number {
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    throw new RangeError(`${name} is beyond exact integer range: ${value.toString()}`);
  }
  return Number(value);
}

/** Freeze a constant table all the way down, so no consumer can edit a price or an allowance. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// ───────────────────────────────────────────────────────────────────────────
// Whole credits ↔ microcredits
// ───────────────────────────────────────────────────────────────────────────

/** Whole credits to microcredits. Fractional credits are refused rather than rounded. */
export function creditsToMicro(credits: number): number {
  requireSafeInteger('credits', credits);
  return toSafeNumber('credits in microcredits', BigInt(credits) * MICRO_BIG);
}

/** Whole credits in a non-negative amount, rounded DOWN (what a grant may give). */
export function microToCreditsFloor(micro: number): number {
  requireNonNegativeSafeInteger('micro', micro);
  return (micro - (micro % MICROCREDITS_PER_CREDIT)) / MICROCREDITS_PER_CREDIT;
}

/** Whole credits in a non-negative amount, rounded UP (what a charge costs in whole credits). */
export function microToCreditsCeil(micro: number): number {
  const down = microToCreditsFloor(micro);
  return micro % MICROCREDITS_PER_CREDIT === 0 ? down : down + 1;
}

/** A non-negative amount floored to whole credits, still in microcredits. Every grant goes through this. */
export function floorMicroToWholeCredits(micro: number): number {
  return microToCreditsFloor(micro) * MICROCREDITS_PER_CREDIT;
}

/** A non-negative amount raised to whole credits, still in microcredits. */
export function ceilMicroToWholeCredits(micro: number): number {
  return creditsToMicro(microToCreditsCeil(micro));
}

function microToDisplay(micro: number, direction: 'up' | 'down'): number {
  requireNonNegativeSafeInteger('micro', micro);
  const remainder = micro % MICRO_PER_DISPLAY_STEP;
  const steps = (micro - remainder) / MICRO_PER_DISPLAY_STEP;
  // `steps` is an integer below 2^53 / 1000, so dividing by 1000 yields the
  // double nearest a decimal with at most three places, and that is the number
  // JSON prints. No float ever takes part in deciding which way to round.
  return (direction === 'up' && remainder > 0 ? steps + 1 : steps) / 1000;
}

/** A charge as the customer sees it: credits, at most 3 decimals, rounded UP. */
export function chargeCreditsForDisplay(micro: number): number {
  return microToDisplay(micro, 'up');
}

/** A balance as the customer sees it: credits, at most 3 decimals, rounded DOWN. */
export function balanceCreditsForDisplay(micro: number): number {
  return microToDisplay(micro, 'down');
}

// ───────────────────────────────────────────────────────────────────────────
// What each plan includes
// ───────────────────────────────────────────────────────────────────────────

/**
 * AI on a plan, for accounts whose AI is funded by credits.
 *
 * ⚠️ `TIER_FEATURES.aiAgent` / `llmBilling` (common.ts) still describe accounts
 * whose AI is NOT yet funded by credits, and the two tables disagree on purpose —
 * Personal has no AI there and included credits here. Neither table is read in
 * place of the other: which one applies is a property of the account, not the tier.
 */
export interface AiPlanEntitlement {
  /** Whether the plan includes AI at all. Without it AI is refused on every source, the customer's own key included. */
  readonly aiIncluded: boolean;
  /** Whether the customer may run AI on their own provider key instead of credits. */
  readonly ownKeyAllowed: boolean;
  /**
   * Credits included each month. `'contract'` where there is no plan-wide number
   * and each account's figure is set by an admin as a contract override — an
   * account without one is given nothing rather than a guessed default.
   */
  readonly monthlyCredits: number | 'contract';
}

/**
 * ⛔ A TOTAL MAP OVER THE TIER ENUM, ON PURPOSE. Adding a tier to
 * `AccountTierSchema` without deciding its AI is a type error here, rather than
 * a tier that silently inherits no AI — or someone else's.
 */
export const AI_PLAN_ENTITLEMENTS: Readonly<Record<AccountTier, AiPlanEntitlement>> = deepFreeze<
  Readonly<Record<AccountTier, AiPlanEntitlement>>
>({
  free: { aiIncluded: false, ownKeyAllowed: false, monthlyCredits: 0 },
  solo_manual: { aiIncluded: true, ownKeyAllowed: false, monthlyCredits: 1_500 },
  team_manual: { aiIncluded: true, ownKeyAllowed: true, monthlyCredits: 5_000 },
  agency_manual: { aiIncluded: true, ownKeyAllowed: true, monthlyCredits: 15_000 },
  api_starter: { aiIncluded: true, ownKeyAllowed: true, monthlyCredits: 3_000 },
  api_builder: { aiIncluded: true, ownKeyAllowed: true, monthlyCredits: 10_000 },
  api_scale: { aiIncluded: true, ownKeyAllowed: true, monthlyCredits: 30_000 },
  enterprise: { aiIncluded: true, ownKeyAllowed: true, monthlyCredits: 'contract' },
});

/**
 * The entitlement row for a tier. An OWN-PROPERTY lookup: a tier read from a
 * database column is typed by a cast, so the type proves nothing about the value,
 * and an unknown tier throws rather than borrowing another tier's allowance.
 */
export function aiEntitlementFor(tier: AccountTier): AiPlanEntitlement {
  if (!Object.prototype.hasOwnProperty.call(AI_PLAN_ENTITLEMENTS, tier)) {
    throw new RangeError(`no AI entitlement is defined for tier ${String(tier)}`);
  }
  return AI_PLAN_ENTITLEMENTS[tier];
}

/**
 * The plan's own monthly allowance in microcredits, or null when the plan has no
 * plan-wide number (`'contract'`) and only an override can supply one.
 */
export function planMonthlyCreditsMicro(tier: AccountTier): number | null {
  const { monthlyCredits } = aiEntitlementFor(tier);
  return monthlyCredits === 'contract' ? null : creditsToMicro(monthlyCredits);
}

// ───────────────────────────────────────────────────────────────────────────
// Which models run on credits, and at what price
// ───────────────────────────────────────────────────────────────────────────

/**
 * Whether a model may run on credits.
 *
 *  · `on_credits` — it has a rate-card row and runs on included or bought credits.
 *  · `own_key_only` — it never runs on credits, only on the customer's own key.
 *    Opus-class models are here by the owner's decision.
 *
 * ⛔ A TOTAL MAP OVER THE MODEL ENUM. Adding a model to `AgentModelSchema`
 * without deciding this is a type error, and the rate card below is typed from
 * this map, so an `on_credits` model with no price does not compile either.
 */
export type AiCreditsModelDecision = 'on_credits' | 'own_key_only';

export const AI_CREDITS_MODEL_DECISION = deepFreeze({
  'claude-opus-5': 'own_key_only',
  'claude-sonnet-5': 'on_credits',
  'claude-opus-4-8': 'own_key_only',
  'claude-opus-4-7': 'own_key_only',
  'claude-sonnet-4-6': 'on_credits',
  'claude-haiku-4-5': 'on_credits',
} as const satisfies Record<AgentModel, AiCreditsModelDecision>);

/** The models the credits rate card prices. */
export type OnCreditsModel = {
  [M in AgentModel]: (typeof AI_CREDITS_MODEL_DECISION)[M] extends 'on_credits' ? M : never;
}[AgentModel];

/** Customer price per token of each kind, in microcredits. */
export interface CreditRates {
  readonly inputMicroPerToken: number;
  readonly outputMicroPerToken: number;
  readonly cacheReadMicroPerToken: number;
  readonly cacheWrite5mMicroPerToken: number;
  readonly cacheWrite1hMicroPerToken: number;
}

/** One model's row on a rate card. */
export interface CreditRateCardModelRow extends CreditRates {
  /** A task may start only with at least this much available. */
  readonly minStartMicro: number;
  /** A task reserves at most this much. */
  readonly maxReserveMicro: number;
  /** Provider list price the row was priced from, in microcents per token (for the record). */
  readonly listInputMicrocentsPerToken: number;
  readonly listOutputMicrocentsPerToken: number;
}

export interface CreditRateCard {
  readonly version: number;
  /** Markup over list price in basis points (20,000 = 2.0 ×). */
  readonly markupBp: number;
  readonly note: string;
  readonly models: Readonly<Record<OnCreditsModel, CreditRateCardModelRow>>;
}

/**
 * Rate card version 1: provider list price × 2.0, effective when it is first
 * written to the database.
 *
 * ⛔ LITERAL NUMBERS, NOT DERIVED FROM `CLAUDE_MODELS`. That registry is the
 * cost-to-serve record and moves when the provider's price moves; what a
 * customer pays moves only by publishing a new card with notice. A card computed
 * from the registry would reprice every customer on the next deploy after a
 * registry edit. A test holds these figures equal to the registry × markup
 * today, so a disagreement is a decision to publish a new card, not drift.
 */
export const CREDIT_RATE_CARD_V1: CreditRateCard = deepFreeze<CreditRateCard>({
  version: 1,
  markupBp: 20_000,
  note: 'Launch card: list price x 2.0',
  models: {
    'claude-sonnet-5': {
      inputMicroPerToken: 400,
      outputMicroPerToken: 2_000,
      cacheReadMicroPerToken: 40,
      cacheWrite5mMicroPerToken: 500,
      cacheWrite1hMicroPerToken: 800,
      minStartMicro: 6_000_000,
      maxReserveMicro: 60_000_000,
      listInputMicrocentsPerToken: 200,
      listOutputMicrocentsPerToken: 1_000,
    },
    'claude-sonnet-4-6': {
      inputMicroPerToken: 600,
      outputMicroPerToken: 3_000,
      cacheReadMicroPerToken: 60,
      cacheWrite5mMicroPerToken: 750,
      cacheWrite1hMicroPerToken: 1_200,
      minStartMicro: 9_000_000,
      maxReserveMicro: 90_000_000,
      listInputMicrocentsPerToken: 300,
      listOutputMicrocentsPerToken: 1_500,
    },
    'claude-haiku-4-5': {
      inputMicroPerToken: 200,
      outputMicroPerToken: 1_000,
      cacheReadMicroPerToken: 20,
      cacheWrite5mMicroPerToken: 250,
      cacheWrite1hMicroPerToken: 400,
      minStartMicro: 3_000_000,
      maxReserveMicro: 30_000_000,
      listInputMicrocentsPerToken: 100,
      listOutputMicrocentsPerToken: 500,
    },
  },
});

/** Credits per 1,000 tokens at a per-token rate, as shown to a customer. */
export function creditsPer1kTokens(microPerToken: number): number {
  requireNonNegativeSafeInteger('microPerToken', microPerToken);
  return chargeCreditsForDisplay(toSafeNumber('rate per 1k', BigInt(microPerToken) * 1_000n));
}

function requireRates(rates: CreditRates): void {
  requireNonNegativeSafeInteger('inputMicroPerToken', rates.inputMicroPerToken);
  requireNonNegativeSafeInteger('outputMicroPerToken', rates.outputMicroPerToken);
  requireNonNegativeSafeInteger('cacheReadMicroPerToken', rates.cacheReadMicroPerToken);
  requireNonNegativeSafeInteger('cacheWrite5mMicroPerToken', rates.cacheWrite5mMicroPerToken);
  requireNonNegativeSafeInteger('cacheWrite1hMicroPerToken', rates.cacheWrite1hMicroPerToken);
}

// ───────────────────────────────────────────────────────────────────────────
// What one model call costs, and the most it can cost
// ───────────────────────────────────────────────────────────────────────────

/**
 * The exact charge for one model call, in microcredits, from the token counts the
 * provider reported. Every kind at its own rate; no rounding anywhere.
 */
export function callChargeMicro(tokens: ModelCallTokens, rates: CreditRates): number {
  requireRates(rates);
  const parts: Array<[string, number, number]> = [
    ['uncachedInput', tokens.uncachedInput, rates.inputMicroPerToken],
    ['output', tokens.output, rates.outputMicroPerToken],
    ['cacheRead', tokens.cacheRead, rates.cacheReadMicroPerToken],
    ['cacheWrite5m', tokens.cacheWrite5m, rates.cacheWrite5mMicroPerToken],
    ['cacheWrite1h', tokens.cacheWrite1h, rates.cacheWrite1hMicroPerToken],
  ];
  let total = 0n;
  for (const [name, count, rate] of parts) {
    requireNonNegativeSafeInteger(`tokens.${name}`, count);
    total += BigInt(count) * BigInt(rate);
  }
  return toSafeNumber('call charge', total);
}

/**
 * Tokens a request may be billed for beyond the text of its JSON body: role
 * markers, block boundaries and the like, which the provider adds and the body
 * does not spell out. Priced at the dearest input rate.
 */
export const REQUEST_FRAMING_TOKENS = 2_048;

/**
 * A serialized request body split at its cache markers.
 *
 *  · `oneHourRegionBytes` — everything up to and including the LAST block that
 *    carries a 1-hour cache marker. The dearest a token here can be billed is
 *    the 1-hour cache-write rate.
 *  · `fiveMinuteRegionBytes` — everything after that, up to and including the
 *    last 5-minute marker. The dearest here is the 5-minute cache-write rate.
 *  · `uncachedRegionBytes` — the rest. Billed at most at the plain input rate.
 *
 * ⛔ "Up to" MEANS IN THE ORDER THE PROVIDER RENDERS THE PROMPT, not the order of
 * the keys in the JSON. The cached prefix is rendered tools → system → messages,
 * and on some models the thinking and effort configuration is rendered ahead of
 * tools and system (so changing it invalidates those caches). Anything rendered
 * ahead of the 1-hour block is written to the cache with it and belongs in the
 * 1-hour region: the tool definitions, and the request's reply controls
 * (`thinking`, `output_config`) unless the provider documents otherwise. Only
 * what is rendered after the last marker may be counted at the plain input rate.
 * Counted this way the bound is conservative; counted by JSON position with the
 * reply controls at the input rate, it is not an upper bound.
 *
 * A request with no markers is all `uncachedRegionBytes`.
 */
export interface RequestRegionBytes {
  readonly oneHourRegionBytes: number;
  readonly fiveMinuteRegionBytes: number;
  readonly uncachedRegionBytes: number;
}

export interface CallUpperBound {
  /** An upper bound on the input tokens: every body byte, plus the framing allowance. */
  readonly inputBoundTokens: number;
  readonly inputBoundMicro: number;
  /** The input bound plus every output token the call may produce. */
  readonly boundMicro: number;
}

/**
 * The most one model call can cost, from the byte counts of its body.
 *
 * ⛔ AN UPPER BOUND, NEVER AN ESTIMATE. It rests on one property of the
 * provider's tokenizer: every input token stands for at least one byte of the
 * UTF-8 text sent, so no region holds more tokens than it has bytes, whatever the
 * language (a character of CJK text is three bytes and at most three tokens).
 * Each region is priced at the dearest rate a token in it can be billed at, the
 * framing allowance at the 1-hour rate, and the output at `maxOutputTokens`. A
 * character count would under-count every multi-byte character; bytes do not.
 *
 * It relies on the rate order read ≤ input ≤ 5-minute write ≤ 1-hour write, and
 * refuses rates that break it: with that order broken, pricing a region at "its"
 * rate would no longer be the dearest it can cost.
 */
export function callUpperBound(
  regions: RequestRegionBytes,
  maxOutputTokens: number,
  rates: CreditRates,
): CallUpperBound {
  requireRates(rates);
  if (
    !(
      rates.cacheReadMicroPerToken <= rates.inputMicroPerToken &&
      rates.inputMicroPerToken <= rates.cacheWrite5mMicroPerToken &&
      rates.cacheWrite5mMicroPerToken <= rates.cacheWrite1hMicroPerToken
    )
  ) {
    throw new RangeError('rates must satisfy read <= input <= 5-minute write <= 1-hour write');
  }
  requireNonNegativeSafeInteger('oneHourRegionBytes', regions.oneHourRegionBytes);
  requireNonNegativeSafeInteger('fiveMinuteRegionBytes', regions.fiveMinuteRegionBytes);
  requireNonNegativeSafeInteger('uncachedRegionBytes', regions.uncachedRegionBytes);
  requireNonNegativeSafeInteger('maxOutputTokens', maxOutputTokens);
  if (maxOutputTokens === 0) throw new RangeError('maxOutputTokens must be at least 1');

  const inputMicro =
    BigInt(regions.oneHourRegionBytes) * BigInt(rates.cacheWrite1hMicroPerToken) +
    BigInt(regions.fiveMinuteRegionBytes) * BigInt(rates.cacheWrite5mMicroPerToken) +
    BigInt(regions.uncachedRegionBytes) * BigInt(rates.inputMicroPerToken) +
    BigInt(REQUEST_FRAMING_TOKENS) * BigInt(rates.cacheWrite1hMicroPerToken);
  const inputTokens =
    BigInt(regions.oneHourRegionBytes) +
    BigInt(regions.fiveMinuteRegionBytes) +
    BigInt(regions.uncachedRegionBytes) +
    BigInt(REQUEST_FRAMING_TOKENS);
  const outputMicro = BigInt(maxOutputTokens) * BigInt(rates.outputMicroPerToken);
  return {
    inputBoundTokens: toSafeNumber('input bound tokens', inputTokens),
    inputBoundMicro: toSafeNumber('input bound', inputMicro),
    boundMicro: toSafeNumber('call bound', inputMicro + outputMicro),
  };
}

/**
 * The largest output ceiling whose bound still fits in `roomMicro`, given the
 * input bound already priced: floor((room − input) / output rate), or 0 when the
 * input alone does not fit.
 */
export function maxOutputTokensWithin(
  roomMicro: number,
  inputBoundMicro: number,
  rates: CreditRates,
): number {
  requireSafeInteger('roomMicro', roomMicro);
  requireNonNegativeSafeInteger('inputBoundMicro', inputBoundMicro);
  requireRates(rates);
  if (rates.outputMicroPerToken === 0) throw new RangeError('outputMicroPerToken must be positive');
  const spare = roomMicro - inputBoundMicro;
  if (spare <= 0) return 0;
  // Integer division without a float: `%` is exact on safe integers.
  return (spare - (spare % rates.outputMicroPerToken)) / rates.outputMicroPerToken;
}

/**
 * The UTF-8 length of a string in bytes, as it goes on the wire.
 *
 * Counted from UTF-16 code units without any platform encoder, so browsers and
 * the server agree: a surrogate pair is 4 bytes, and a lone surrogate is 3 — the
 * replacement character every UTF-8 encoder writes in its place.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

// ───────────────────────────────────────────────────────────────────────────
// The natural-month calendar (UTC)
// ───────────────────────────────────────────────────────────────────────────
//
// Included credits follow months counted from an ANCHOR: month k starts at
// anchor + k months. Always computed from the anchor, never chained from the
// previous month, so an anchor on the 31st gives Feb 28 (29 in a leap year) and
// then Mar 31 again — chaining would give Mar 28 and never recover.
//
// The day is clamped to the last day of a shorter month, and the time of day is
// kept. This is exactly Postgres's `(S AT TIME ZONE 'UTC' + make_interval(months
// => k)) AT TIME ZONE 'UTC'`, so the database and this code draw the same
// boundaries. UTC throughout, so daylight-saving time cannot move a boundary.

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Days in a month of the proleptic Gregorian calendar (the one JavaScript Dates
 * and Postgres both use), by integer arithmetic. Not by probing a Date at the
 * month's last day: that probe is `NaN` for the month holding the last
 * representable instant, which would make every day of that month look invalid.
 */
function daysInUtcMonth(year: number, monthIndex: number): number {
  if (monthIndex === 1) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  const days = DAYS_IN_MONTH[monthIndex];
  if (days === undefined) throw new RangeError(`month index out of range: ${String(monthIndex)}`);
  return days;
}

function requireValidDate(name: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid Date`);
  }
}

/** `anchor` plus `months` calendar months in UTC, the day clamped to the target month's length. */
export function addUtcMonths(anchor: Date, months: number): Date {
  requireValidDate('anchor', anchor);
  requireSafeInteger('months', months);
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const monthIndex = total - year * 12;
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, monthIndex));
  const out = new Date(0);
  out.setUTCFullYear(year, monthIndex, day);
  out.setUTCHours(
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
  // A result past the last instant a Date can hold comes back as `Invalid Date`,
  // and every comparison against it is false — a boundary that silently never
  // arrives. Refuse it instead.
  if (Number.isNaN(out.getTime())) {
    throw new RangeError(
      `${String(months)} months from ${anchor.toISOString()} is past the last representable instant`,
    );
  }
  return out;
}

/** One natural month: `[start, end)`, the `index`-th month after its anchor. */
export interface NaturalMonth {
  readonly index: number;
  readonly start: Date;
  readonly end: Date;
}

/** The natural month of `anchor` that contains `at`. `at` before the anchor is refused. */
export function naturalMonthContaining(anchor: Date, at: Date): NaturalMonth {
  requireValidDate('anchor', anchor);
  requireValidDate('at', at);
  if (at.getTime() < anchor.getTime()) {
    throw new RangeError('`at` is before the anchor; no natural month contains it');
  }
  let index =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (at.getUTCMonth() - anchor.getUTCMonth());
  if (index < 0) index = 0;
  while (index > 0 && addUtcMonths(anchor, index).getTime() > at.getTime()) index -= 1;
  while (addUtcMonths(anchor, index + 1).getTime() <= at.getTime()) index += 1;
  return { index, start: addUtcMonths(anchor, index), end: addUtcMonths(anchor, index + 1) };
}

/** Longest period split into natural months (a 100-year guard against a runaway loop). */
const MAX_NATURAL_MONTHS = 1_200;

/**
 * A paid period `[start, end)` split into natural months anchored at `start`. The
 * last month is cut at `end` when the period does not end on a month boundary.
 * An annual period gives twelve.
 *
 * ⚠️ A CUT LAST MONTH'S `end` IS THE PERIOD'S END, not the end of its natural
 * month. Prorating it against its own `[start, end)` gives the WHOLE monthly
 * level for however short it is; its share of a natural month is taken against
 * `addUtcMonths(<the period's start>, index + 1)`. Which of the two a grant uses is the
 * granting code's decision — this function only reports the ranges.
 */
export function naturalMonthsOfPeriod(start: Date, end: Date): NaturalMonth[] {
  requireValidDate('start', start);
  requireValidDate('end', end);
  if (end.getTime() <= start.getTime()) throw new RangeError('a period must end after it starts');
  const months: NaturalMonth[] = [];
  for (let index = 0; ; index += 1) {
    if (index >= MAX_NATURAL_MONTHS) throw new RangeError('period is longer than 100 years');
    const monthStart = addUtcMonths(start, index);
    if (monthStart.getTime() >= end.getTime()) break;
    const next = addUtcMonths(start, index + 1);
    months.push({
      index,
      start: monthStart,
      end: next.getTime() < end.getTime() ? next : new Date(end.getTime()),
    });
  }
  return months;
}

// ───────────────────────────────────────────────────────────────────────────
// Proration
// ───────────────────────────────────────────────────────────────────────────

/**
 * `amountMicro × portion / whole`, its MAGNITUDE floored to whole credits, sign
 * kept. A share of an allowance is never rounded up, so a partial month never
 * grants more than its share and a downgrade never takes back more than its share.
 *
 * `portion` and `whole` are durations in one integer unit of the caller's choice
 * (milliseconds, microseconds); the product is taken in BigInt, so a
 * contract-sized allowance over a microsecond duration is still exact.
 */
export function proratedWholeCreditsMicro(
  amountMicro: number,
  portion: number,
  whole: number,
): number {
  requireSafeInteger('amountMicro', amountMicro);
  requireNonNegativeSafeInteger('portion', portion);
  requireNonNegativeSafeInteger('whole', whole);
  if (whole === 0) throw new RangeError('whole must be positive');
  if (portion > whole) throw new RangeError('portion must not exceed whole');
  // BigInt division truncates toward zero: the magnitude is floored, the sign kept.
  const credits = (BigInt(amountMicro) * BigInt(portion)) / (BigInt(whole) * MICRO_BIG);
  return toSafeNumber('prorated share', credits * MICRO_BIG);
}

/** A time range `[start, end)`. */
export interface InstantRange {
  readonly start: Date;
  readonly end: Date;
}

/**
 * What a window grants of a monthly level: the level × the window's share of its
 * natural month, floored to whole credits. A window that is the whole month
 * grants the whole level.
 */
export function windowShareMicro(
  levelMicro: number,
  window: InstantRange,
  natural: InstantRange,
): number {
  requireNonNegativeSafeInteger('levelMicro', levelMicro);
  for (const [name, at] of [
    ['window.start', window.start],
    ['window.end', window.end],
    ['natural.start', natural.start],
    ['natural.end', natural.end],
  ] as const) {
    requireValidDate(name, at);
  }
  const ws = window.start.getTime();
  const we = window.end.getTime();
  const ns = natural.start.getTime();
  const ne = natural.end.getTime();
  if (!(ns <= ws && ws < we && we <= ne)) {
    throw new RangeError('a window must be non-empty and lie within its natural month');
  }
  return proratedWholeCreditsMicro(levelMicro, we - ws, ne - ns);
}

// ───────────────────────────────────────────────────────────────────────────
// Spend order
// ───────────────────────────────────────────────────────────────────────────

/**
 * The kinds of credit a balance is made of: this month's included credits, a
 * mid-month plan change's share, goodwill granted by support, and bought credits.
 *
 * A plain tuple rather than a zod enum: it is a storage vocabulary, not a field
 * any request or response carries.
 */
export const CREDIT_LOT_KINDS = ['monthly', 'proration', 'adjustment', 'top_up'] as const;
export type CreditLotKind = (typeof CREDIT_LOT_KINDS)[number];

/** Lower ranks are spent first: included credits, then goodwill, then bought credits. */
export const CREDIT_LOT_SPEND_RANK: Readonly<Record<CreditLotKind, 0 | 1 | 2>> = deepFreeze<
  Readonly<Record<CreditLotKind, 0 | 1 | 2>>
>({
  monthly: 0,
  proration: 0,
  adjustment: 1,
  top_up: 2,
});

/** What decides a lot's place in the spend order. */
export interface LotSpendOrderKey {
  readonly kind: CreditLotKind;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Spend order: rank, then the soonest expiry, then the oldest, then id — so the
 * same balance is always drawn down the same way.
 */
export function compareLotsInSpendOrder(a: LotSpendOrderKey, b: LotSpendOrderKey): number {
  const rank = CREDIT_LOT_SPEND_RANK[a.kind] - CREDIT_LOT_SPEND_RANK[b.kind];
  if (rank !== 0) return rank;
  const expiry = a.expiresAt.getTime() - b.expiresAt.getTime();
  if (expiry !== 0) return expiry;
  const created = a.createdAt.getTime() - b.createdAt.getTime();
  if (created !== 0) return created;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// API shapes
// ───────────────────────────────────────────────────────────────────────────

/** A credit amount on the wire: credits, at most 3 decimals, never negative. */
export const CreditAmountSchema = z
  .number()
  .nonnegative()
  .multipleOf(0.001)
  .describe('Credits (1 credit = US$0.01), at most 3 decimals');

/** A signed credit amount: a ledger movement, negative when credits leave. */
export const SignedCreditAmountSchema = z
  .number()
  .multipleOf(0.001)
  .describe('Credits (1 credit = US$0.01), at most 3 decimals; negative when credits leave');

/** How an account's AI is funded today. */
export const AiBillingSchema = z.enum(['legacy', 'credits']);
export type AiBilling = z.infer<typeof AiBillingSchema>;

/** Where an AI task's model calls are paid from. */
export const AiSourceSchema = z.enum(['credits', 'own_key']);
export type AiSource = z.infer<typeof AiSourceSchema>;

/** Who last chose the account's AI source. */
export const AiSourceSetBySchema = z.enum(['cutover', 'customer', 'admin']);
export type AiSourceSetBy = z.infer<typeof AiSourceSetBySchema>;

/** Why a new AI task cannot start right now. */
export const AiBlockedReasonSchema = z.enum([
  'ai_not_on_plan',
  'no_credits',
  'debt',
  'own_key_missing',
  'tasks_in_flight',
]);
export type AiBlockedReason = z.infer<typeof AiBlockedReasonSchema>;

/** Why an account owes credits. */
export const AiDebtReasonSchema = z.enum(['payment_reversed', 'plan_change']);
export type AiDebtReason = z.infer<typeof AiDebtReasonSchema>;

/** The sources a plan allows: none without AI, credits only without own-key use. */
export function aiSourcesAllowedOnPlan(tier: AccountTier): readonly AiSource[] {
  const { aiIncluded, ownKeyAllowed } = aiEntitlementFor(tier);
  if (!aiIncluded) return [];
  return ownKeyAllowed ? ['credits', 'own_key'] : ['credits'];
}

/** Credits beyond this month's included ones, by where they came from. */
export const AiCreditExtraKindSchema = z.enum(['plan_change', 'goodwill', 'top_up']);
export type AiCreditExtraKind = z.infer<typeof AiCreditExtraKindSchema>;

/** How each non-monthly lot kind is presented as an extra. */
export const CREDIT_LOT_EXTRA_KIND: Readonly<
  Record<Exclude<CreditLotKind, 'monthly'>, AiCreditExtraKind>
> = deepFreeze<Readonly<Record<Exclude<CreditLotKind, 'monthly'>, AiCreditExtraKind>>>({
  proration: 'plan_change',
  adjustment: 'goodwill',
  top_up: 'top_up',
});

const RateCardVersionSchema = z.number().int().min(1);

/** `GET /v1/account/me/ai` — the account's AI plan, source and balance. */
export const AccountAiStateSchema = z.object({
  billing: AiBillingSchema,
  plan: z.object({
    tier: AccountTierSchema,
    ai_included: z.boolean(),
    /** Whole credits a month; null where the plan's number is set per contract and none is set. */
    monthly_included_credits: z.number().int().nonnegative().nullable(),
    own_key_allowed: z.boolean(),
    allowed_sources: z.array(AiSourceSchema),
  }),
  /** The customer's choice; null means automatic (their own key when usable, else credits). */
  ai_source: AiSourceSchema.nullable(),
  ai_source_set_by: AiSourceSetBySchema.nullable(),
  /** What a task started now would use; null when the plan has no AI. */
  effective_source: AiSourceSchema.nullable(),
  own_key: z.object({
    has_key: z.boolean(),
    usable: z.boolean(),
    set_at: Iso8601Schema.nullable(),
    expires_at: Iso8601Schema.nullable(),
  }),
  balance: z.object({
    available_credits: CreditAmountSchema,
    monthly: z
      .object({
        granted_credits: CreditAmountSchema,
        remaining_credits: CreditAmountSchema,
        period_start: Iso8601Schema,
        resets_at: Iso8601Schema,
      })
      .nullable(),
    extras: z.array(
      z.object({
        kind: AiCreditExtraKindSchema,
        remaining_credits: CreditAmountSchema,
        expires_at: Iso8601Schema,
      }),
    ),
    reserved_in_flight_credits: CreditAmountSchema,
    pending_claims_credits: CreditAmountSchema,
    debt_credits: CreditAmountSchema,
    tasks_in_flight: z.number().int().min(0).max(MAX_AI_TASKS_IN_FLIGHT),
    max_tasks_in_flight: z.literal(MAX_AI_TASKS_IN_FLIGHT),
  }),
  blocked_reason: AiBlockedReasonSchema.nullable(),
  debt_reason: AiDebtReasonSchema.nullable(),
  auto_top_up: z.object({ enabled: z.boolean() }),
  rate_card: z.object({
    version: RateCardVersionSchema,
    effective_at: Iso8601Schema,
    next: z.object({ version: RateCardVersionSchema, effective_at: Iso8601Schema }).nullable(),
  }),
});
export type AccountAiState = z.infer<typeof AccountAiStateSchema>;

/** Why a model does not run on credits. */
export const AiModelOffCreditsReasonSchema = z.enum(['own_key_only', 'unpriced']);
export type AiModelOffCreditsReason = z.infer<typeof AiModelOffCreditsReasonSchema>;

const CreditsPer1kSchema = z.object({
  input: CreditAmountSchema,
  output: CreditAmountSchema,
  cache_read: CreditAmountSchema,
  cache_write_5m: CreditAmountSchema,
  cache_write_1h: CreditAmountSchema,
});

/** One entry of `GET /v1/ai/models`. */
export const AiModelCatalogueEntrySchema = z.object({
  id: AgentModelSchema,
  label: z.string().min(1),
  runs_on: z.array(AiSourceSchema).min(1),
  /** Null when the model runs on credits. */
  on_credits_reason: AiModelOffCreditsReasonSchema.nullable(),
  /** False when the account's plan cannot run it at all (an own-key-only model on a plan without own-key use). */
  available_on_your_plan: z.boolean(),
  /** On the card in force; null when the model does not run on credits. */
  min_credits_to_start: CreditAmountSchema.nullable(),
  max_credits_per_task: CreditAmountSchema.nullable(),
  credits_per_1k: CreditsPer1kSchema.nullable(),
  /** The same figures on an announced card that is not yet in force, if any. */
  next: z
    .object({
      rate_card_version: RateCardVersionSchema,
      effective_at: Iso8601Schema,
      min_credits_to_start: CreditAmountSchema,
      max_credits_per_task: CreditAmountSchema,
      credits_per_1k: CreditsPer1kSchema,
    })
    .nullable(),
});
export type AiModelCatalogueEntry = z.infer<typeof AiModelCatalogueEntrySchema>;

export const AiModelCatalogueResponseSchema = z.object({
  data: z.array(AiModelCatalogueEntrySchema),
});
export type AiModelCatalogueResponse = z.infer<typeof AiModelCatalogueResponseSchema>;

/**
 * `PATCH /v1/account/me/ai-settings`. Only an explicit choice is accepted:
 * automatic (null) is not something this route sets.
 */
export const UpdateAiSettingsRequestSchema = z.object({
  ai_source: AiSourceSchema,
});
export type UpdateAiSettingsRequest = z.infer<typeof UpdateAiSettingsRequestSchema>;

/**
 * A ledger entry id on the wire: a positive integer of at most 18 digits.
 *
 * The column is a Postgres `bigint` identity (at most 9,223,372,036,854,775,807,
 * 19 digits). A 19-digit pattern would admit values above that, and a cursor
 * the database cannot hold fails in the query as a 500 rather than here as a
 * 400. Eighteen digits stays inside the range with a margin no identity column
 * will reach, and it is a plain pattern, so it survives into the published spec.
 * Entry ids and cursors share it, so every id the API emits is a usable cursor.
 */
const AiLedgerEntryIdSchema = z.string().regex(/^[1-9][0-9]{0,17}$/, 'must be a ledger entry id');

/** `GET /v1/account/me/ai/ledger` query. The cursor is the id of the last entry seen. */
export const AiLedgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: AiLedgerEntryIdSchema.optional(),
});
export type AiLedgerQuery = z.infer<typeof AiLedgerQuerySchema>;
export type AiLedgerQueryInput = z.input<typeof AiLedgerQuerySchema>;

/** What a ledger entry records. */
export const AiLedgerEntryKindSchema = z.enum([
  'grant',
  'task_charge',
  'refund',
  'top_up',
  'expiry',
  'adjustment',
  'debt',
]);
export type AiLedgerEntryKind = z.infer<typeof AiLedgerEntryKindSchema>;

export const AiLedgerEntrySchema = z.object({
  id: AiLedgerEntryIdSchema,
  kind: AiLedgerEntryKindSchema,
  /** Signed: positive when credits arrive, negative when they leave. */
  credits: SignedCreditAmountSchema,
  balance_after_credits: CreditAmountSchema,
  created_at: Iso8601Schema,
  /** When the credits this entry added expire; null when it added none. */
  expires_at: Iso8601Schema.nullable(),
  task: z
    .object({
      agent_session_id: z.string().min(1),
      model: AgentModelSchema,
      rate_card_version: RateCardVersionSchema,
    })
    .nullable(),
});
export type AiLedgerEntry = z.infer<typeof AiLedgerEntrySchema>;

export const AiLedgerPageSchema = PaginatedListSchema(AiLedgerEntrySchema);
export type AiLedgerPage = z.infer<typeof AiLedgerPageSchema>;

/** Why a task could not be funded from credits. */
export const AiCreditsExhaustedReasonSchema = z.enum(['balance', 'debt', 'task_too_large']);
export type AiCreditsExhaustedReason = z.infer<typeof AiCreditsExhaustedReasonSchema>;

/** Extension members of the problem returned when credits cannot fund a task. */
export const AiCreditsExhaustedExtensionsSchema = z.object({
  reason: AiCreditsExhaustedReasonSchema,
  available_credits: CreditAmountSchema,
  required_credits: CreditAmountSchema,
  debt_credits: CreditAmountSchema,
  debt_reason: AiDebtReasonSchema.nullable(),
  /** When included credits next arrive; null when none are due. */
  resets_at: Iso8601Schema.nullable(),
});
export type AiCreditsExhaustedExtensions = z.infer<typeof AiCreditsExhaustedExtensionsSchema>;

/**
 * Problem types for AI credits — dark until launch.
 *
 * This is the credits counterpart to `PROBLEM_TYPES` in `problem.ts`, kept in
 * a SEPARATE roster on purpose: this module's files are withheld from the
 * npm tarball unconditionally (see this file's own header + `package.json`'s
 * `files`), and `build:publish` drops it from the barrel, so nothing that
 * lives here ships. `PROBLEM_TYPES` itself ships in full — every SDK mapper,
 * the docs error-codes page and the errors.driftstack.dev site all derive
 * from it, and all of them publish. Putting a dark entry in PROBLEM_TYPES
 * therefore puts it on every one of those published surfaces; keeping it here
 * instead means there is nothing to leak.
 *
 * Sent only to accounts moved onto AI credits (plan §8) — the CP-side feature
 * flag stays off in production until launch, so in practice nobody sees this
 * today.
 *
 * At launch: each entry here moves into `PROBLEM_TYPES` and the three SDK
 * error-mapping tables, in ONE change. The guard in
 * `a-dark-problem-type-reaches-no-published-surface-before-launch.test.ts`
 * fails from the moment that move is only partly done — a member that is
 * simultaneously in both rosters, or reachable on a published surface, is not
 * a valid intermediate state.
 */
export const AI_CREDITS_PROBLEM_TYPES = {
  AiCreditsExhausted: 'https://errors.driftstack.dev/ai-credits-exhausted',
} as const;

export type AiCreditsProblemType =
  (typeof AI_CREDITS_PROBLEM_TYPES)[keyof typeof AI_CREDITS_PROBLEM_TYPES];

/** Credits on one message turn's usage block. */
export const TurnCreditsUsageSchema = z.object({
  source: AiSourceSchema,
  reserved: CreditAmountSchema,
  charged: CreditAmountSchema,
  /** The card the turn was priced on; null when it ran on the customer's own key. */
  rate_card_version: RateCardVersionSchema.nullable(),
});
export type TurnCreditsUsage = z.infer<typeof TurnCreditsUsageSchema>;

// ───────────────────────────────────────────────────────────────────────────
// The admin request shape that is NOT published yet
// ───────────────────────────────────────────────────────────────────────────

/**
 * `ChangeTierRequest` as the SERVER accepts it: the published shape plus the
 * Enterprise contract's monthly credit figure.
 *
 * ⛔ IT LIVES HERE BECAUSE THIS MODULE DOES NOT SHIP. `@driftstack/api-types` is
 * published to npm and `packages/api-types/src/admin.ts` is one of the files in
 * the tarball — so a `monthly_credits` field declared there reached a
 * customer's `dist/admin.d.ts` and their editor's hover text the day it was
 * written, and reached the emitted `dist/admin.js` as a Zod field with it. The
 * published OpenAPI document could omit the field; `npm publish` could not, and
 * `scripts/api-types-build-publish.mjs` correctly REFUSED the release while it
 * was there. `dist/ai-*` is withheld from the tarball unconditionally, so the
 * extension ships nowhere and the server still imports it through the barrel
 * exactly as it imports everything else in this module.
 *
 * ⛔ AN EXTENSION, NOT A SECOND DECLARATION. It is built from the published
 * schema, so the two can never disagree about `tier` or `reason`, and
 * `.extend()` appends — a validation failure reports the same issues, in the
 * same order, under the same paths as the single object did before.
 *
 * WHEN AI CREDITS SHIP: move the field back onto `ChangeTierRequestSchema` in
 * `admin.ts`, delete this, and remove the `credit` entry from
 * `nothing-about-an-unreleased-feature-is-in-the-published-spec`.
 */
export const ChangeTierRequestWithCreditsSchema = ChangeTierRequestSchema.extend({
  /**
   * Whole AI credits a month for an Enterprise agreement. Enterprise is the one
   * plan with no standard allowance, so an account funded by AI credits cannot
   * be put on it without this figure; every other tier ignores it.
   */
  monthly_credits: z.number().int().min(0).max(10_000_000).optional(),
});
export type ChangeTierRequestWithCredits = z.infer<typeof ChangeTierRequestWithCreditsSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Admin (S15) — contract credits, goodwill/forgiveness, rate-card publishing
// ───────────────────────────────────────────────────────────────────────────
//
// Staff-only shapes for `routes/admin-ai-credits.ts`. Same reason as the
// section above: this module never ships, so a field here never reaches a
// customer's autocomplete, and the server imports it through the barrel like
// everything else in this file.

/** `credit_plan_overrides.reason` on the wire — mirrors `CREDIT_PLAN_OVERRIDE_REASONS`
 *  in `apps/server/src/db/credit-ledger-repo.ts` (a contract's own figure, or a
 *  plan an admin assigned by hand). Duplicated by value, not by import: this
 *  package never depends on the server, and the server repo re-validates
 *  membership on every write regardless (the database is the authority). */
export const AiPlanOverrideReasonSchema = z.enum(['contract', 'admin_tier']);
export type AiPlanOverrideReason = z.infer<typeof AiPlanOverrideReasonSchema>;

/** `GET .../credits` and `PUT .../ai-plan-override`'s view of one override. */
export const AdminPlanOverrideViewSchema = z.object({
  monthly_credits: z.number().int().nonnegative(),
  reason: AiPlanOverrideReasonSchema,
  own_key_allowed: z.boolean(),
  anchor_at: Iso8601Schema,
  /** Null while the override does not end. */
  ends_at: Iso8601Schema.nullable(),
  effective_since: Iso8601Schema,
  note: z.string(),
});
export type AdminPlanOverrideView = z.infer<typeof AdminPlanOverrideViewSchema>;

/** `PUT /v1/admin/accounts/:id/ai-plan-override`. Whole credits a month, 0 to
 *  ten million (mirrors `credit_plan_overrides_credits_range`). */
export const AdminSetPlanOverrideRequestSchema = z.object({
  monthly_credits: z.number().int().min(0).max(10_000_000),
  reason: AiPlanOverrideReasonSchema,
  expires_at: Iso8601Schema.optional(),
});
export type AdminSetPlanOverrideRequest = z.infer<typeof AdminSetPlanOverrideRequestSchema>;

/** One lot on the admin credit-state read: the raw facts, not the customer's
 *  rounded `extras[]` shape — an admin reads what is really on the row. */
export const AdminCreditLotViewSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(CREDIT_LOT_KINDS),
  granted_credits: CreditAmountSchema,
  remaining_credits: CreditAmountSchema,
  held_credits: CreditAmountSchema,
  starts_at: Iso8601Schema,
  expires_at: Iso8601Schema,
});
export type AdminCreditLotView = z.infer<typeof AdminCreditLotViewSchema>;

/** `GET /v1/admin/accounts/:id/credits`. */
export const AdminCreditsAccountStateSchema = z.object({
  account_id: z.string().min(1),
  billing: AiBillingSchema,
  ai_source: AiSourceSchema.nullable(),
  ai_source_set_by: AiSourceSetBySchema.nullable(),
  ai_source_set_at: Iso8601Schema.nullable(),
  current_window: z.object({ window_start: Iso8601Schema, window_end: Iso8601Schema }).nullable(),
  lots: z.array(AdminCreditLotViewSchema),
  available_credits: CreditAmountSchema,
  debt_credits: CreditAmountSchema,
  /** The newest debt reason on file; shown only while `debt_credits > 0`, same
   *  rule as `GET /v1/account/me/ai`'s `debt_reason`. */
  debt_reason: AiDebtReasonSchema.nullable(),
  reservations_in_flight: z.number().int().nonnegative(),
  plan_override: AdminPlanOverrideViewSchema.nullable(),
  /** Newest first, at most 20. */
  ledger: z.array(AiLedgerEntrySchema),
});
export type AdminCreditsAccountState = z.infer<typeof AdminCreditsAccountStateSchema>;

/**
 * `POST /v1/admin/accounts/:id/credits/adjustments`. `credits > 0` inserts a
 * goodwill lot with an expiry; `forgive_debt` clears whatever the account
 * currently owes. Both carry `idempotency_key`: a repeat writes nothing new
 * and returns the first attempt's result (`applied: false` on the response).
 */
export const AdminCreditAdjustmentRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('goodwill'),
    credits: z.number().positive().multipleOf(0.001),
    expires_at: Iso8601Schema,
    reason: z.string().min(1).max(500),
    idempotency_key: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('forgive_debt'),
    reason: z.string().min(1).max(500),
    idempotency_key: z.string().min(1).max(200),
  }),
]);
export type AdminCreditAdjustmentRequest = z.infer<typeof AdminCreditAdjustmentRequestSchema>;

export const AdminCreditAdjustmentResponseSchema = z.object({
  /** False when this key already applied and nothing new was written or audited. */
  applied: z.boolean(),
  kind: z.enum(['goodwill', 'forgive_debt']),
  /** The goodwill lot, present only when `kind: 'goodwill'`. */
  lot: AdminCreditLotViewSchema.nullable(),
  /** Credits actually forgiven, present only when `kind: 'forgive_debt'` (0 when
   *  the account owed nothing at the time). */
  forgiven_credits: CreditAmountSchema.nullable(),
  /** The account's debt after this adjustment. */
  debt_credits: CreditAmountSchema,
});
export type AdminCreditAdjustmentResponse = z.infer<typeof AdminCreditAdjustmentResponseSchema>;

/**
 * `POST /v1/admin/credit-rate-cards`. Owner-only. Markup range mirrors
 * `credit_rate_cards_markup_range` (1.0× to 10.0× list price); every priced
 * model and its per-task bounds are derived server-side from the registry, per
 * the design's §7 — nothing here is hand-typed.
 */
export const AdminRateCardPublishRequestSchema = z.object({
  markup_bp: z.number().int().min(10_000).max(100_000),
  effective_at: Iso8601Schema,
});
export type AdminRateCardPublishRequest = z.infer<typeof AdminRateCardPublishRequestSchema>;

/** A card's lifecycle, derived from its dates relative to `now()` and to the
 *  card currently in force — never stored. */
export const AdminRateCardStatusSchema = z.enum([
  'announced',
  'in_force',
  'withdrawn',
  'superseded',
]);
export type AdminRateCardStatus = z.infer<typeof AdminRateCardStatusSchema>;

export const AdminRateCardViewSchema = z.object({
  version: RateCardVersionSchema,
  markup_bp: z.number().int(),
  status: AdminRateCardStatusSchema,
  announced_at: Iso8601Schema,
  effective_at: Iso8601Schema,
  withdrawn_at: Iso8601Schema.nullable(),
  note: z.string(),
  model_count: z.number().int().nonnegative(),
});
export type AdminRateCardView = z.infer<typeof AdminRateCardViewSchema>;

/** `GET /v1/admin/credit-rate-cards`, newest version first. */
export const AdminRateCardListResponseSchema = z.object({
  data: z.array(AdminRateCardViewSchema),
});
export type AdminRateCardListResponse = z.infer<typeof AdminRateCardListResponseSchema>;
