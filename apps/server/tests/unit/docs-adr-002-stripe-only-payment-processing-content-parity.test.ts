// W550.A — drift guard for /docs/adr/ADR-002-stripe-only-payment-processing.md.
// Architectural deviation ADR. Drift here either weakens the
// Stripe-only-at-launch posture (would re-permit dual-processor
// design that doubles webhook + reconciliation + DPA Annex 3
// surface for a one-person team), drops the BTW reverse-charge +
// Stripe Meters + Customer Portal load-bearing rationale, or
// changes the 5 revisit-trigger inventory (would weaken the option
// to reactivate Mollie from the deferred file-116 spec).
//
//   • Status: Accepted, 2026-05-03, Architectural (approved deviation).
//   • Related V-entry: V-052 (Coinbase Commerce drop) + V-060.
//   • Related D-entry: D-027 — Stripe-only payment rail at launch.
//   • 5 Stripe surfaces: Billing + Tax + Webhooks + Meters +
//     Customer Portal.
//   • Mollie deferred (not abandoned) per revisit-trigger.
//   • driftstack_llm_tokens Stripe Meter per V-053 env-vars schema.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/adr/ADR-002-stripe-only-payment-processing.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W550.A /docs/adr/ADR-002-stripe-only-payment-processing.md content parity', () => {
  const body = read(LIB);

  it("Header + Status + Related-V + Related-D framing pinned: '# ADR-002 — Stripe-only payment processing at launch' + '**Status:** Accepted' + '**Date:** 2026-05-03' + '**Tier:** Architectural (approved deviation; vendor / structural)' + '**Related V-entry:** V-052 (Coinbase Commerce dropped from sub-processor list + legal docs), V-060 (this ADR + D-027 entry).' + '**Related D-entry:** D-027 — Stripe-only payment rail at launch.' — pinned so the ADR-002-Accepted-2026-05-03 + Tier-Architectural-approved-deviation + V-052-Coinbase-drop + V-060-ADR + D-027-Stripe-only-rail commitment survives", () => {
    expect(body).toMatch(/^# ADR-002 — Stripe-only payment processing at launch$/m);
    expect(body).toMatch(/\*\*Status:\*\* Accepted/);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-03/);
    expect(body).toMatch(
      /\*\*Tier:\*\* Architectural \(approved deviation; vendor \/ structural\)/,
    );
    expect(body).toMatch(
      /\*\*Related V-entry:\*\* V-052 \(Coinbase Commerce dropped from sub-processor list \+ legal docs\),/,
    );
    expect(body).toMatch(/V-060 \(this ADR \+ D-027 entry\)\./);
    expect(body).toMatch(/\*\*Related D-entry:\*\* D-027 — Stripe-only payment rail at launch\./);
  });

  it("Context — dual-processor Mollie-primary Stripe-backup deviation framing pinned: 'Mollie primary' + 'Dutch payment processor; iDEAL-native; EU-friendly underwriting' + 'Stripe backup' + 'international card coverage; metered billing primitives' + 'Stripe's EU payment-method coverage caught up.' + 'Solo-entrepreneur operational load.' + 'BTW reverse-charge mechanic' + 'metered billing for BYOK LLM line-item billing' + 'driftstack_llm_tokens' + 'Coinbase Commerce was earlier in the rail mix; dropped 2026-05-03 (V-052)' — pinned so the Mollie-primary-Stripe-backup-original + 4-constraint-rethink + BTW-reverse-charge + driftstack_llm_tokens-meter + Coinbase-Commerce-drop commitment survives", () => {
    expect(body).toMatch(/- \*\*Mollie primary\*\* \(Dutch payment processor; iDEAL-native;/);
    expect(body).toMatch(/EU-friendly underwriting; team familiarity from prior projects\)\./);
    expect(body).toMatch(/- \*\*Stripe backup\*\* \(international card coverage; metered billing/);
    expect(body).toMatch(/primitives; webhook \+ API maturity\)\./);
    expect(body).toMatch(/1\. \*\*Stripe's EU payment-method coverage caught up\.\*\*/);
    expect(body).toMatch(/2\. \*\*Solo-entrepreneur operational load\.\*\*/);
    expect(body).toMatch(
      /The third constraint — also load-bearing — is the \*\*BTW reverse-charge\*\*/,
    );
    expect(body).toMatch(/mechanic\./);
    expect(body).toMatch(
      /The fourth constraint is \*\*metered billing for BYOK LLM line-item billing\*\*\./,
    );
    expect(body).toMatch(/`driftstack_llm_tokens`/);
    expect(body).toMatch(
      /Coinbase Commerce was earlier in the rail mix; dropped 2026-05-03 \(V-052\)/,
    );
  });

  it("Decision — Stripe-only-at-launch + Mollie-deferred-not-abandoned + 5-surface inventory framing pinned: '**Use Stripe as the sole payment processor at launch.** Drop Mollie from the active rail list.' + 'deferred to the revisit triggers below**, not abandoned' + 'Stripe Billing for subscription management (per-tier price IDs from file 127).' + 'Stripe Tax for BTW reverse-charge handling.' + 'Stripe Webhooks for subscription lifecycle events' + 'Stripe Meters for BYOK LLM line-item billing (`driftstack_llm_tokens` per V-053 env-vars schema).' + 'Stripe Customer Portal for self-service plan changes + payment method updates.' — pinned so the Stripe-only-active + Mollie-deferred-not-abandoned + 5-surface (Billing + Tax + Webhooks + Meters + Customer Portal) + V-053-env-vars-schema commitment survives", () => {
    expect(body).toMatch(
      /\*\*Use Stripe as the sole payment processor at launch\.\*\* Drop Mollie from the active rail list\./,
    );
    expect(body).toMatch(/\*\*deferred to the revisit triggers below\*\*, not abandoned/);
    expect(body).toMatch(
      /- Stripe Billing for subscription management \(per-tier price IDs from file 127\)\./,
    );
    expect(body).toMatch(/- Stripe Tax for BTW reverse-charge handling\./);
    expect(body).toMatch(/- Stripe Webhooks for subscription lifecycle events/);
    expect(body).toMatch(
      /- Stripe Meters for BYOK LLM line-item billing \(`driftstack_llm_tokens` per V-053 env-vars schema\)\./,
    );
    expect(body).toMatch(
      /- Stripe Customer Portal for self-service plan changes \+ payment method updates\./,
    );
  });

  it("Consequences — Enables + Rules-out + Operational-cost framing pinned: '- Single webhook signing-secret rotation (V-023 webhook posture — one secret, not two).' + 'Single sub-processor in the DPA Annex 3 for payment processing (Stripe Payments Europe, Limited; Ireland).' + 'Metered BYOK LLM line-item billing via Stripe Meters (no custom invoicing layer needed).' + '**Rules out:**' + 'iDEAL / Bancontact / SEPA Direct Debit support that's specifically Mollie-routed.' + 'Mollie's friendlier small-team underwriting posture at sub-€10K monthly revenue.' + 'Single-vendor concentration risk on the payment rail.' — pinned so the V-023-single-webhook-secret + Stripe-Payments-Europe-Ireland-DPA + Stripe-Meters-no-custom-invoicing + Mollie-iDEAL/Bancontact-ruled-out + sub-€10K-friendlier-Mollie-rejected + concentration-risk-mitigated commitment survives", () => {
    expect(body).toMatch(
      /- Single webhook signing-secret rotation \(V-023 webhook posture — one secret, not two\)\./,
    );
    expect(body).toMatch(
      /- Single sub-processor in the DPA Annex 3 for payment processing \(Stripe Payments Europe, Limited; Ireland\)\./,
    );
    expect(body).toMatch(
      /- Metered BYOK LLM line-item billing via Stripe Meters \(no custom invoicing layer needed\)\./,
    );
    expect(body).toMatch(/\*\*Rules out:\*\*/);
    expect(body).toMatch(
      /- iDEAL \/ Bancontact \/ SEPA Direct Debit support that's specifically Mollie-routed\./,
    );
    expect(body).toMatch(
      /- Mollie's friendlier small-team underwriting posture at sub-€10K monthly revenue\./,
    );
    expect(body).toMatch(/- Single-vendor concentration risk on the payment rail\./);
  });

  it("Revisit triggers — 5-trigger inventory + Notes deferred-file-116-fallback + D-023 inherit framing pinned: '**Stripe declines underwriting at company onboarding.**' + 'Stripe `account.application.declined`' + '**Stripe Tax fails to handle a regulatory edge case**' + '**BYOK LLM billing volume warrants direct Anthropic billing relationship.**' + '**Stripe per-transaction fee structure changes adversely.**' + '**Customer concentration risk on Stripe.**' + 'The deferred file-116 dual-processor spec remains the documented fallback architecture; do not delete the spec from the parent driftstack repo.' + 'inherits from D-023 (webhook signing secret stored plaintext at rest, Stripe-style).' — pinned so the 5-revisit-triggers + account.application.declined-event + file-116-do-not-delete + D-023-inherit-webhook-plaintext commitment survives", () => {
    expect(body).toMatch(/- \*\*Stripe declines underwriting at company onboarding\.\*\*/);
    expect(body).toMatch(/Stripe `account\.application\.declined`/);
    expect(body).toMatch(/- \*\*Stripe Tax fails to handle a regulatory edge case\*\*/);
    expect(body).toMatch(
      /- \*\*BYOK LLM billing volume warrants direct Anthropic billing relationship\.\*\*/,
    );
    expect(body).toMatch(/- \*\*Stripe per-transaction fee structure changes adversely\.\*\*/);
    expect(body).toMatch(/- \*\*Customer concentration risk on Stripe\.\*\*/);
    expect(body).toMatch(
      /The deferred file-116 dual-processor spec remains the documented fallback architecture; do not delete the spec from the parent driftstack repo\./,
    );
    expect(body).toMatch(
      /D-023 now requires encrypted envelopes for Driftstack outbound-webhook secrets\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
