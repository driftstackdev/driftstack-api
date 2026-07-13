# ADR-002 — Stripe-only payment processing at launch

**Status:** Accepted
**Date:** 2026-05-03
**Tier:** Architectural (approved deviation; vendor / structural)
**Related V-entry:** V-052 (Coinbase Commerce dropped from sub-processor list + legal docs), V-060 (this ADR + D-027 entry).
**Related D-entry:** D-027 — Stripe-only payment rail at launch.

## Context

Earlier planning artifacts in the parent driftstack repo (file 00, file 11 milestone 2.5, file 116) specced a **dual-processor billing architecture**:

- **Mollie primary** (Dutch payment processor; iDEAL-native; EU-friendly underwriting; team familiarity from prior projects).
- **Stripe backup** (international card coverage; metered billing primitives; webhook + API maturity).

The dual-processor design was driven by Mollie's strength in EU consumer payment methods (iDEAL, Bancontact, SOFORT, SEPA Direct Debit) plus Mollie's friendlier underwriting posture for Dutch entities at small scale. Stripe was held in reserve as the "if Mollie can't handle a customer's card / region" fallback.

Two further constraints shaped the rethink before the billing module landed:

1. **Stripe's EU payment-method coverage caught up.** Stripe natively handles iDEAL, Bancontact, SEPA Direct Debit, SOFORT (Q4 2024+), and EU-region cards. Mollie's EU-method advantage shrank to negligible by the time Driftstack started planning the billing module.
2. **Solo-entrepreneur operational load.** Running two payment processors requires two webhook handlers (event-source disambiguation), two reconciliation flows (matching customer payments to subscriptions across rails), two refund / chargeback / dispute SOPs, and twice the per-sub-processor amendment notice surface in the DPA. The maintenance cost is real for a one-person engineering team.

The third constraint — also load-bearing — is the **BTW reverse-charge** mechanic. EU B2B sales between VAT-registered entities use the reverse-charge mechanism: the seller does not collect VAT, the buyer self-assesses. Stripe Tax handles this correctly out of the box (region detection + reverse-charge invoice line + VAT-ID validation). Mollie does not (manual handling required).

The fourth constraint is **metered billing for BYOK LLM line-item billing**. Anthropic-bundled LLM usage is metered as a separate Stripe meter (`driftstack_llm_tokens`); customers see line-item billing for "platform subscription + LLM usage at markup." Stripe Billing's metered primitives are stronger; Mollie does not have a comparable native primitive.

Coinbase Commerce was earlier in the rail mix; dropped 2026-05-03 (V-052) due to closure for non-US/Singapore merchants and Coinbase Business unavailability in NL. Stripe-only fiat at launch is the consequent single-rail posture.

## Decision

**Use Stripe as the sole payment processor at launch.** Drop Mollie from the active rail list. The earlier "dual-processor with Mollie primary" design (file 116) is **deferred to the revisit triggers below**, not abandoned: if Stripe's underwriting flow declines the legal entity at KvK-onboarding time, Mollie reactivates per the deferred dual-processor spec.

Concretely:

- Stripe Billing for subscription management (per-tier price IDs from file 127).
- Stripe Tax for BTW reverse-charge handling.
- Stripe Webhooks for subscription lifecycle events (created / updated / cancelled / past_due / payment_failed / payment_succeeded).
- Stripe Meters for BYOK LLM line-item billing (`driftstack_llm_tokens` per V-053 env-vars schema).
- Stripe Customer Portal for self-service plan changes + payment method updates.

## Consequences

**Enables:**

- Single webhook signing-secret rotation (V-023 webhook posture — one secret, not two).
- Single reconciliation flow.
- Single sub-processor in the DPA Annex 3 for payment processing (Stripe Payments Europe, Limited; Ireland).
- Stripe Tax handles BTW reverse-charge correctly without per-customer manual VAT logic.
- Metered BYOK LLM line-item billing via Stripe Meters (no custom invoicing layer needed).
- Stripe's hosted Customer Portal eliminates a chunk of self-service UI work (payment method update, invoice download, cancellation flow are all hosted).

**Rules out:**

- iDEAL / Bancontact / SEPA Direct Debit support that's specifically Mollie-routed. Stripe's native handling of these methods covers the same customer surface, but at slightly higher per-transaction fees than Mollie's NL-domestic rates.
- Mollie's friendlier small-team underwriting posture at sub-€10K monthly revenue. If Stripe declines underwriting at company onboarding, the revisit trigger fires.

**Operational cost accepted:**

- Higher Stripe per-transaction fees vs Mollie for NL-domestic iDEAL transactions (~0.4% delta on average; meaningful at scale, immaterial at v1 volume).
- Single-vendor concentration risk on the payment rail. Mitigated by the revisit trigger structure: if Stripe's account is suspended, the customer's subscription state is still reconstructible from the local `subscriptions` table + Stripe webhook history; Mollie can be reactivated within ~2 weeks of decision.

## Alternatives considered

### Mollie-primary + Stripe-backup (the planned design — files 00 / 11 / 116)

- **Pro:** Mollie's NL-domestic iDEAL fees are competitive; Mollie's underwriting is friendlier for small teams at small scale; the parent driftstack planning artifacts had this in the spec.
- **Con:** dual webhook + reconciliation flow doubles maintenance; Mollie does not handle BTW reverse-charge natively; Mollie has no equivalent of Stripe Meters for BYOK LLM line-item billing; the EU-payment-method advantage that Mollie historically had has narrowed substantially as Stripe's EU coverage matured.
- **Why rejected:** the operational doubling cost is real for a small engineering team, and Stripe's coverage closes the gap that justified Mollie-primary in the first place. Holding Mollie in reserve via the revisit trigger preserves the option without paying the day-zero cost.

### Mollie-only (no Stripe)

- **Pro:** simplest single-vendor posture; competitive NL-domestic fees.
- **Con:** no BTW reverse-charge automation; no metered-billing primitives for BYOK LLM; weaker international card coverage; weaker Customer Portal.
- **Why rejected:** the BTW + metered-billing gaps would force a custom invoicing + tax layer, which is more work than the Stripe-only posture saves.

### Adyen / Braintree / Checkout.com

- **Pro:** enterprise-grade, EU-native (Adyen is NL).
- **Con:** higher minimum-volume requirements + harder underwriting than Stripe at small-team stage; less developer-friendly API + docs; no metered-billing primitive comparable to Stripe Meters; more upfront integration work.
- **Why rejected:** all three target enterprise scale; not a fit for v1.

## Revisit triggers

Re-evaluate this decision if **any** of the following fires:

- **Stripe declines underwriting at company onboarding.** Trigger event: Stripe `account.application.declined` event during the legal entity's account creation flow (post-KvK, when live keys are provisioned). If Stripe declines, Mollie reactivates per the deferred file-116 dual-processor spec; customer-facing legal text updates per the DPA Art 28(2) sub-processor amendment mechanism with appropriate notice period.
- **Stripe Tax fails to handle a regulatory edge case** (e.g., new EU member state with non-standard VAT rules; Brexit-style post-Brexit recalibration). Trigger event: a tax authority audit query that Stripe Tax cannot answer correctly + counsel sign-off that the gap is material.
- **BYOK LLM billing volume warrants direct Anthropic billing relationship.** Trigger metric: monthly BYOK volume above the threshold where Anthropic offers direct enterprise pricing better than reseller markup via Stripe Meters.
- **Stripe per-transaction fee structure changes adversely.** Trigger event: Stripe price increase >10% on the EU per-card or iDEAL rate.
- **Customer concentration risk on Stripe.** If a single customer's monthly volume exceeds 25% of total Driftstack revenue and Stripe's KYC + AML posture creates uncertainty around that customer's account, a backup rail becomes load-bearing for business continuity. Trigger metric: customer concentration ratio computed monthly.

## Notes

The deferred file-116 dual-processor spec remains the documented fallback architecture; do not delete the spec from the parent driftstack repo. If the Stripe-decline trigger fires, the Mollie reactivation path is to (1) provision a Mollie API key + webhook endpoint, (2) wire the existing webhook handler scaffolding behind a `provider` discriminator, (3) update the DPA Annex 3 + Privacy Policy sub-processor table, (4) issue Art 28(2) amendment notice to existing customers with the standard 30-day notice period, (5) version-bump the legal documents (minor: forces re-acceptance under conservative posture).

The Stripe webhook signing-secret rotation cadence remains independent; D-023 now requires encrypted envelopes for Driftstack outbound-webhook secrets.
