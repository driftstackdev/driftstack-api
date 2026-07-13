---
layout: ../../layouts/LegalLayout.astro
title: Sub-processors
description: The third parties Driftstack uses to deliver the service, what each receives, where they store it, and the cadence on which we publish changes.
---

**Version:** 1.1 · **Effective:** 2026-07-07

This page enumerates the sub-processors Driftstack engages to deliver
the Service. It is referenced from the
[Data Processing Addendum](/legal/dpa/) (section 4 — "Sub-processors") and
is the authoritative list at the date marked above. Customers under a
signed DPA can subscribe to the change-notification mailing list
described at the bottom.

The list below is intentionally short. Driftstack is a small,
infrastructure-focused company and we keep the vendor surface tight on
purpose — every additional sub-processor is one more place a breach
can originate and one more party we owe a contract to.

## What "sub-processor" means here

A sub-processor is a third party that processes Customer Personal Data
on Driftstack's behalf in the course of delivering the Service. This
list does **not** cover:

- Vendors that only receive Driftstack's own business data with no
  customer workload exposure (e.g. our HR provider).
- Vendors a customer chooses to integrate with directly (e.g. their
  own Slack workspace receiving Driftstack webhooks). Those are
  Customer-controlled and outside our processing chain.

## Current sub-processors

| Sub-processor      | Purpose                                                                                                                                                                                           | Data categories                                                                  | Location                                          | Transfer mechanism                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| **Hetzner Cloud**  | Compute infrastructure for the Driftstack control plane (production).                                                                                                                             | Account data, session metadata (encrypted at rest).                              | Falkenstein, Germany (EU).                        | EU-resident — no transfer required.                               |
| **Neon, Inc.**     | Managed Postgres for account, session, and audit data.                                                                                                                                            | Account data, session metadata, audit log.                                       | Frankfurt (EU).                                   | EU-resident — no transfer required.                               |
| **Upstash, Inc.**  | Managed Redis for auth-cache and rate-limit state.                                                                                                                                                | Auth-cache entries, rate-limit buckets, ephemeral session state.                 | Frankfurt (EU).                                   | EU-resident — no transfer required.                               |
| **Cloudflare R2**  | Object storage for customer-uploaded profile avatars, encrypted profile blobs, and public status-page snapshots.                                                                                  | Avatar bytes, encrypted profile blobs, status-page snapshots (operational JSON). | Default jurisdiction (data replicated EU + US).   | 2021 Standard Contractual Clauses + EU-US Data Privacy Framework. |
| **Postmark**       | Transactional email (signup verification, password reset, billing notifications, support correspondence).                                                                                         | Recipient email, message body, deliverability metadata.                          | EU sending region.                                | 2021 Standard Contractual Clauses + EU-US Data Privacy Framework. |
| **Sentry**         | Error monitoring and observability for the Driftstack control plane.                                                                                                                              | Stack traces, scrubbed request shape, account-id-only telemetry.                 | EU region (ingest.de.sentry.io).                  | EU ingest region — no transfer required for error data.           |
| **Stripe**         | Payment processing, subscription management, BYOK metered billing, BTW reverse-charge handling via Stripe Tax.                                                                                    | Billing email, line-item description, amount, card token.                        | Stripe Payments Europe Ltd (Ireland).             | 2021 Standard Contractual Clauses + EU-US Data Privacy Framework. |
| **Anthropic**      | Large language model for the optional AI agent feature, engaged in BYOK-proxy or opt-in bundled-LLM mode. Session data flows only when one of those modes is engaged on a turn.                   | Customer-supplied prompts + session context for the turn.                        | United States.                                    | 2021 Standard Contractual Clauses + EU-US Data Privacy Framework. |
| **Moneybird**      | Accounting and invoicing operations for Driftstack B.V.                                                                                                                                           | Invoice line items, billing identity.                                            | Netherlands (EU).                                 | EU-resident — no transfer required.                               |
| **MacStadium**     | Mac hardware hosting for the iPhone Safari session execution fleet.                                                                                                                               | Session execution state (transient).                                             | United States.                                    | 2021 Standard Contractual Clauses + EU-US Data Privacy Framework. |
| **NowPayments OÜ** | Cryptocurrency payment processing (BTC, LTC, USDT, USDC, ETH, XMR). Engaged only when a customer opts to pay with cryptocurrency at checkout; bypassed for Stripe-paying customers.               | Order ID, amount + currency, payment-pointer metadata.                           | Estonia (EU).                                     | EEA-internal — no transfer mechanism required.                    |
| **LiveKit, Inc.**  | WebRTC live-session signaling + media SFU for the optional "live session" feature, where a customer or Driftstack support views an in-progress browser session in real time. Disabled by default. | Session ID, room name, ephemeral SDP signalling, live media.                     | United States (regional endpoints; EU preferred). | 2021 Standard Contractual Clauses + EU-US Data Privacy Framework. |

## Production topology

The production control plane runs on **Hetzner Cloud** (compute) with
**Neon** (managed Postgres) for account / session / audit data,
**Upstash** (managed Redis) for auth-cache and rate-limit state, and
**Cloudflare R2** for object storage (avatars, encrypted profile
blobs, public status snapshots). The iPhone Safari session execution
fleet runs on **MacStadium** Mac hardware.

## What changed since the previous version

This page replaces the previous in-DPA appendix (DPA v0.9, section
4.2). The notable substantive changes are:

- **NowPayments added** for crypto-tier processing. Previously
  crypto-payment customers used a manual invoice flow; the crypto
  surface is now part of the Service proper.
- **LiveKit added** for the optional live-session feature. Live
  sessions are off by default; the row above applies only to
  customers who turn the feature on.

## Change notice + objection process

Driftstack publishes 30 days' notice before adding, removing, or
materially changing the role of any sub-processor. Notice is delivered
via:

1. An update to this page (the **Effective** date at the top bumps
   forward + a row is added to the changelog below).
2. An email to the address registered on
   `announcements@driftstack.dev` for each customer on a signed DPA.
3. A note in the in-dashboard changelog feed.

Customers under a signed DPA may object to a new sub-processor in
writing within the 30-day window. If we cannot make reasonable
accommodation (e.g. by isolating the customer's workload from the new
sub-processor) the customer may terminate the affected Services for
convenience with a pro-rated refund.

To opt into the announcement mailing list (recommended for all
DPA-bound customers), email
[security@driftstack.dev](mailto:security@driftstack.dev) with your
account ID + the email you want subscribed.

## Changelog

- **2026-07-07 — v1.1.** Cloudflare R2 row corrected. The previous
  row described the storage as "EU jurisdiction — no transfer
  required" and listed "session recordings and screenshots". In fact
  the R2 buckets use the default jurisdiction, which replicates data
  between the EU and the US, so a transfer mechanism applies (2021
  Standard Contractual Clauses + EU-US Data Privacy Framework), and
  the objects actually stored are customer-uploaded profile avatars,
  encrypted profile blobs, and public status-page snapshots (session
  recording is not a live feature). This is a correction of the
  register to describe existing processing accurately — the
  processing itself did not change, so no 30-day notice window
  applies.
- **2026-05-10 — v1.0.** Initial standalone publication. Inherits the
  vendor list from DPA v0.9 + adds NowPayments, LiveKit.

## Contact

Questions about a specific sub-processor, our review process for
adding new ones, or the SCCs in force for a transfer:
[security@driftstack.dev](mailto:security@driftstack.dev). We reply
within one business day.

## Related

- [Data Processing Addendum](/legal/dpa/)
- [Privacy Policy](/legal/privacy/)
- [/docs/security-overview](/docs/security-overview) — overall
  security posture + controls.
- [docs.driftstack.dev/reference/data-residency](https://docs.driftstack.dev/reference/data-residency/) — region-pinning + the
  no-cross-region-copy guarantee.
