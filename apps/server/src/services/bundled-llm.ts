// Arc 1 sub-slice 6.3 (v2-#6) — bundled-LLM settings lookup.
//
// Single read method: `findSettings(accountId)` returns the customer's
// consent flag + monthly cap (cents). Used by the agent-sessions
// resolution path in sub-slice 6.3 to decide whether to fall through
// to the deployment Anthropic key when the customer's BYOK is absent
// or past its v2-#21 TTL.
//
// Q4=A locked: BYOK ALWAYS wins. Bundled-LLM only resolves when there
// is no BYOK plaintext to use. The resolution chain in routes/
// agent-sessions.ts encodes this — this service is a pure read.
//
// The repo is intentionally tiny so the v1.0 surface can land without
// the cost-recording (sub-slice 6.4) or soft-cap enforcement (6.5)
// bound up in the same interface. Those follow-ups extend this
// service with additional methods.

import {
  agentModelListPrice,
  deploymentKeyModelRefusal,
  DEFAULT_AGENT_MODEL,
  CLAUDE_MODELS,
  type DeploymentKeyModelRefusal,
} from '@driftstack/api-types';

/**
 * The most a customer may SET as their bundled monthly soft cap: $100.
 *
 * It was $10,000 — the storage bound (migration 0050's CHECK), exposed as the
 * write bound, which let one PATCH authorise Driftstack's key to spend $10,000 a
 * month for a single account. Lowered 2026-09-19 as groundwork for monthly
 * credits, whose largest allowance is $300 and whose top-ups are bought, not
 * typed in.
 *
 * ⛔ NEW WRITES ONLY. A cap already stored above this is GRANDFATHERED: it is
 * read, enforced and returned exactly as before, and re-sending that same value
 * is accepted, because both clients save the whole settings object — a customer
 * with a $500 cap who only flips consent re-sends 50,000, and refusing that would
 * lock them out of their own consent toggle. The storage bound stays where it
 * was, so no stored row violates anything.
 */
export const BUNDLED_CAP_MAX_NEW_WRITE_CENTS = 10_000;
/** Migration 0050's CHECK constraint: the most the column can hold. */
export const BUNDLED_CAP_STORAGE_MAX_CENTS = 1_000_000;

/**
 * Whether a PATCH may write `requestedCents` over a stored `currentCents`.
 * Null when it may; otherwise the customer-facing reason.
 */
export function bundledCapWriteRefusal(args: {
  requestedCents: number;
  currentCents: number | null;
}): string | null {
  if (args.requestedCents <= BUNDLED_CAP_MAX_NEW_WRITE_CENTS) return null;
  // A grandfathered cap above the new maximum may be kept as it is OR LOWERED to
  // any value above the maximum, never raised. Lowering only shrinks exposure,
  // and refusing it would push a customer who wants to spend less to either keep
  // the higher cap or jump all the way down — the owner's decision, 2026-09-19.
  if (args.currentCents !== null && args.requestedCents <= args.currentCents) return null;
  return (
    `monthly_cap_usd_cents can be set to at most ${BUNDLED_CAP_MAX_NEW_WRITE_CENTS.toString()} ` +
    `($${(BUNDLED_CAP_MAX_NEW_WRITE_CENTS / 100).toFixed(2)}).`
  );
}

/**
 * Why a session's model cannot run on the deployment's key, as the customer
 * reads it — or null when it can. See `deploymentKeyModelRefusal` for the rule.
 *
 * The message names the model by its label, says the one thing that WILL work
 * (their own key), and offers the default model as the alternative. It says
 * nothing about pricing or metering: those are internals.
 */
export function deploymentKeyModelRefusalFor(model: string): {
  reason: DeploymentKeyModelRefusal;
  detail: string;
} | null {
  const reason = deploymentKeyModelRefusal(model);
  if (reason === null) return null;
  const alternative = CLAUDE_MODELS[DEFAULT_AGENT_MODEL].label;
  const addKey =
    'Add your key (PUT /v1/account/me/byok-anthropic-key, or the x-byok-anthropic-api-key header), ';
  // The reason travels separately for a client to branch on; the sentence differs
  // only because an unpriced id has no label and need not be an Anthropic model
  // (older stored ids, other providers' ids), so it must not promise one.
  const detail =
    reason === 'own_key_only'
      ? `${agentModelListPrice(model)?.label ?? model} is available with your own Anthropic key. ` +
        `${addKey}or start a session with ${alternative}.`
      : `This model is available with your own key. ${addKey}or start a session with ${alternative}.`;
  return { reason, detail };
}

export interface BundledLlmSettings {
  /** Migration 0050 `bundled_llm_consent` column. */
  consent: boolean;
  /** Migration 0050 `bundled_llm_monthly_cap_usd_cents` column —
   *  soft-cap on bundled-LLM spend per calendar month. Sub-slice 6.5
   *  enforces this; today it's read-only. */
  monthlyCapUsdCents: number;
}

export interface BundledLlmRepo {
  findSettings(accountId: string): Promise<BundledLlmSettings | null>;
  /**
   * ⛔ Sums the POSTED flat price (`cost_usd_cents`), never the list-price cost
   * (`list_price_cost_millicents`) that the same rows also carry — see
   * POSTED_COST_FIELD in db/agent-decomposer-usage-recorder.ts.
   *
   * Arc 1 sub-slice 6.5 (v2-#6) — sum `usage_records.cost_usd_cents`
   * over rows where account_id = ? AND record_type =
   * 'agent_decomposer_bundled' AND recorded_at >= start_of_calendar_month
   * derived from `now`. Returns 0 when there are no matching rows.
   * Used by the route's pre-turn soft-cap check.
   */
  sumMonthlySpendCents(args: { accountId: string; now: Date }): Promise<number>;
  /**
   * Arc 1 sub-slice 6.6 (v2-#6) — partial update on the customer's
   * settings. Either field may be omitted (PATCH semantics). When
   * both omitted, this is a no-op. Returns the post-update settings
   * so the route can echo back what the customer set.
   */
  updateSettings(args: {
    accountId: string;
    consent?: boolean;
    monthlyCapUsdCents?: number;
  }): Promise<BundledLlmSettings | null>;
}

/** Start-of-calendar-month boundary (UTC) for the supplied date.
 *  Pure function; exported so tests can pin the boundary. */
export function startOfCalendarMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export class BundledLlmService {
  constructor(private readonly repo: BundledLlmRepo) {}

  /** Returns null when the account row is missing (treat as
   *  consent=false on the resolution path). The route layer
   *  defends against this by short-circuiting to 502 when null
   *  AND no other BYOK leg resolved. */
  async findSettings(accountId: string): Promise<BundledLlmSettings | null> {
    return this.repo.findSettings(accountId);
  }

  /** Sum of bundled-LLM cost (cents) in the current calendar month
   *  (UTC). Backs the sub-slice 6.5 soft-cap check + sub-slice 6.7
   *  dashboard status read. */
  async sumMonthlySpendCents(args: { accountId: string; now: Date }): Promise<number> {
    return this.repo.sumMonthlySpendCents(args);
  }

  /** Sub-slice 6.6 (v2-#6) — partial update + return post-state. */
  async updateSettings(args: {
    accountId: string;
    consent?: boolean;
    monthlyCapUsdCents?: number;
  }): Promise<BundledLlmSettings | null> {
    return this.repo.updateSettings(args);
  }
}

/** In-memory variant for tests. Pre-populate via `set`. */
export class InMemoryBundledLlmRepo implements BundledLlmRepo {
  private readonly rows = new Map<string, BundledLlmSettings>();
  /** Accumulated bundled-LLM cost per account (cents). Tests poke
   *  this directly via `addSpend` to simulate prior-turn cost rows
   *  without going through the recorder. */
  private readonly monthlySpend = new Map<string, Array<{ at: Date; cents: number }>>();

  set(accountId: string, settings: BundledLlmSettings): void {
    this.rows.set(accountId, settings);
  }

  addSpend(accountId: string, at: Date, cents: number): void {
    const arr = this.monthlySpend.get(accountId) ?? [];
    arr.push({ at, cents });
    this.monthlySpend.set(accountId, arr);
  }

  findSettings(accountId: string): Promise<BundledLlmSettings | null> {
    return Promise.resolve(this.rows.get(accountId) ?? null);
  }

  sumMonthlySpendCents(args: { accountId: string; now: Date }): Promise<number> {
    const start = startOfCalendarMonthUtc(args.now);
    const arr = this.monthlySpend.get(args.accountId) ?? [];
    let total = 0;
    for (const r of arr) {
      if (r.at >= start) total += r.cents;
    }
    return Promise.resolve(total);
  }

  updateSettings(args: {
    accountId: string;
    consent?: boolean;
    monthlyCapUsdCents?: number;
  }): Promise<BundledLlmSettings | null> {
    const existing = this.rows.get(args.accountId) ?? { consent: false, monthlyCapUsdCents: 2000 };
    const next: BundledLlmSettings = {
      consent: args.consent ?? existing.consent,
      monthlyCapUsdCents: args.monthlyCapUsdCents ?? existing.monthlyCapUsdCents,
    };
    this.rows.set(args.accountId, next);
    return Promise.resolve(next);
  }
}
