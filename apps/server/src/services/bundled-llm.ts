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
}

/** In-memory variant for tests. Pre-populate via `set`. */
export class InMemoryBundledLlmRepo implements BundledLlmRepo {
  private readonly rows = new Map<string, BundledLlmSettings>();

  set(accountId: string, settings: BundledLlmSettings): void {
    this.rows.set(accountId, settings);
  }

  findSettings(accountId: string): Promise<BundledLlmSettings | null> {
    return Promise.resolve(this.rows.get(accountId) ?? null);
  }
}
