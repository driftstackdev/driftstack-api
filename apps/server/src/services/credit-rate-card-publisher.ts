// What a new AI credits rate card would contain, derived and checked before it
// is written — the validation half of rate-card publishing.
//
// PURE: no clock, no database, no I/O. The owner-only admin path that writes a
// card to the database is a later slice; it calls this first and writes only an
// `ok` result. The database re-checks every rule it can express (see migration
// 0127), so this is not the last line of defence, only the one that can explain
// a refusal to the person publishing.
//
// Every price is DERIVED, never typed: the list price in the model registry
// (`CLAUDE_MODELS`) × the card's markup, for each kind of token. Only the
// per-task start minimum and reserve maximum are inputs, because they are policy
// rather than price. A derived price that is not a whole number of microcredits
// per token is refused rather than rounded, so a card never charges a fraction
// the database cannot store or a customer cannot be shown.
//
// ⛔ REFUSED OUTRIGHT:
//   · a model that may only run on the customer's own key — by the key policy
//     (`CLAUDE_MODEL_KEY_POLICY`), by the credits decision
//     (`AI_CREDITS_MODEL_DECISION`), or by being an Opus-class id at all. The
//     three agree today; any one of them is enough to refuse, so a later edit to
//     one of them cannot put Opus on credits alone.
//   · an unpriced model — an id the registry does not know, or knows with no
//     positive price. A model nobody can price is a model nobody can meter.

import {
  AI_CREDITS_MODEL_DECISION,
  AgentModelSchema,
  CLAUDE_MODELS,
  CLAUDE_MODEL_KEY_POLICY,
  MARKUP_BASIS_POINTS_PER_UNIT,
  type AgentModel,
  type AgentModelInfo,
  type AgentModelKeyPolicy,
  type AiCreditsModelDecision,
  type CreditRateCardModelRow,
} from '@driftstack/api-types';

/** The markup range the database accepts: 1.0 × to 10.0 × list price. */
export const RATE_CARD_MIN_MARKUP_BP = 1 * MARKUP_BASIS_POINTS_PER_UNIT;
export const RATE_CARD_MAX_MARKUP_BP = 10 * MARKUP_BASIS_POINTS_PER_UNIT;

/** One model the card should price, with its per-task limits in microcredits. */
export interface RateCardModelTerms {
  readonly model: string;
  readonly minStartMicro: number;
  readonly maxReserveMicro: number;
}

export interface RateCardDraft {
  /** Markup over list price in basis points (20,000 = 2.0 ×). */
  readonly markupBp: number;
  readonly models: readonly RateCardModelTerms[];
}

/** The per-token prices a row carries, by the name of the row field. */
export type RateCardPriceField =
  | 'inputMicroPerToken'
  | 'outputMicroPerToken'
  | 'cacheReadMicroPerToken'
  | 'cacheWrite5mMicroPerToken'
  | 'cacheWrite1hMicroPerToken'
  | 'listInputMicrocentsPerToken'
  | 'listOutputMicrocentsPerToken';

export type RateCardDraftRefusal =
  | { readonly reason: 'no_models' }
  | { readonly reason: 'markup_out_of_range'; readonly markupBp: number }
  | { readonly reason: 'duplicate_model'; readonly model: string }
  | { readonly reason: 'own_key_only'; readonly model: string }
  | { readonly reason: 'unpriced'; readonly model: string }
  | {
      readonly reason: 'price_not_whole';
      readonly model: string;
      readonly field: RateCardPriceField;
    }
  | { readonly reason: 'rate_order'; readonly model: string }
  | { readonly reason: 'reserve_bounds'; readonly model: string };

/** A derived row, ready to be written beside its card. */
export interface DerivedRateCardRow extends CreditRateCardModelRow {
  readonly model: AgentModel;
}

export type RateCardDraftResult =
  | { readonly ok: true; readonly markupBp: number; readonly rows: readonly DerivedRateCardRow[] }
  | { readonly ok: false; readonly refusals: readonly RateCardDraftRefusal[] };

/** What the derivation reads. Defaults to the shipped registry; tests substitute it. */
export interface RateCardSources {
  readonly registry: Readonly<Record<AgentModel, AgentModelInfo>>;
  readonly keyPolicy: Readonly<Record<AgentModel, AgentModelKeyPolicy>>;
  readonly decisions: Readonly<Record<AgentModel, AiCreditsModelDecision>>;
}

const SHIPPED_SOURCES: RateCardSources = {
  registry: CLAUDE_MODELS,
  keyPolicy: CLAUDE_MODEL_KEY_POLICY,
  decisions: AI_CREDITS_MODEL_DECISION,
};

/** Any Opus-class id, however it is spelled or prefixed. Mirrors the database CHECK. */
const OPUS_CLASS = /opus/i;

/**
 * Tolerance for reading a product of decimal list prices as a whole number. The
 * registry holds prices as binary floats (0.2 cents per 1k tokens), so at a
 * markup of 1.1 × Sonnet 5's input is 0.2 × 1000 × 1.1 = 220.00000000000003,
 * not 220. Float error at these magnitudes (below 10^6) is under 10^-9; a genuine
 * fraction is far larger — with a whole list price, a whole-basis-point markup
 * and the registry's cache multipliers (0.1, 1.25, 2) it is a multiple of
 * 10^-5 of a microcredit.
 */
const WHOLE_TOLERANCE = 1e-9;

function wholeOrNull(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > WHOLE_TOLERANCE) return null;
  return Number.isSafeInteger(rounded) ? rounded : null;
}

function own<T extends object>(record: T, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const PRICE_FIELDS: readonly RateCardPriceField[] = [
  'inputMicroPerToken',
  'outputMicroPerToken',
  'cacheReadMicroPerToken',
  'cacheWrite5mMicroPerToken',
  'cacheWrite1hMicroPerToken',
  'listInputMicrocentsPerToken',
  'listOutputMicrocentsPerToken',
];

function isComplete(
  prices: Partial<Record<RateCardPriceField, number>>,
): prices is Record<RateCardPriceField, number> {
  return PRICE_FIELDS.every((field) => prices[field] !== undefined);
}

/**
 * Derive a card's rows from the registry × `markupBp`, or say every reason it
 * cannot be published. Every refusal is reported, not only the first, so a
 * publisher sees the whole list at once.
 */
export function deriveRateCardRows(
  draft: RateCardDraft,
  sources: RateCardSources = SHIPPED_SOURCES,
): RateCardDraftResult {
  const refusals: RateCardDraftRefusal[] = [];
  const { markupBp } = draft;
  const markupOk =
    Number.isSafeInteger(markupBp) &&
    markupBp >= RATE_CARD_MIN_MARKUP_BP &&
    markupBp <= RATE_CARD_MAX_MARKUP_BP;
  if (!markupOk) refusals.push({ reason: 'markup_out_of_range', markupBp });
  if (draft.models.length === 0) refusals.push({ reason: 'no_models' });

  const seen = new Set<string>();
  const rows: DerivedRateCardRow[] = [];
  for (const terms of draft.models) {
    const { model } = terms;
    if (seen.has(model)) {
      refusals.push({ reason: 'duplicate_model', model });
      continue;
    }
    seen.add(model);

    const parsed = AgentModelSchema.safeParse(model);
    if (!parsed.success || !own(sources.registry, parsed.data)) {
      refusals.push({ reason: 'unpriced', model });
      continue;
    }
    const id = parsed.data;
    // Each source must say yes. A policy or decision that does not mention the
    // model is not a yes: unknown never defaults to running on our key.
    if (
      OPUS_CLASS.test(id) ||
      !own(sources.keyPolicy, id) ||
      sources.keyPolicy[id] !== 'any_key' ||
      !own(sources.decisions, id) ||
      sources.decisions[id] !== 'on_credits'
    ) {
      refusals.push({ reason: 'own_key_only', model });
      continue;
    }

    const info = sources.registry[id];
    if (!(info.inputCentsPer1k > 0) || !(info.outputCentsPer1k > 0)) {
      refusals.push({ reason: 'unpriced', model });
      continue;
    }

    const { minStartMicro, maxReserveMicro } = terms;
    const boundsOk =
      Number.isSafeInteger(minStartMicro) &&
      Number.isSafeInteger(maxReserveMicro) &&
      minStartMicro > 0 &&
      maxReserveMicro >= minStartMicro;
    if (!boundsOk) refusals.push({ reason: 'reserve_bounds', model });
    // Prices under a markup the database would refuse mean nothing; that
    // refusal is already recorded once for the whole card.
    if (!markupOk) continue;

    // Cents per 1k tokens × 1000 = microcents per token = microcredits per token
    // at 1.0 × (one credit is one cent). The markup is applied last.
    const markup = markupBp / MARKUP_BASIS_POINTS_PER_UNIT;
    const listIn = info.inputCentsPer1k * 1000;
    const listOut = info.outputCentsPer1k * 1000;
    const wanted: ReadonlyArray<readonly [RateCardPriceField, number]> = [
      ['inputMicroPerToken', listIn * markup],
      ['outputMicroPerToken', listOut * markup],
      ['cacheReadMicroPerToken', listIn * info.cacheReadMultiplier * markup],
      ['cacheWrite5mMicroPerToken', listIn * info.cacheWrite5mMultiplier * markup],
      ['cacheWrite1hMicroPerToken', listIn * info.cacheWrite1hMultiplier * markup],
      ['listInputMicrocentsPerToken', listIn],
      ['listOutputMicrocentsPerToken', listOut],
    ];
    const prices: Partial<Record<RateCardPriceField, number>> = {};
    for (const [field, value] of wanted) {
      const whole = wholeOrNull(value);
      if (whole === null) refusals.push({ reason: 'price_not_whole', model, field });
      else prices[field] = whole;
    }
    if (!isComplete(prices)) continue;

    // The order the call bound relies on, and the database CHECKs enforce
    // (a cache read may be free, never negative).
    if (
      !(
        prices.cacheReadMicroPerToken >= 0 &&
        prices.cacheReadMicroPerToken <= prices.inputMicroPerToken &&
        prices.inputMicroPerToken <= prices.cacheWrite5mMicroPerToken &&
        prices.cacheWrite5mMicroPerToken <= prices.cacheWrite1hMicroPerToken
      )
    ) {
      refusals.push({ reason: 'rate_order', model });
      continue;
    }
    if (boundsOk) rows.push({ model: id, ...prices, minStartMicro, maxReserveMicro });
  }

  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, markupBp, rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// S15 — the OWNER-ONLY admin publish path sends only `{markup_bp, effective_at}`
// (the design's §7 shape): no per-model terms. This derives the full model list
// itself, so nothing is hand-typed on the request.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every model's per-task start minimum and reserve maximum is Sonnet 5's own
 * (6 / 60 credits), scaled by that model's OUTPUT list price relative to Sonnet
 * 5's — the same ratio `CREDIT_RATE_CARD_V1` was hand-built from (§9: Sonnet
 * 4.6 at 9/90, Haiku 4.5 at 3/30). A model that costs more per output token
 * needs more credit to run one task; a model that costs less needs less.
 */
const BASE_TERMS_MODEL: AgentModel = 'claude-sonnet-5';
const BASE_MIN_START_MICRO = 6_000_000;
const BASE_MAX_RESERVE_MICRO = 60_000_000;

/**
 * The models a card SHOULD price, with their scaled per-task limits — every
 * `AgentModel` the key policy and the credits decision both call `any_key` /
 * `on_credits` today, Opus-class ids excluded outright (mirrors
 * `deriveRateCardRows`'s own refusal so the two can never disagree about which
 * models are creditable).
 *
 * ⛔ NOT EVERY MODEL IN THE REGISTRY. Feeding `deriveRateCardRows` an
 * own-key-only model here would make EVERY publish refuse forever — Opus is
 * always own-key-only, so a draft that always includes it could never
 * succeed. The own_key_only refusal in `deriveRateCardRows` stays reachable
 * only because a CALLER can pass its own `sources` (a test proving "an
 * own-key-only model is refused" swaps `keyPolicy`/`decisions` for one that
 * marks a normally-creditable model own-key-only); this function is what a
 * real publish uses, and it never manufactures that refusal against itself.
 */
export function candidateRateCardModels(
  sources: RateCardSources = SHIPPED_SOURCES,
): RateCardModelTerms[] {
  const base = sources.registry[BASE_TERMS_MODEL];
  if (base === undefined || !(base.outputCentsPer1k > 0)) {
    throw new Error(
      `the rate card base model ${BASE_TERMS_MODEL} has no positive output list price`,
    );
  }
  const terms: RateCardModelTerms[] = [];
  for (const model of Object.keys(sources.registry) as AgentModel[]) {
    if (OPUS_CLASS.test(model)) continue;
    if (sources.keyPolicy[model] !== 'any_key') continue;
    if (sources.decisions[model] !== 'on_credits') continue;
    const info = sources.registry[model];
    if (!(info.outputCentsPer1k > 0)) continue;
    const ratio = info.outputCentsPer1k / base.outputCentsPer1k;
    const minStartMicro = wholeOrNull(BASE_MIN_START_MICRO * ratio);
    const maxReserveMicro = wholeOrNull(BASE_MAX_RESERVE_MICRO * ratio);
    // A ratio that does not land on a whole microcredit is a registry price
    // this scaling cannot express cleanly; skip rather than round, the same
    // discipline `deriveRateCardRows` applies to every other price.
    if (minStartMicro === null || maxReserveMicro === null) continue;
    terms.push({ model, minStartMicro, maxReserveMicro });
  }
  // Deterministic order: the id itself, so two publishes of the same registry
  // insert their model rows in the same order and a diff is ever only prices.
  terms.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return terms;
}
