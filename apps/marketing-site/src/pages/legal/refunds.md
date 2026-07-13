---
layout: ../../layouts/LegalLayout.astro
title: Refund Policy
description: Refund eligibility, timing, card refund mechanics, the non-refundable posture on crypto payments, prorated downgrades, and the SLA-credit relationship.
---

**Version:** 1.0 · **Effective:** 2026-05-11

This Refund Policy explains how Driftstack issues refunds for paid
Subscriptions and one-off charges. It is
incorporated into the [Terms of Service](/legal/terms/) by reference;
section 8.7 of the Terms is the binding contractual statement and
this policy expands on the operational mechanics.

## When you can get a refund

Refunds are issued in four scenarios:

1. **Failed delivery.** A charge succeeded but the corresponding
   feature was not made available to your account (e.g. the
   subscription tier didn't flip). Driftstack
   refunds the full amount automatically once detected; you do not
   need to request it.
2. **Service failure attributable to Driftstack.** Where Driftstack
   was unavailable beyond the SLA target for the billing cycle and
   the failure is not the customer's fault. Refund is processed as
   either an SLA credit (default — applied against the next invoice)
   or, on request, a cash refund net of any already-redeemed SLA
   credit. See section 8.7 of the Terms for the precise math.
3. **Within 14 days of first paid charge, no usage.** If you signed
   up, paid, and have not yet initiated a Session, you can request
   a full refund within 14 days. This is a discretionary policy, not
   a statutory right; we extend it because we'd rather you walk away
   happy than be stuck paying for something you didn't use.
4. **Mistaken duplicate charge.** Where Stripe / NowPayments issues
   a duplicate charge for the same Subscription period, we refund
   the duplicate.

We do **not** issue refunds in these scenarios:

- Mid-cycle cancellation of a monthly Subscription. The remainder of
  the cycle stays active; the next renewal is cancelled.
- Tier downgrade. The downgrade takes effect at the next renewal;
  no proration is issued for the unused portion of the current tier.
- Usage that exceeded customer expectations (e.g. LLM-bundled
  spend). We surface estimated cost in the [billing dashboard](/docs/cost-monitoring)
  so you can shape usage before the next cycle.

## How refunds work — card payments (Stripe)

1. You request the refund by emailing
   [`support@driftstack.dev`](mailto:support@driftstack.dev) (or via
   the support button in your dashboard).
2. We confirm eligibility and issue the refund through Stripe.
3. Stripe returns the funds to the original payment method. Timing:
   typically 5–10 business days, depending on your card issuer.
4. Your account is debited the refunded portion if you have an
   active Subscription affected by the refund.

## Crypto payments are non-refundable

**Crypto payments at Driftstack are non-refundable.** Once a crypto
payment settles on-chain it is committed for the billing period it
covers. This is the standard B2B SaaS posture; the rationale is:

- **Settlement irreversibility.** Crypto transfers are final once
  the network confirms them. We have no operational lever to claw
  back a confirmed payment, only to send a fresh outbound transfer
  — which introduces price-movement risk for both parties and
  network-fee waste.
- **Fraud + abuse asymmetry.** Card refunds rely on the issuer to
  reverse a charge if the cardholder disputes; that escalation path
  doesn't exist for crypto. Allowing crypto refunds at customer
  request would create a one-way return-policy attack surface.
- **Operational simplicity.** A non-refundable crypto policy keeps
  the support pipeline narrow + lets us price the crypto path
  competitively (we don't carry a refund-loss reserve into the unit
  economics).

What this means practically:

1. You can **cancel** your subscription anytime through the standard
   self-serve flow. Cancellation stops the next billing period's
   payment-request mint; it does not refund the current period.
2. The current billing period continues to be honoured until its end
   — you retain full access to the tier you paid for.
3. If you accidentally pay twice for the same period, that is a
   reconciliation question — contact support; we'll credit the
   duplicate against your next renewal rather than refund it
   on-chain.
4. If a payment lands but the service fails to provision (scenario
   1, "failed delivery"), the **service-failure remedy applies**:
   we re-provision the entitlement, no refund mechanics needed.

If your situation needs an actual cash refund, please pay via card
(Stripe) — card refunds follow the standard mechanics documented in
the section above.

For more on the crypto-payment lifecycle, see [`/pricing/crypto`](/pricing/crypto).

## Relationship to SLA credits

If your refund qualifies as an SLA credit (scenario 2 above), the
default is to apply it against your next invoice. SLA credits do not
expire; if you cancel before the next invoice, you can request the
credit out as cash. See section 8.7 of the Terms for the exact
calculation methodology.

## Disputes

If we deny a refund request and you disagree, escalation:

1. Email `support@driftstack.dev` with "refund dispute" in the
   subject line. We respond within 5 business days with the
   reasoning.
2. If the dispute is over a card charge and you remain unsatisfied,
   you can issue a chargeback through your card issuer. We will
   provide documentation to the issuer; depending on the outcome we
   may also terminate the account for chargeback-related abuse if
   the underlying charge was clearly legitimate.

We do not litigate refunds — they are low-stakes enough that
walking away is almost always cheaper than fighting it out. If you
think we got it wrong, write to support and we'll make it right.

## Changes to this policy

We may update this Refund Policy from time to time. The version
header above tracks the current version; prior versions are kept
in the [legal repository](https://github.com/driftstackdev/driftstack-api/tree/main/docs/legal)
for reference. Material changes are notified by email to active
Customers at least 30 days before the new version takes effect.
