---
layout: ../../layouts/LegalLayout.astro
title: Sub-processors
description: The third parties Driftstack uses to deliver the service, what each receives, where they store it, and the cadence on which we publish changes.
---

# Driftstack — Sub-processor List

**Version:** 1.0 · **Effective:** 2026-05-11

This page enumerates the sub-processors Driftstack engages to deliver
the Service. It is referenced from the
[Data Processing Addendum](dpa.md) (section 4 — "Sub-processors") and
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

- Vendors that only receive Driftstack's own business data (e.g. our
  accounting platform, our HR provider) — they don't touch customer
  workloads.
- Vendors a customer chooses to integrate with directly (e.g. their
  own Slack workspace receiving Driftstack webhooks). Those are
  Customer-controlled and outside our processing chain.
- Open-source software we self-host (Postgres, Redis, etc.). Self-
  hosted infrastructure runs inside our managed cloud accounts and is
  not a separate processor.

## Current sub-processors

| Sub-processor                                | Purpose                                                                                                                               | Data categories                                                                                                             | Location                                                                             | Transfer mechanism                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **Amazon Web Services, Inc.** (AWS)          | Primary compute + managed Postgres + S3-compatible object storage for the EU region.                                                  | Account data, session metadata, recording artifacts (encrypted at rest).                                                    | EU (Ireland), US-East (N. Virginia), AP-South (Mumbai) — pinned per customer region. | EU SCCs (2021/914) for transfers outside the EEA. |
| **Cloudflare, Inc.**                         | CDN, WAF, DDoS absorption, R2 object storage for recordings + WAL archives.                                                           | TLS-terminated request metadata, R2 object bytes (encrypted server-side).                                                   | Global edge; R2 buckets pinned to customer region.                                   | EU SCCs (2021/914).                               |
| **Stripe, Inc.**                             | Card-billing processor. Driftstack does not store PAN or full card data; tokenisation happens at Stripe's hosted checkout.            | Billing email, line-item description, amount, card token.                                                                   | US (with EU data residency for EEA customers via Stripe's regional offering).        | EU SCCs (2021/914); Stripe DPP in place.          |
| **NowPayments OÜ**                           | Crypto-payments processor for crypto-tier purchases.                                                                                  | Order ID, amount + currency, payment-pointer metadata. No customer identity is shared with NowPayments beyond the order ID. | Estonia (EEA).                                                                       | Intra-EEA transfer; no extra-EEA SCCs required.   |
| **Postmark / ActiveCampaign** (Wildbit, LLC) | Transactional email — receipts, password resets, security notifications.                                                              | Recipient email, message body, deliverability metadata.                                                                     | US.                                                                                  | EU SCCs (2021/914).                               |
| **Functional Software, Inc.** (Sentry)       | Engineering error monitoring. Driftstack PII-scrubs at the SDK level before events leave the application.                             | Stack traces, scrubbed request shape, account-id-only telemetry.                                                            | US (with the EU-region project for EEA customers).                                   | EU SCCs (2021/914).                               |
| **Hetzner Online GmbH**                      | Secondary compute (development + staging environments only). No production customer data.                                             | None in production. Dev/staging fixtures only.                                                                              | Germany / Finland.                                                                   | Intra-EEA.                                        |
| **LiveKit, Inc.**                            | Real-time audio/video transport for Browser Theatre live sessions (opt-in feature).                                                   | Session ID, room name, ephemeral SDP signalling.                                                                            | US + EU region pinning.                                                              | EU SCCs (2021/914).                               |
| **GitHub, Inc.** (Microsoft)                 | Source-control hosting for Driftstack's own codebase + the customer-facing CLI release pipeline. Does not process customer workloads. | None (code + release artifacts only).                                                                                       | US.                                                                                  | EU SCCs (2021/914).                               |

## What changed since the previous version

This page replaces the previous in-DPA appendix (DPA v0.9, section
4.2). The notable substantive changes are:

- **NowPayments added** for crypto-tier processing. Previously
  crypto-payment customers used a manual invoice flow; the crypto
  surface is now part of the Service proper.
- **LiveKit added** for the Browser Theatre live-session feature
  . Live sessions are off by default; the row above applies
  only to customers who turn the feature on.
- **Hetzner narrowed** to dev/staging only. Previously listed as a
  production secondary; production has been consolidated onto AWS.

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

- **2026-05-11 — v1.0.** Initial standalone publication. Inherits the
  vendor list from DPA v0.9 + adds NowPayments, LiveKit; narrows
  Hetzner to dev/staging.

## Contact

Questions about a specific sub-processor, our review process for
adding new ones, or the SCCs in force for a transfer:
[security@driftstack.dev](mailto:security@driftstack.dev). We reply
within one business day.

## Related

- [Data Processing Addendum](dpa.md)
- [Privacy Policy](privacy.md)
- [/docs/security-overview](/docs/security-overview) — overall
  security posture + controls.
- [/docs/data-residency](/docs/data-residency) — region-pinning + the
  no-cross-region-copy guarantee.
