---
layout: ../../layouts/DocLayout.astro
title: Data residency
description: Where Driftstack stores customer data — what is EU-resident, what can replicate or run outside the EU, the region account preference, and deletion.
---

# Data residency

This page covers where your data physically lives, what counts as
customer data for residency purposes, and what the `region` account
preference does. The one-line version: **customer data in our
databases is EU-resident; file objects and session execution are
not guaranteed to stay in the EU**, and the transfers that do
happen are covered by the EU's standard contractual clauses (SCCs)
and the EU-US Data Privacy Framework (DPF).

## The short answer

- The control plane — API servers and databases — runs in the EU
  (Hetzner in Germany for compute, Neon in Frankfurt for Postgres,
  Upstash in Frankfurt for the cache). Customer data in our
  databases — your account, profiles, audit logs, session
  metadata — is EU-resident.
- **File objects** (your avatar and other uploaded files) use
  Cloudflare's R2 storage network in its default jurisdiction,
  which replicates across EU + US regions. There is **no EU-only
  storage guarantee** for file objects.
- **Session execution** — the iPhone Safari fleet — runs on
  MacStadium hardware in the US, under SCCs + the EU-US DPF.
- The complete sub-processor list, with each provider's region and
  contractual transfer basis, is published at
  [driftstack.dev/trust/sub-processors](https://driftstack.dev/trust/sub-processors)
  and in the [DPA](https://driftstack.dev/legal/dpa).

## What lives where

| Data                                                    | Where                                         | Notes                                                                                      |
| ------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Account row (email, tier, slug, region preference)      | Postgres (Neon, Frankfurt)                    | MFA secrets are stored encrypted.                                                          |
| API keys                                                | Postgres (Neon, Frankfurt)                    | Stored as hashes; the plaintext key is never stored.                                       |
| Session metadata + event timeline                       | Postgres (Neon, Frankfurt)                    | Lifecycle rows and events.                                                                 |
| Profile metadata (name, archetype, description)         | Postgres (Neon, Frankfurt)                    |                                                                                            |
| Audit log                                               | Postgres (Neon, Frankfurt)                    | Append-only.                                                                               |
| Webhook endpoints + delivery log                        | Postgres (Neon, Frankfurt)                    |                                                                                            |
| File objects (avatars, uploads, stored profile state)   | Cloudflare R2                                 | Default jurisdiction; replicates across EU + US. Access is via short-lived presigned URLs. |
| Cache (auth cache, rate-limit counters, MFA challenges) | Redis (Upstash, Frankfurt)                    | Short-lived entries.                                                                       |
| Error monitoring                                        | Sentry, EU ingest region                      | `ingest.de.sentry.io`.                                                                     |
| Transactional email                                     | Postmark, EU sending region                   | Recipient address + template payload; SCCs + DPF cover the provider.                       |
| Card billing                                            | Stripe (Stripe Payments Europe Ltd, Ireland)  | We never see card numbers; Stripe may onward-transfer under SCCs + DPF.                    |
| Crypto payment processing                               | NowPayments (Estonia, EEA)                    | We hold the payment id + status; on-chain data stays on-chain.                             |
| Session execution fleet                                 | MacStadium (US)                               | SCCs + EU-US DPF.                                                                          |
| Optional AI agent (bundled or BYOK)                     | Anthropic (US)                                | Only when the AI feature is actually used in a session; SCCs + DPF.                        |
| Optional live video                                     | LiveKit (US; EU-preferred regional endpoints) | Only when a live view is explicitly started; SCCs + DPF.                                   |

## What stays in the EU

Database content: accounts, profile metadata, session metadata,
audit logs, webhook configuration and delivery records — on Neon
(Frankfurt) — and cache content on Upstash (Frankfurt). These are
EU-resident, full stop.

## What can leave the EU

- **File objects on R2** — Cloudflare's storage network can
  replicate outside the EU. If your threat model requires strict
  EU-only file storage, don't upload files you can't accept that
  for, and talk to us about your requirements before relying on
  anything stronger.
- **Session execution** — profile state is loaded onto the
  execution host for the life of a session, and session traffic
  between the API, the fleet, and your target site traverses
  MacStadium infrastructure in the US. Contractual basis: SCCs +
  EU-US DPF.
- **Optional features** — the AI agent (Anthropic, US) and live
  video (LiveKit, US endpoints) engage their providers only when
  you actually use them.
- **Payment processors** — Stripe and NowPayments hold the payment
  data they process under their own compliance regimes; we hold
  only the linkage ids.

## The `region` account preference

You can record a region preference (`us`, `eu`, or `apac`, or
`null` to unset) on your account — from **Settings → Region** in
the dashboard, or via the API:

```json
PATCH /v1/account/me
{ "region": "eu" }
```

For v1 the preference is **informational only**: every customer's
account data sits on EU-jurisdiction infrastructure regardless of
the value. It exists so that we can route accounts to a matching
region automatically once a multi-region rollout lands. Before any
of your data moves, you get 30 days' notice under the DPA's
Article 28 sub-processor change process, with the right to keep
your data in the EU or terminate the affected portion of the
service.

## Deletion + data subject requests

Deleting your account revokes access immediately — web sessions,
API keys, and webhook endpoints stop working at deletion time —
and stored data is purged within the retention windows disclosed in
the [DPA](https://driftstack.dev/legal/dpa) (the retention table
discloses a 30-day outer bound for post-termination deletion).
References held by payment processors are governed by their own
retention policies.

Data subject access requests (GDPR):
[privacy@driftstack.dev](mailto:privacy@driftstack.dev).

## Related

- [Sub-processor register](https://driftstack.dev/trust/sub-processors) — every provider, region, purpose, and transfer basis, with a change log
- [DPA](https://driftstack.dev/legal/dpa) — the binding data-processing terms
- [Privacy policy](https://driftstack.dev/legal/privacy)
- [Trust & security overview](https://driftstack.dev/trust/security-overview)
