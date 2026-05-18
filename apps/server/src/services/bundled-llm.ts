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
