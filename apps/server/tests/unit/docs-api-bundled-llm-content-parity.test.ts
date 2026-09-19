// Drift guard for apps/docs/src/pages/api/bundled-llm.md. Pins the
// bundled-LLM customer-facing docs — $20 default cap + $10k ceiling
// + opt-in consent + 3-endpoint surface + 2 typed 402 errors
// (BudgetExhausted + ConsentRequired) + Anthropic-no-training
// privacy commitment.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BundledLlmBudgetExhaustedError,
  BundledLlmConsentRequiredError,
} from '../../src/lib/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/bundled-llm.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** The JSON body of the page's `HTTP/1.1 <status line>` example. */
function exampleBody(page: string, statusLine: string): Record<string, unknown> {
  const at = page.indexOf(`HTTP/1.1 ${statusLine}`);
  if (at === -1) return {};
  const block = page.slice(at, page.indexOf('```', at));
  return JSON.parse(block.slice(block.indexOf('{'))) as Record<string, unknown>;
}

/** The page's example for `type`, among its 402 examples. */
function example402(page: string, type: string): Record<string, unknown> {
  let from = 0;
  for (;;) {
    const at = page.indexOf('HTTP/1.1 402 Payment Required', from);
    if (at === -1) return {};
    const parsed = exampleBody(page.slice(at), '402 Payment Required');
    if (parsed['type'] === type) return parsed;
    from = at + 1;
  }
}

describe('docs/api/bundled-llm content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('documents the bundled model option as a fixed per-turn amount against a customer-controlled cap, with BYOK precedence', () => {
    expect(body).toMatch(
      /without their own Anthropic\s*API key\. Each agent turn counts a fixed amount against a monthly cap\s*the customer controls \(default \$20\)\./,
    );
    expect(body).toMatch(
      /Opt-in is explicit \(`consent: true`\) and revocable; the soft cap is\s*customer-configurable up to a \$100\/month ceiling\./,
    );
    expect(body).toMatch(
      /If the customer\s*has a \[BYOK\]\(\/api\/byok-anthropic\/\) key \(per-request header or stored\),\s*it is used instead of the bundled LLM\./,
    );
  });

  it('3-endpoint surface pinned: GET /v1/account/me/bundled-llm-settings + GET /v1/account/me/bundled-llm-status + PATCH /v1/account/me/bundled-llm-settings. Drift to a different verb / path would mismatch the route layer + dashboard fetch surface', () => {
    expect(body).toMatch(/`GET \/v1\/account\/me\/bundled-llm-settings`/);
    expect(body).toMatch(/`GET \/v1\/account\/me\/bundled-llm-status`/);
    expect(body).toMatch(/`PATCH \/v1\/account\/me\/bundled-llm-settings`/);
  });

  it('pins the desktop settings path and flat per-turn value without inventing a Stripe item', () => {
    expect(body).toMatch(/desktop app under \*\*Settings → AI\s*& billing\*\*/);
    expect(body).toMatch(
      /each agent turn counts a flat\s*\*\*\$0\.10\*\* against the customer-controlled monthly budget/,
    );
    expect(body).toMatch(/whatever\s*the model or token count/);
    expect(body).toMatch(/Enterprise can\s*use a contracted custom budget/);
    expect(body).toMatch(/not a separately itemized charge on your Stripe invoice today/);
    expect(body).toMatch(
      /The amount counted\s*against the budget per turn is this flat value, not Driftstack's actual provider cost\./,
    );
    expect(body).not.toMatch(/cost_basis|upstream provider cost/);
    expect(body).not.toMatch(/Cost-per-turn varies with the underlying model/);
    expect(body).not.toMatch(/costs are billed alongside the customer's tier/i);
  });

  it('status-panel prose keeps consent, cap, used spend, and remaining budget in one coherent sentence', () => {
    expect(body).toMatch(
      /The dashboard reads this on page\s*load to render consent, cap, used spend, and remaining budget\./,
    );
    expect(body).not.toMatch(/render consent\s*\n\s*\n- cap \+ used/);
  });

  it("Status record shape pinned to the SHIPPED route fields: consent + cap_cents + used_this_month_cents + remaining_cents + refused_count_this_month + month_started_at. + 'used_this_month_cents sums usage_records.cost_usd_cents over the rows where record_type = \"agent_decomposer_bundled\" and recorded_at >= start_of_calendar_month (UTC)' — pinned so the status field names match account-bundled-llm.ts (the status route returns cap_cents/remaining_cents/month_started_at, NOT the settings record's monthly_cap_usd_cents) + record_type filter + UTC-calendar-month aggregation contract all stay documented (drift on aggregation would mis-bill across month boundaries)", () => {
    expect(body).toMatch(
      /"consent": true,\s*"cap_cents": 2000,\s*"used_this_month_cents": 450,\s*"remaining_cents": 1550,\s*"refused_count_this_month": 0,\s*"month_started_at":/,
    );
    expect(body).toMatch(
      /`used_this_month_cents` is the account's total bundled-LLM spend, in\s*cents, on agent-session turns since the start of the current UTC\s*calendar month \(`month_started_at`\)\./,
    );
  });

  it("PATCH validation framing pinned: 'consent — boolean.' + 'monthly_cap_usd_cents — integer; 0 to 10,000 ($100 ceiling). Negative values rejected with 400.' + 'Partial update — either field may be omitted, but at least one must be present; an empty body is rejected with 400.' — pinned so the integer/0-to-1M range + $10k ceiling + empty-body-400 contract (PatchBodySchema.refine) all stay documented", () => {
    expect(body).toMatch(/- `consent` — boolean\./);
    expect(body).toMatch(
      /- `monthly_cap_usd_cents` — integer; 0 to 10,000 \(\$100 ceiling\)\.\s*Negative values rejected with `400`\./,
    );
    expect(body).toMatch(
      /Partial update — either field may be omitted, but at least one of\s*`consent` \/ `monthly_cap_usd_cents` must be present\. An empty body\s*is rejected with `400`/,
    );
  });

  it('the budget-exhausted 402 example is exactly the body the server sends for a $20 cap that is used up — type, title, status, detail and the spent_cents / cap_cents extensions — and the page lists the 3 recovery paths the detail names', () => {
    const sent = new BundledLlmBudgetExhaustedError({
      spentCents: 2000,
      capCents: 2000,
    }).toProblem();
    expect(example402(body, sent.type), 'the page’s budget-exhausted example').toEqual(sent);
    expect(body).toMatch(/1\. Raise the cap via `PATCH \/v1\/account\/me\/bundled-llm-settings`/);
    expect(body).toMatch(
      /2\. Supply a BYOK key via the `x-byok-anthropic-api-key` header or\s*`PUT \/v1\/account\/me\/byok-anthropic-key`/,
    );
    expect(body).toMatch(/3\. Wait for the next calendar month/);
  });

  it('the consent-required 402 example is exactly the body the server sends — type, title, status and detail, with no extension fields — and the page says that on plans without bundled billing the fix is your own key, not opting in', () => {
    const sent = new BundledLlmConsentRequiredError().toProblem();
    expect(example402(body, sent.type), 'the page’s consent-required example').toEqual(sent);
    expect(body).toMatch(
      /On plans without bundled billing \(Team, Agency, API Starter\) this error does\s*not mean "opt in": opting in is refused on those plans\./,
    );
    expect(body).toMatch(
      /The SDK exposes the typed `BundledLlmConsentRequiredError` \(no\s*extension fields\)\./,
    );
  });

  it("Cross-language SDK extension-fields naming pinned: Python spent_cents/cap_cents + TS spentCents/capCents + Go SpentCents/CapCents. Drift on snake_case-vs-camelCase-vs-PascalCase would mismatch the SDK's native idiom in each language", () => {
    expect(body).toMatch(
      /Python:\s*`spent_cents` \/ `cap_cents`; TS: `spentCents` \/ `capCents`; Go:\s*`SpentCents` \/ `CapCents`/,
    );
  });

  it("Errors table roster pinned: 400 validation-failed + 401 unauthorized + 402 bundled-llm-budget-exhausted + 402 bundled-llm-consent-required, kept distinct so the SDKs' typed errors stay distinguishable. Neither these reads nor a turn return a 503 when bundled AI is unavailable: a turn with no key of its own gets 502 byok-anthropic-required, so the table carries no 503 row and the page says so.", () => {
    // V-1116 — the slug is `validation-failed`. ValidationError carries
    // PROBLEM_TYPES.ValidationFailed, and this table had named a type the
    // server cannot send; a client branching on it never matched.
    expect(body).toMatch(/\|\s*400 \| validation-failed\s*\|/);
    expect(body, 'the undeclared `validation` slug must not return').not.toMatch(
      /\|\s*400 \| validation\s*\|/,
    );
    expect(body).toMatch(/\|\s*401 \| unauthorized\s*\|/);
    expect(body).toMatch(/\|\s*402 \| bundled-llm-budget-exhausted/);
    expect(body).toMatch(/\|\s*402 \| bundled-llm-consent-required/);
    // 503 belongs to the agent-session turn route, not these reads.
    expect(body).not.toMatch(/\|\s*503 \| /);
    expect(body).toMatch(
      /The settings \+ status routes above do not return a `503`\. When\s*bundled-LLM is not available on the deployment, the agent-session turn\s*route returns `502 byok-anthropic-required` for a turn with no key of your\s*own; these reads keep working\./,
    );
    expect(body, 'the old 503-on-the-turn claim is back').not.toMatch(
      /the `503` is returned\s*on the \*\*agent-session turn\*\* route|returns the corresponding typed `503`/,
    );
  });

  it("Anthropic-no-training privacy commitment framing pinned: 'Bundled-LLM consent does NOT grant Driftstack any rights to train models on customer prompts. The current bundled-LLM provider is Anthropic Claude; per their API terms, customer data is not used for training.' + 'No prompt content is logged on Driftstack's side beyond what customers can read in their own session transcripts.' — pinned so the no-training-rights + Anthropic-API-terms + transcript-only-logging privacy contract all stay documented", () => {
    expect(body).toMatch(
      /- Bundled-LLM consent does NOT grant Driftstack any rights to\s*train models on customer prompts\. The current bundled-LLM\s*provider is Anthropic Claude; per their API terms, customer\s*data is not used for training\./,
    );
    expect(body).toMatch(
      /- No prompt content is logged on Driftstack's side beyond what\s*customers can read in their own session transcripts\./,
    );
  });
});
