// W560.A — drift guard for /docs/architecture/moneybird-scoping.md.
// Workstream-E scoping doc 2026-05-03. Drift here either weakens the
// Stripe-Moneybird-3-system-source-of-truth boundary, drops the
// 4-revenue-category taxonomy (subscription MRR + trial-pack +
// BYOK markup + self-hosted prepaid), or loosens the implementation-
// gates (KvK + accountant + counsel reviews).
//
//   • Scoping doc, NOT implementation. Workstream E, 2026-05-03.
//   • 3-system source-of-truth: Driftstack DB + Stripe + Moneybird.
//   • V-052 sub-processor lock; only billing context flows.
//   • 4 revenue categories (subscription MRR + trial-pack ADR-003 +
//     BYOK markup + self-hosted prepaid).
//   • 4-region BTW handling via Stripe Tax.
//   • 3 sync patterns: A=webhook-bridge + B=batch + C=native-
//     marketplace-connector.
//   • OAuth2 production + PAT staging.
//   • 6 implementation gates including KvK + accountant + counsel.
//   • 8 open questions for founder + accountant + counsel review.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/moneybird-scoping.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W560.A /docs/architecture/moneybird-scoping.md content parity', () => {
  const body = read(LIB);

  it("Header + scoping-doc-not-implementation + 3-system framing pinned: '# Moneybird — integration scoping' + 'Status: scoping doc, not implementation.' + 'Implementation gates on KvK closure (BV registered → Moneybird' + 'Authored 2026-05-03 per Workstream E.' + 'three systems that need to agree on' + '**Driftstack DB (Postgres)** — accounts, subscriptions, sessions,' + '**Stripe** — payment instruments, charges, subscription state machine,' + 'metered billing for BYOK + overage, Stripe Tax computation.' + '**Moneybird** — invoices of record, ledger entries, BTW filings, tax' + 'returns submitted to the Belastingdienst.' — pinned so the scoping-doc-not-implementation + KvK-BV-Moneybird-gate + Workstream-E-2026-05-03 + 3-system-Driftstack-Stripe-Moneybird + Belastingdienst commitment survives", () => {
    expect(body).toMatch(/^# Moneybird — integration scoping$/m);
    expect(body).toMatch(/Status: scoping doc, not implementation\./);
    expect(body).toMatch(/Implementation gates on KvK closure \(BV registered → Moneybird/);
    expect(body).toMatch(/Authored 2026-05-03 per Workstream E\./);
    expect(body).toMatch(/three systems that need to agree on/);
    expect(body).toMatch(/\*\*Driftstack DB \(Postgres\)\*\* — accounts, subscriptions, sessions,/);
    expect(body).toMatch(
      /\*\*Stripe\*\* — payment instruments, charges, subscription state machine,/,
    );
    expect(body).toMatch(/metered billing for BYOK \+ overage, Stripe Tax computation\./);
    expect(body).toMatch(
      /\*\*Moneybird\*\* — invoices of record, ledger entries, BTW filings, tax/,
    );
    expect(body).toMatch(/returns submitted to the Belastingdienst\./);
  });

  it("V-052-sub-processor + source-of-truth-boundary framing pinned: '## Sub-processor classification' + 'Moneybird is on the V-052 sub-processor lock and listed at' + '`/trust/sub-processors`. Customer data flowing through Moneybird is' + 'limited to billing context (account email, invoice line items, totals,' + 'tax handling, billing address, VAT-ID where supplied).' + 'Session content, recordings, captures, API key material, and BYOK provider keys do' + '## Source-of-truth boundary' + '| Does this account exist?                  | Driftstack DB' + '| What tier is this account on?             | Driftstack DB' + '| Did this charge succeed?                  | Stripe' + '| What VAT/BTW was applied to this invoice? | Stripe (via Stripe Tax)' + '| What appears on the BV's books?           | Moneybird' + '| What was filed on the BTW return?         | Moneybird' + '| What's the lifetime revenue from acct X?  | Moneybird (audited side)' — pinned so the V-052-sub-processor-lock + billing-context-only + session/recording/captures-do-NOT-flow + 7-row-source-of-truth-table commitment survives", () => {
    expect(body).toMatch(/## Sub-processor classification/);
    expect(body).toMatch(/Moneybird is on the V-052 sub-processor lock and listed at/);
    expect(body).toMatch(/`\/trust\/sub-processors`\. Customer data flowing through Moneybird is/);
    expect(body).toMatch(/limited to billing context \(account email, invoice line items, totals,/);
    expect(body).toMatch(
      /tax handling, billing address, VAT-ID where supplied\)\. Session content,/,
    );
    expect(body).toMatch(/recordings, captures, API key material, and BYOK provider keys do/);
    expect(body).toMatch(/## Source-of-truth boundary/);
    expect(body).toMatch(/\| Does this account exist\?\s+\| Driftstack DB/);
    expect(body).toMatch(/\| What tier is this account on\?\s+\| Driftstack DB/);
    expect(body).toMatch(/\| Did this charge succeed\?\s+\| Stripe/);
    expect(body).toMatch(
      /\| What VAT\/BTW was applied to this invoice\? \| Stripe \(via Stripe Tax\)/,
    );
    expect(body).toMatch(/\| What appears on the BV's books\?\s+\| Moneybird/);
    expect(body).toMatch(/\| What was filed on the BTW return\?\s+\| Moneybird/);
    expect(body).toMatch(
      /\| What's the lifetime revenue from acct X\?\s+\| Moneybird \(audited side\)/,
    );
  });

  it("4-revenue-category framing pinned: '## Revenue categories' + 'Four distinct revenue streams need separate treatment' + '**Subscription MRR** — recurring revenue from API tier subscriptions' + '(Starter / Solo / Builder / Scale / Enterprise).' + 'subject to the V-070 pricing-restructure pass' + '**Trial-pack one-time revenue** (per ADR-003) — $2.99 one-time' + 'NOT counted toward MRR.' + '**BYOK LLM markup revenue** — metered overlay on Stripe Meter events' + '(`driftstack_llm_tokens` per V-053 env-var schema). Markup over the' + '\"service revenue\" or \"passthrough revenue net of passthrough cost\"' + '**Self-hosted contract revenue** — annual prepaid contracts. Counted' + 'toward MRR but on a separate \"Self-hosted MRR\" line' + 'recognised at purchase or' + 'amortised monthly per IFRS 15 / Dutch GAAP equivalent?' + 'Refunds (trial-pack within 14d if no sessions started, per the FAQ' — pinned so the 4-revenue-category (subscription-MRR-V-070-restructure + ADR-003-$2.99-trial-pack-NOT-MRR + BYOK-V-053-driftstack_llm_tokens + self-hosted-IFRS-15-amortise) + refund-credit-note commitment survives", () => {
    expect(body).toMatch(/## Revenue categories/);
    expect(body).toMatch(/Four distinct revenue streams need separate treatment/);
    expect(body).toMatch(
      /1\. \*\*Subscription MRR\*\* — recurring revenue from API tier subscriptions/,
    );
    expect(body).toMatch(/\(Starter \/ Solo \/ Builder \/ Scale \/ Enterprise\)\./);
    expect(body).toMatch(/Counted toward MRR\/ARR analytics\. \(Tier names \+ amounts are subject/);
    expect(body).toMatch(/to the V-070 pricing-restructure pass; this category survives any/);
    expect(body).toMatch(
      /2\. \*\*Trial-pack one-time revenue\*\* \(per ADR-003\) — \$2\.99 one-time/,
    );
    expect(body).toMatch(/NOT counted toward MRR\./);
    expect(body).toMatch(
      /3\. \*\*BYOK LLM markup revenue\*\* — metered overlay on Stripe Meter events/,
    );
    expect(body).toMatch(/\(`driftstack_llm_tokens` per V-053 env-var schema\)\. Markup over the/);
    expect(body).toMatch(/"service revenue" or/);
    expect(body).toMatch(/"passthrough revenue net of passthrough cost"\? Different ledger/);
    expect(body).toMatch(
      /4\. \*\*Self-hosted contract revenue\*\* — annual prepaid contracts\. Counted/,
    );
    expect(body).toMatch(/toward MRR but on a separate "Self-hosted MRR" line/);
    expect(body).toMatch(/recognised at purchase or/);
    expect(body).toMatch(/amortised monthly per IFRS 15 \/ Dutch equivalent\?/);
    expect(body).toMatch(/Refunds \(trial-pack within 14d if no sessions started, per the FAQ/);
  });

  it("BTW + 3-sync-pattern + OAuth2-PAT framing pinned: '## Per-region BTW handling' + '**B2B EU customer with valid VAT-ID** → reverse-charge applied; VAT' + 'not collected. VIES-validated at checkout.' + '**B2C EU customer** → VAT collected at customer's country rate.' + '**Customer outside EU** → no VAT collected.' + '**Driftstack BV (NL) selling to NL customer** → 21% domestic if B2C;' + '### Pattern A — Stripe → Moneybird via webhook + control-plane bridge' + 'Stripe webhook fires `invoice.finalized` (or `invoice.paid` for' + '### Pattern B — Scheduled batch sync' + '### Pattern C — Native Stripe ↔ Moneybird connector (if it exists)' + '**Recommendation pending verification**: Pattern C if available,' + 'Pattern A as fallback. Pattern B is too lagging for first-paying-' + 'customer year-end.' + '## Authentication: OAuth2 vs Personal Access Token' + '**OAuth2** (recommended for production)' + '**Personal Access Token** (acceptable for staging)' + '**Recommendation:** OAuth2 for production with scopes' + '`sales_invoices`, `purchase_invoices`, `documents`, `bank`, `time`' — pinned so the 4-region-BTW-VIES + 3-pattern-A/B/C-webhook/batch/native + C-then-A-fallback-B-too-lagging + OAuth2-prod-PAT-staging + 5-scope commitment survives", () => {
    expect(body).toMatch(/## Per-region BTW handling/);
    expect(body).toMatch(
      /- \*\*B2B EU customer with valid VAT-ID\*\* → reverse-charge applied; VAT/,
    );
    expect(body).toMatch(/not collected\. VIES-validated at checkout\./);
    expect(body).toMatch(/- \*\*B2C EU customer\*\* → VAT collected at customer's country rate\./);
    expect(body).toMatch(/- \*\*Customer outside EU\*\* → no VAT collected\./);
    expect(body).toMatch(
      /- \*\*Driftstack BV \(NL\) selling to NL customer\*\* → 21% domestic if B2C;/,
    );
    expect(body).toMatch(/### Pattern A — Stripe → Moneybird via webhook \+ control-plane bridge/);
    expect(body).toMatch(/Stripe webhook fires `invoice\.finalized` \(or `invoice\.paid` for/);
    expect(body).toMatch(/### Pattern B — Scheduled batch sync/);
    expect(body).toMatch(/### Pattern C — Native Stripe ↔ Moneybird connector \(if it exists\)/);
    expect(body).toMatch(/\*\*Recommendation pending verification\*\*: Pattern C if available,/);
    expect(body).toMatch(/Pattern A as fallback\. Pattern B is too lagging for first-paying-/);
    expect(body).toMatch(/customer year-end\./);
    expect(body).toMatch(/## Authentication: OAuth2 vs Personal Access Token/);
    expect(body).toMatch(/\*\*OAuth2\*\* \(recommended for production\)/);
    expect(body).toMatch(/\*\*Personal Access Token\*\* \(acceptable for staging\)/);
    expect(body).toMatch(/\*\*Recommendation:\*\* OAuth2 for production with scopes/);
    expect(body).toMatch(/`sales_invoices`, `purchase_invoices`, `documents`, `bank`, `time`/);
  });

  it("Sync-mechanics + 6-implementation-gates framing pinned: '## Sync mechanics — design notes' + '**Idempotency key:** the Stripe invoice ID (`in_xxx`) is the natural' + 'idempotency key for the Moneybird counterpart.' + '**Failure handling:** Moneybird API failures route to a dead-letter' + 'queue' + '**Schema drift detection:** monthly automated reconciliation' + '**Customer-data minimization:** the Moneybird invoice carries only' + '## Implementation gates' + '**KvK closure** — BV registered with the Belastingdienst' + '**Moneybird account opened** under the BV's legal name' + '**Accountant review** of the proposed Stripe ↔ Moneybird boundary.' + '**Counsel review** of the trial-pack revenue-recognition rule' + '**Pattern selection** — A vs B vs C decided after Moneybird' + '**OAuth2 client registered** with Moneybird (production only).' — pinned so the in_xxx-idempotency + DLQ + monthly-drift-recon + customer-data-min + 6-implementation-gate (KvK + Moneybird-acct + accountant + counsel + pattern-select + OAuth2-client) commitment survives", () => {
    expect(body).toMatch(/## Sync mechanics — design notes/);
    expect(body).toMatch(
      /- \*\*Idempotency key:\*\* the Stripe invoice ID \(`in_xxx`\) is the natural/,
    );
    expect(body).toMatch(/idempotency key for the Moneybird counterpart\./);
    expect(body).toMatch(
      /- \*\*Failure handling:\*\* Moneybird API failures route to a dead-letter/,
    );
    expect(body).toMatch(/queue/);
    expect(body).toMatch(/- \*\*Schema drift detection:\*\* monthly automated reconciliation/);
    expect(body).toMatch(
      /- \*\*Customer-data minimization:\*\* the Moneybird invoice carries only/,
    );
    expect(body).toMatch(/## Implementation gates/);
    expect(body).toMatch(/1\. \*\*KvK closure\*\* — BV registered with the Belastingdienst/);
    expect(body).toMatch(/2\. \*\*Moneybird account opened\*\* under the BV's legal name/);
    expect(body).toMatch(
      /3\. \*\*Accountant review\*\* of the proposed Stripe ↔ Moneybird boundary\./,
    );
    expect(body).toMatch(/4\. \*\*Counsel review\*\* of the trial-pack revenue-recognition rule/);
    expect(body).toMatch(/5\. \*\*Pattern selection\*\* — A vs B vs C decided after Moneybird/);
    expect(body).toMatch(
      /6\. \*\*OAuth2 client registered\*\* with Moneybird \(production only\)\./,
    );
  });

  it("8-open-question + Implementation-surface + 7-References framing pinned: '## Open questions' + '**Trial-pack revenue recognition.**' + '**BYOK markup revenue treatment.**' + '**Service revenue (gross)**' + '**Net revenue (passthrough)**' + '**Self-hosted prepaid annual contracts.**' + '**Refunds — credit-note workflow.**' + '**Moneybird Marketplace native Stripe connector — does it exist?**' + '**MRR / ARR computation source.**' + '**Billing address vs shipping address.**' + '**VAT-ID validation timing.**' + '## Implementation surface — what lands when' + '`apps/server/src/lib/moneybird.ts` — typed wrapper over Moneybird API' + '`apps/server/src/services/billing-sync.ts`' + '## References' + 'ADR-002 (Stripe-only payment processing)' + 'ADR-003 (paid trial pack)' + 'ADR-004 (pricing restructure to two-ladder concurrent-only)' + 'V-052 (Coinbase Commerce dropped from sub-processor list)' + 'V-053 (env-vars schema) — `MONEYBIRD_API_TOKEN` + `MONEYBIRD_ADMINISTRATION_ID`' + '`/trust/sub-processors` (V-068)' + '`docs/legal/dpa.md` Annex 3' — pinned so the 8-open-question + moneybird.ts-wrapper + billing-sync.ts + 7-References (ADR-002 + ADR-003 + ADR-004 + V-052 + V-053 + V-068 + DPA-Annex-3) commitment survives", () => {
    expect(body).toMatch(/## Open questions/);
    expect(body).toMatch(/1\. \*\*Trial-pack revenue recognition\.\*\*/);
    expect(body).toMatch(/2\. \*\*BYOK markup revenue treatment\.\*\*/);
    expect(body).toMatch(/\*\*Service revenue \(gross\)\*\*/);
    expect(body).toMatch(/\*\*Net revenue \(passthrough\)\*\*/);
    expect(body).toMatch(/3\. \*\*Self-hosted prepaid annual contracts\.\*\*/);
    expect(body).toMatch(/4\. \*\*Refunds — credit-note workflow\.\*\*/);
    expect(body).toMatch(
      /5\. \*\*Moneybird Marketplace native Stripe connector — does it exist\?\*\*/,
    );
    expect(body).toMatch(/6\. \*\*MRR \/ ARR computation source\.\*\*/);
    expect(body).toMatch(/7\. \*\*Billing address vs shipping address\.\*\*/);
    expect(body).toMatch(/8\. \*\*VAT-ID validation timing\.\*\*/);
    expect(body).toMatch(/## Implementation surface — what lands when/);
    expect(body).toMatch(
      /- `apps\/server\/src\/lib\/moneybird\.ts` — typed wrapper over Moneybird API/,
    );
    expect(body).toMatch(/- `apps\/server\/src\/services\/billing-sync\.ts`/);
    expect(body).toMatch(/## References/);
    expect(body).toMatch(/- ADR-002 \(Stripe-only payment processing\)/);
    expect(body).toMatch(/- ADR-003 \(paid trial pack\)/);
    expect(body).toMatch(/- ADR-004 \(pricing restructure to two-ladder concurrent-only\)/);
    expect(body).toMatch(/- V-052 \(Coinbase Commerce dropped from sub-processor list\)/);
    expect(body).toMatch(
      /- V-053 \(env-vars schema\) — `MONEYBIRD_API_TOKEN` \+ `MONEYBIRD_ADMINISTRATION_ID`/,
    );
    expect(body).toMatch(/- `\/trust\/sub-processors` \(V-068\)/);
    expect(body).toMatch(/- `docs\/legal\/dpa\.md` Annex 3/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
