// Drift guard for apps/docs/src/pages/api/bundled-llm.md. Pins the
// bundled-LLM customer-facing docs — $20 default cap + $10k ceiling
// + opt-in consent + 3-endpoint surface + 2 typed 402 errors
// (BudgetExhausted + ConsentRequired) + Anthropic-no-training
// privacy commitment.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/bundled-llm.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/api/bundled-llm content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Bundled-LLM overview framing pinned: 'Driftstack's bundled LLM rail lets customers run AI-driven agent sessions without supplying their own Anthropic API key. Driftstack hosts the decomposer + bills usage against a customer-controlled monthly soft cap (default $20).' + 'Opt-in is explicit (consent: true) and revocable; the soft cap is customer-configurable up to a $10,000/month ceiling.' + 'The agent session route's resolution chain prefers BYOK (per-request header or stored) over bundled-LLM — bundled-LLM is the no-BYOK fallback.' — pinned so the $20-default + $10k-ceiling + explicit-opt-in + BYOK-precedence contract all stay documented", () => {
    expect(body).toMatch(
      /without supplying their own\s*\n?\s*Anthropic API key\. Driftstack hosts the decomposer \+ bills usage\s*\n?\s*against a customer-controlled monthly soft cap \(default \$20\)\./,
    );
    expect(body).toMatch(
      /Opt-in is explicit \(`consent: true`\) and revocable; the soft cap is\s*\n?\s*customer-configurable up to a \$10,000\/month ceiling\./,
    );
    expect(body).toMatch(
      /The agent\s*\n?\s*session route's resolution chain prefers \[BYOK\]\(\/api\/byok-anthropic\/\)\s*\n?\s*\(per-request header or stored\) over bundled-LLM — bundled-LLM is\s*\n?\s*the no-BYOK fallback\./,
    );
  });

  it('3-endpoint surface pinned: GET /v1/account/me/bundled-llm-settings + GET /v1/account/me/bundled-llm-status + PATCH /v1/account/me/bundled-llm-settings. Drift to a different verb / path would mismatch the route layer + dashboard fetch surface', () => {
    expect(body).toMatch(/`GET \/v1\/account\/me\/bundled-llm-settings`/);
    expect(body).toMatch(/`GET \/v1\/account\/me\/bundled-llm-status`/);
    expect(body).toMatch(/`PATCH \/v1\/account\/me\/bundled-llm-settings`/);
  });

  it('pins the shipped desktop settings path and the flat standard turn rate without leaking upstream provider cost', () => {
    expect(body).toMatch(/desktop app under \*\*Settings → AI\s*\n?\s*& billing\*\*/);
    expect(body).toMatch(/flat \*\*\$0\.10 per agent turn\*\*/);
    expect(body).toMatch(/independent of model choice and\s*\n?\s*token count/);
    expect(body).toMatch(/Enterprise can use a contracted custom rate/);
    expect(body).toMatch(/`cost_basis = 'bundled_flat_per_turn'`/);
    expect(body).toMatch(/does\s*\n?\s*not expose Driftstack's upstream provider cost/);
    expect(body).not.toMatch(/Cost-per-turn varies with the underlying model/);
  });

  it('status-panel prose keeps consent, cap, used spend, and remaining budget in one coherent sentence', () => {
    expect(body).toMatch(
      /`BundledLlmStatusPanel` reads this on page-load to render consent,\s*\n?\s*cap, used spend, and remaining budget\./,
    );
    expect(body).not.toMatch(/render consent\s*\n\s*\n- cap \+ used/);
  });

  it("Status record shape pinned to the SHIPPED route fields: consent + cap_cents + used_this_month_cents + remaining_cents + refused_count_this_month + month_started_at. + 'used_this_month_cents sums usage_records.cost_usd_cents over the rows where record_type = \"agent_decomposer_bundled\" and recorded_at >= start_of_calendar_month (UTC)' — pinned so the status field names match account-bundled-llm.ts (the status route returns cap_cents/remaining_cents/month_started_at, NOT the settings record's monthly_cap_usd_cents) + record_type filter + UTC-calendar-month aggregation contract all stay documented (drift on aggregation would mis-bill across month boundaries)", () => {
    expect(body).toMatch(
      /"consent": true,\s*\n?\s*"cap_cents": 2000,\s*\n?\s*"used_this_month_cents": 450,\s*\n?\s*"remaining_cents": 1550,\s*\n?\s*"refused_count_this_month": 0,\s*\n?\s*"month_started_at":/,
    );
    expect(body).toMatch(
      /`used_this_month_cents` sums `usage_records\.cost_usd_cents` over\s*\n?\s*the rows where `record_type = 'agent_decomposer_bundled'` and\s*\n?\s*`recorded_at >= start_of_calendar_month` \(UTC\)\./,
    );
  });

  it("PATCH validation framing pinned: 'consent — boolean.' + 'monthly_cap_usd_cents — integer; 0 to 1,000,000 ($10,000 ceiling). Negative values rejected with 400.' + 'Partial update — either field may be omitted, but at least one must be present; an empty body is rejected with 400.' — pinned so the integer/0-to-1M range + $10k ceiling + empty-body-400 contract (PatchBodySchema.refine) all stay documented", () => {
    expect(body).toMatch(/- `consent` — boolean\./);
    expect(body).toMatch(
      /- `monthly_cap_usd_cents` — integer; 0 to 1,000,000 \(\$10,000 ceiling\)\.\s*\n?\s*Negative values rejected with `400`\./,
    );
    expect(body).toMatch(
      /Partial update — either field may be omitted, but at least one of\s*\n?\s*`consent` \/ `monthly_cap_usd_cents` must be present\. An empty body\s*\n?\s*is rejected with `400`/,
    );
  });

  it("BundledLlmBudgetExhausted 402 problem+json shape pinned: type 'https://errors.driftstack.dev/bundled-llm-budget-exhausted' + title 'Bundled-LLM monthly cap reached' + spent_cents + cap_cents extension fields. + 3-recovery-path list: raise cap / supply BYOK / wait for next month — pinned so the 402 problem-type + extension-fields + 3-recovery-path roster contract all stay documented", () => {
    expect(body).toMatch(
      /"type": "https:\/\/errors\.driftstack\.dev\/bundled-llm-budget-exhausted",\s*\n?\s*"title": "Bundled-LLM monthly cap reached",\s*\n?\s*"status": 402,\s*\n?\s*"detail": "Spend this month has reached the configured cap\.",\s*\n?\s*"spent_cents": 2000,\s*\n?\s*"cap_cents": 2000/,
    );
    expect(body).toMatch(/1\. Raise the cap via `PATCH \/v1\/account\/me\/bundled-llm-settings`/);
    expect(body).toMatch(
      /2\. Supply a BYOK key via the `x-byok-anthropic-api-key` header or\s*\n?\s*`PUT \/v1\/account\/me\/byok-anthropic-key`/,
    );
    expect(body).toMatch(/3\. Wait for the next calendar month/);
  });

  it("BundledLlmConsentRequired 402 problem+json shape pinned: type 'https://errors.driftstack.dev/bundled-llm-consent-required' + title 'Bundled-LLM consent required' + detail 'Opt in via PATCH /v1/account/me/bundled-llm-settings.' + no extension fields — pinned so the consent-gate 402 + opt-in-via-PATCH guidance + 'no extension fields' SDK contract all stay documented", () => {
    expect(body).toMatch(
      /"type": "https:\/\/errors\.driftstack\.dev\/bundled-llm-consent-required",\s*\n?\s*"title": "Bundled-LLM consent required",\s*\n?\s*"status": 402,\s*\n?\s*"detail": "Opt in via PATCH \/v1\/account\/me\/bundled-llm-settings\."/,
    );
    expect(body).toMatch(
      /The SDK exposes the typed `BundledLlmConsentRequiredError` \(no\s*\n?\s*extension fields\)\./,
    );
  });

  it("Cross-language SDK extension-fields naming pinned: Python spent_cents/cap_cents + TS spentCents/capCents + Go SpentCents/CapCents. Drift on snake_case-vs-camelCase-vs-PascalCase would mismatch the SDK's native idiom in each language", () => {
    expect(body).toMatch(
      /Python:\s*\n?\s*`spent_cents` \/ `cap_cents`; TS: `spentCents` \/ `capCents`; Go:\s*\n?\s*`SpentCents` \/ `CapCents`/,
    );
  });

  it("Errors table 4-row roster pinned: 400 validation + 401 unauthorized + 402 bundled-llm-budget-exhausted + 402 bundled-llm-consent-required — pinned so the 2-different-402 distinction stays explicit (drift to merging them would lose the customer SDK's typed-error discrimination). The 503 (unwired bundled-LLM) is NOT returned on these settings/status reads — it surfaces on the agent-session turn route — so the table must NOT carry a 503 row.", () => {
    expect(body).toMatch(/\|\s*400 \| validation\s*\|/);
    expect(body).toMatch(/\|\s*401 \| unauthorized\s*\|/);
    expect(body).toMatch(/\|\s*402 \| bundled-llm-budget-exhausted/);
    expect(body).toMatch(/\|\s*402 \| bundled-llm-consent-required/);
    // 503 belongs to the agent-session turn route, not these reads.
    expect(body).not.toMatch(/\|\s*503 \| /);
    expect(body).toMatch(
      /The settings \+ status routes above do not return a `503`\. A `503`\s*\n?\s*for an unwired bundled-LLM service is returned on the \*\*agent-session\s*\n?\s*turn\*\* route, not on these reads\./,
    );
  });

  it("Anthropic-no-training privacy commitment framing pinned: 'Bundled-LLM consent does NOT grant Driftstack any rights to train models on customer prompts. The current bundled-LLM provider is Anthropic Claude; per their API terms, customer data is not used for training.' + 'No prompt content is logged on Driftstack's side beyond what customers can read in their own session transcripts.' — pinned so the no-training-rights + Anthropic-API-terms + transcript-only-logging privacy contract all stay documented", () => {
    expect(body).toMatch(
      /- Bundled-LLM consent does NOT grant Driftstack any rights to\s*\n?\s*train models on customer prompts\. The current bundled-LLM\s*\n?\s*provider is Anthropic Claude; per their API terms, customer\s*\n?\s*data is not used for training\./,
    );
    expect(body).toMatch(
      /- No prompt content is logged on Driftstack's side beyond what\s*\n?\s*customers can read in their own session transcripts\./,
    );
  });
});
