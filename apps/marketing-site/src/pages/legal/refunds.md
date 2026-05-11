---
layout: ../../layouts/LegalLayout.astro
title: Refund Policy
description: Refund eligibility, timing, card + crypto refund mechanics, prorated downgrades, and the SLA-credit relationship.
---

# Driftstack — Refund Policy

**Version:** 1.0 · **Effective:** 2026-05-11

This Refund Policy explains how Driftstack issues refunds for paid
Subscriptions, Trial Pack purchases, and one-off charges. It is
incorporated into the [Terms of Service](terms.md) by reference;
section 8.7 of the Terms is the binding contractual statement and
this policy expands on the operational mechanics.

## When you can get a refund

Refunds are issued in four scenarios:

1. **Failed delivery.** A charge succeeded but the corresponding
   feature was not made available to your account (e.g. Trial Pack
   credit didn't unlock; subscription tier didn't flip). Driftstack
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
- Trial Pack credit not consumed within its 30-day window. The
  credit forfeits at expiry; the Trial Pack itself is non-refundable.

## How refunds work — card payments (Stripe)

1. You request the refund by emailing
   [`support@driftstack.dev`](mailto:support@driftstack.dev) (or via
   the support button in your dashboard).
2. We confirm eligibility and issue the refund through Stripe.
3. Stripe returns the funds to the original payment method. Timing:
   typically 5–10 business days, depending on your card issuer.
4. Your account is debited the refunded portion if you have an
   active Subscription affected by the refund.

## How refunds work — crypto payments (NowPayments)

Crypto refunds carry mechanical differences from card refunds and
deserve their own walkthrough:

1. You request the refund via support, supplying a forwarding
   address in the same asset you paid in (e.g. paid in BTC → BTC
   forwarding address). Cross-asset refunds (paid in BTC, refund in
   USD) are not supported — we don't run a foreign-exchange desk.
2. The founder issues the refund in NowPayments to the forwarding
   address. NowPayments broadcasts the on-chain refund transfer.
3. Once the refund transfer receives the asset's required
   confirmations, your account is debited the refunded portion and
   the order's status flips to `failed`. NowPayments charges a
   network fee for the refund transfer — that fee is netted out of
   the refunded amount.
4. Refund amount calculation: we refund the **USD-denominated price
   at order time**, not the realised crypto amount. If the asset
   moved in price between order and refund, that delta is not part
   of the refund (we are not in the business of speculation arbitrage,
   in either direction).

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
in the [legal repository](https://github.com/driftstack/driftstack-api/tree/main/docs/legal)
for reference. Material changes are notified by email to active
Customers at least 30 days before the new version takes effect.
