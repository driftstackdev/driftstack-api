# Driftstack — Legal-document changes log

This file is the authoritative record of every change to a Driftstack
legal document (Privacy Policy, Terms of Service, DPA, Acceptable Use
Policy, Definitions). Each entry MUST be added in the same commit that
makes the legal change.

The format is intentionally lightweight — Section number + one-line
summary + the V-NNN engineering slice that drove it. The git history
on the legal-document files is the canonical diff; this file is the
human-readable changelog Customers can review without crawling git.

Per V-293 methodology, every feature commit that touches a legal
surface (PII, sub-processor, data-transfer, retention, security
posture, customer-facing service description) MUST also append an
entry here. The CI sub-processor mirror linter (V-271) catches DPA
Annex 3 ↔ marketing-site sub-processor table drift; this changelog
catches everything else.

When the next material revision ships, the **Privacy Policy Section
15** "Updates to this Privacy Policy" gets a new dated entry that
references the corresponding rows in this log.

---

## 2026-07-17 — Privacy, DPA, Terms, and Definitions v1.1 (product + storage truth)

- **Version / effective date:** the canonical and customer-facing
  Privacy Policy, DPA, Terms of Service, and shared Definitions
  advance together from version 1.0 to version 1.1, effective
  2026-07-17.
- **Privacy Policy §3.4 / §3.11 / §9:** corrected the implemented
  storage boundary. Desktop recordings are local NDJSON files in the
  GUI Client's app data directory on Customer's device and are not
  uploaded to Driftstack's API, control plane, or Cloudflare R2.
  Driftstack has no API recording endpoint and no cloud recording-
  retention window. API screenshot, DOM snapshot, and PDF Capture
  artifacts are returned inline and are not retained by the Capture
  endpoint. Live-session media remains ephemeral and is dropped on
  session end.
- **DPA §1 / §2 / §3.1 / §11 and Annex 1:** removed the nonexistent
  optional cloud-Recording processing purpose and configurable
  retention instruction. The processing description now covers the
  implemented ephemeral live-media and inline Capture paths while
  making the Customer-controlled device-local recording boundary
  explicit. The Controller / Processor allocation, Special Category
  Data obligations, no-training commitment, Customer-Provided Secret
  retention, and all Article 28 obligations remain unchanged.
- **Terms of Service §3:** the API now promises Session and Capture
  artifacts only. The live-session paragraph retains the LiveKit,
  explicit-support-authorisation, ephemeral-media, and encrypted-in-
  transit commitments while accurately describing local desktop
  recordings and inline Capture artifacts. It also corrects the
  former unimplemented application-level end-to-end-encryption claim:
  LiveKit receives, processes, and forwards the media as a Sub-
  processor; Driftstack does not currently provide application-level
  end-to-end encryption through the SFU.
- **Shared Definitions:** removed the pending-API placeholder, obsolete
  price and API-key-scope enumerations, nonexistent cloud Recording
  storage, and false EU-only R2 jurisdiction. Recording now means the
  desktop-local NDJSON artifact; Capture is inline and unretained; R2
  purpose and transfer posture match the live Sub-processor register.
  The Fees definition now reflects the implemented bundled-LLM
  included-service budget rather than inventing a separately itemized
  metered charge.
- **Bundled-LLM commercial wording:** the public bundled-LLM reference,
  comparison page, and Sub-processor purposes now distinguish the
  enforced 10-cent-per-standard-turn included-service accounting value
  from Stripe invoice items. No price, budget enforcement, provider
  data flow, consent gate, BYOK contract, or invoice was changed.
- **Sub-processors / transfers:** no Sub-processor, transfer
  mechanism, or R2 processing category changed. Cloudflare R2 remains
  limited to the already-disclosed customer-uploaded avatars,
  encrypted profile blobs, and public status snapshots; LiveKit
  remains the conditional live-session media Sub-processor.
- **Review:** this is a truth correction to the documented existing
  product boundary, not a new processing activity or retention
  program, and remains subject to final counsel review before launch.

## 2026-07-07 — S43 sub-processor register correction (founder-approved)

- **DPA Annex 3 (sub-processors table)**: Cloudflare, Inc. location
  cell corrected from "US (corp); EU jurisdiction (data)" to
  "US (corp); R2 default jurisdiction (data replicated EU + US)".
  Ground truth (DNS + production-box verified): the R2 buckets use
  the default jurisdiction, which replicates data between the EU and
  the US. The transfer-mechanism cell (2021 SCCs Module 2 + EU-US
  DPF) was already correct and is unchanged — the row now discloses
  that the mechanism actually applies rather than claiming no
  transfer occurs. Applied to both copies (`docs/legal/dpa.md`
  canonical + `apps/marketing-site/src/pages/legal/dpa.md`
  customer-facing); the marketing copy's Annex 3 "Region preference
  vs. region routing" paragraph is scoped the same way (database
  data EU-resident; R2 file objects replicate EU + US under the
  listed mechanism).
- **Sub-processor register** (`apps/marketing-site/src/pages/legal/sub-processors.md`
  v1.0 → v1.1 + `apps/marketing-site/src/data/sub-processors.ts`,
  rendered at /trust/sub-processors): Cloudflare R2 row corrected in
  lockstep — region "EU jurisdiction" → "Default jurisdiction (data
  replicated EU + US)", transfer mechanism "no transfer required" →
  2021 SCCs + EU-US DPF, and the purpose/data categories corrected
  to the objects actually stored (customer-uploaded profile avatars,
  encrypted profile blobs, and public status-page snapshots — not
  browser-session media or Capture responses; desktop recording files
  stay on the Customer device and Capture bytes are returned inline).
  `SUB_PROCESSOR_REGISTER_LAST_UPDATED` bumped to
  2026-07-07; a `material_change` correction entry added to the
  public change log. V-271 mirror linter unchanged (names did not
  change) and re-run green.
- **No new sub-processor / no 30-day notice window**: the processing
  itself did not change — the register's description of it did. This
  is a correction to disclose existing processing accurately, not
  the engagement of a new sub-processor or a change in an existing
  sub-processor's actual role.
- **No ToS / AUP / Definitions / Privacy Policy update in this
  slice**: the Privacy Policy §7 Cloudflare row carries the same
  stale "EU jurisdiction selected" description and is flagged for a
  follow-up under its own Section 15 update conventions.

## 2026-05-09 — V-353 + V-359 + V-298a + V-352b cycle disclosure refresh

- **Privacy Policy §3.2 (Authentication data)**: extended the "What"
  list to disclose the optional second-factor enrollment state when
  Customer opts into MFA. Specifically: AES-256-GCM-encrypted TOTP
  secret (plaintext exists only in memory during verification),
  10 scrypt-hashed single-use recovery codes (raw codes shown once
  at enrollment), and the per-session `mfa_satisfied_at` timestamp
  used to gate sensitive operations. Same legal basis (Art 6(1)(b)
  - 6(1)(c) Art 32 security) — no new sub-processor.
- **No DPA / sub-processor change**: MFA data lives entirely in the
  existing Postgres sub-processor (Neon, EU Frankfurt). No new
  vendor relationship; the recovery-code KDF is the same scrypt
  used for API keys.
- **No retention change**: MFA state is deleted with the account
  per existing §6 retention schedule. Disabling MFA via DELETE
  /v1/account/mfa clears the row + recovery codes immediately.
- **No ToS / AUP / Definitions update**: MFA is a security feature
  on top of the existing authentication relationship; no new
  processing purpose, no new data subject, no new transfer.

This entry batches the disclosure refresh for the customer-facing
work that landed during the 2026-05-09 cycle: V-353 (MFA TOTP), V-359
(webhook secret rotation — server-side encryption stays under the
existing same-vendor stack; no disclosure change), V-298a (account
slug — slug is Customer-chosen text in an existing column, no new
vendor), V-352b avatars already disclosed in the prior 2026-05-08
entry.

## 2026-05-08 — V-352b (customer-uploaded avatars)

- **Privacy Policy §3.1 (Account data)**: extended the "What" list to
  include the optional Customer-uploaded profile avatar, with an
  inline cross-reference to §17 / DPA Annex 3 since the bytes are
  stored in the existing Cloudflare R2 sub-processor.
- **DPA Annex 3 / sub-processor register**: Cloudflare R2 row purpose
  text expanded from an earlier, inaccurate browser-media storage
  description to also cover public status-page snapshots and
  customer-uploaded profile avatars. That browser-media description
  did not reflect implemented storage and is superseded by the
  2026-07-17 v1.1 correction; R2 stores only the object categories
  disclosed there. The sub-processor itself does not change — the
  storage vendor and transfer mechanism are the same existing object-
  storage scope. Per V-294 methodology this counts as a disclosure-
  scope update on an already-disclosed sub-processor, not a new sub-
  processor; no Art 28(2) 30-day notice is triggered.
- `SUB_PROCESSOR_REGISTER_LAST_UPDATED` bumped to 2026-05-08.
- **No ToS / AUP / Definitions update**: avatars are an optional
  Customer Data field with no new retention category (deleted with
  the account row per existing §6 schedule), no new legal basis, and
  no new processing purpose beyond rendering the dashboard / GUI
  identity row.

## 2026-05-07 — V-295c (status page launch)

- **Privacy Policy §3.9 (new)**: added "Status-page data" subsection
  describing the access-log scope, legal basis (Art 6(1)(f) legitimate
  interest), the no-PII-shown promise of the status page itself, the
  probe-history retention (30 days), and the no-cookies posture for
  status.driftstack.dev. Driven by V-295b probe history + V-295c CF
  Pages mirror.
- **No new sub-processor**: the status page is served from Cloudflare
  Pages, which is already enumerated in DPA Annex 3 (CDN +
  Pages-static-hosting). The probe data lives in the same Postgres
  cluster (Hetzner) that already holds operational data. No change to
  the sub-processor list; sub-processor mirror linter unchanged.
- **No DPA / ToS / AUP / Definitions update**: the status page exposes
  Driftstack-operational data only — no Customer Data, Account Data,
  or Recording content. No processing-purpose, retention category, or
  data-subject right changes. Reviewed and confirmed during V-295c1.

## 2026-05-07 — V-295c2 (R2 fallback)

- **No legal-document text changes**. V-295c2 introduces a separate
  R2 bucket (`R2_BUCKET_PUBLIC`) holding `status/incidents-public.json`
  used as a fallback source when the live API endpoint is unreachable.
  The bucket holds operational JSON only (incident snapshots) — no
  Customer Data, no Account Data, no Recording content. The same
  Cloudflare R2 sub-processor row in DPA Annex 3 covers it (storage
  vendor doesn't change; only the bucket-name configuration differs).
  Reviewed against Privacy §3.9 (added in V-295c1) — wording already
  permits the fallback because the data shown is the same data the
  live API surfaces.

## 2026-05-07 — V-295c3 (status-page email subscriptions)

- **Privacy Policy §3.10 (new)**: added "Status-page email
  subscriptions" subsection. Documents: data shape (email + opaque
  tokens), legal basis (Art 6(1)(a) consent via double-opt-in),
  source, retention (active subscription + 90 days post-unsubscribe
  tombstone), recipients (Postmark for delivery), no-cookies posture.
- **No new sub-processor**: Postmark already enumerated in DPA
  Annex 3 for transactional email; status-page subscriber emails
  fall under the same processor purpose. Sub-processor mirror
  linter unchanged (10 ↔ 11).
- **No DPA / ToS / AUP / Definitions update**: notification emails
  are operational status messages, not marketing. Consent is
  obtained per-purpose (the subscribe form text is the only thing
  the visitor signs up for); no overlap with marketing/sales scope
  on driftstack.dev.
- **No tombstone-purge job yet**: the 90-day post-unsubscribe purge
  promised in Privacy §3.10 is not yet implemented as a scheduled
  job. To be wired in V-295c3-followup before public launch (the
  status site is gated behind no-traffic until then; Privacy §3.10
  is accurate forward-looking).

## 2026-05-08 — V-313 (legal placeholder cleanup post-V-295 launch)

- **ToS §9.3 (Maintenance)**: replaced `(placeholder: status.driftstack.dev)`
  with the live URL `<https://status.driftstack.dev>` plus a sentence
  noting subscription is available via the form on the status page.
  V-295c1 status site is live; the placeholder language is no longer
  accurate.
- **AUP §4 (Reporting + abuse mechanism)**: removed the parenthetical
  "(placeholder address; production address may differ)" qualifier on
  `abuse@driftstack.dev`. The address is the production address.
- **Both ToS + AUP edits applied to both copies**: `docs/legal/*.md`
  (canonical) and `apps/marketing-site/src/pages/legal/*.md`
  (customer-facing). The two surfaces stay in sync manually until a
  build-time sync script lands.
- **No new sub-processor / no DPA / no Privacy update**: this slice is
  pure language cleanup; no new processing surface.

## 2026-05-08 — V-306a (LiveKit live-session sub-processor + Privacy + ToS)

- **DPA Annex 3 (sub-processors table)**: added "LiveKit, Inc.
  (US, Delaware) — conditional, opt-in only" row. Role: WebRTC live-
  session signaling + media SFU. Transfer mechanism: 2021 SCCs Module
  2 + EU-US DPF. Engaged only when Customer or Driftstack support
  explicitly initiates a live-session view; disabled by default.
- **Privacy Policy §3.11 (new)**: "Live-session media (optional,
  opt-in only)". Documents the data flowing through the live-session
  pipeline (WebRTC frames, screen-coordinate metadata, optional audio,
  LiveKit room id, connection metadata) plus the explicit non-storage
  promise (frames drop on session end; durable copy only via the
  existing V-054 Recording feature). The original entry described
  application-level end-to-end encryption as enabled, but that
  configuration was not implemented; the 2026-07-17 v1.1 correction
  supersedes both claims with desktop-local recording and encrypted-
  in-transit truth.
- **Privacy Policy §7 (Sub-processors table)**: matching new row.
- **Terms of Service §3 (The Service)**: extended with a "Live-
  session viewing (optional, opt-in)" paragraph. Documents ephemeral
  semantics and the support-impersonation gate requirement. Its
  original application-level encryption wording is superseded by the
  2026-07-17 v1.1 encrypted-in-transit correction.
- **Marketing-site sub-processors data**: matching public-facing
  entry. V-271 mirror linter passes at 12 ↔ 13.
- **No engineering work in this slice**: V-306b (server signaling),
  V-306c (GUI capture), and V-306d (admin viewer) will wire the
  actual WebRTC pipeline. Legal scaffolding lands first per V-293
  methodology.

## 2026-05-08 — V-308a (NowPayments crypto sub-processor + ToS clause)

- **DPA Annex 3 (sub-processors table)**: added "NowPayments OÜ
  (Estonia) — conditional, opt-in only" row. Role: cryptocurrency
  payment processing (BTC, LTC, USDT, USDC, ETH, XMR). Transfer
  mechanism: EEA-internal (Estonia). Engaged only when Customer opts
  to pay with cryptocurrency at checkout; bypassed entirely for
  Stripe-paying Customers.
- **Privacy Policy §3.6 (Billing data)**: extended with a
  "Cryptocurrency payments (optional, opt-in only)" subsection.
  Documents what data NowPayments processes (invoice id, blockchain
  tx hash, currency, amounts, destination wallet), explicit promise
  Driftstack does not retain Customer wallet addresses, and the
  bypass invariant for Stripe-paying customers.
- **Privacy Policy §7 (Sub-processors table)**: matching new row.
- **Terms of Service §8.3**: extended with §8.3(5) crypto-payment
  terms covering rate-quote window, finality, network-fee
  responsibility, refund policy (original currency to original
  sender), under-payment handling, switch-payment-method.
- **Marketing-site sub-processors data** (`apps/marketing-site/src/data/sub-processors.ts`):
  matching public-facing entry added so the V-271 sub-processor
  mirror linter stays green (now 11 public ↔ 12 DPA, was 10 ↔ 11;
  the +2 vs +1 split is the documented Stripe-EU + Stripe-Inc DPA
  split that resolves to one public "Stripe" row).
- **No engineering work in this slice**: V-308b/c/d will wire the
  sandbox webhook handler (apps/server), customer checkout flow
  (apps/customer-dashboard), and admin reconciliation UI
  (apps/admin-panel) once founder creates the NowPayments account
  and supplies sandbox API keys. The legal scaffolding lands first
  per V-293 methodology so the engineering can ship under approved
  documents from day one.

## 2026-05-08 — V-297 (audit-log export for data portability)

- **Privacy Policy §10 (data subject rights)** updated. Article 20
  paragraph extended with concrete language describing the new
  self-service export at `/v1/account/audit-log/export` (CSV + JSON,
  10,000-row ceiling per export). The right to portability has always
  been GDPR-required; V-297 makes it self-service rather than an
  email-to-privacy@driftstack.dev request flow. Reduces customer
  friction + Driftstack's ad-hoc fulfillment burden.
- **No new sub-processor**: the export is generated server-side from
  Driftstack's own Postgres + streamed to the calling client. No new
  external recipients of Personal Data. Sub-processor mirror linter
  unchanged (10 ↔ 11).
- **No DPA / ToS / AUP / Definitions update**: the export endpoint
  surfaces customer-scoped audit data the customer already has read
  access to via /v1/account/audit-log; portability is just a
  bulk-format wrapper. No processing-purpose, retention, or data-
  subject-right changes. Reviewed and confirmed.

## 2026-05-08 — V-327 (renewal-reminder email lifecycle dispatch)

- **Privacy Policy §3.6 (Billing data)** extended with a
  "Renewal-reminder emails" paragraph disclosing the new outbound
  trigger: Stripe's `invoice.upcoming` webhook (~7 days before each
  recurring invoice generates) fans out one `billing-renewal-reminder`
  email per upcoming invoice via Postmark. Customers can opt out via
  the dashboard email preferences page; Stripe's contractual
  notification (actual charge confirmation) remains non-opt-outable.
- **No new sub-processor**: Postmark + Stripe were both already in
  the sub-processor list for these data flows. Sub-processor mirror
  linter unchanged.
- **No DPA / ToS / AUP / Definitions update**: the trigger is a new
  outbound-email occasion within the existing transactional-email
  category already covered. No retention or processing-purpose
  changes.
- **Engineering surface**: V-327 wires `AccountLifecycleService.
handleRenewalReminder` (mirror of `handleTierChanged`'s pattern)
  - dispatches from the Stripe webhook handler's `invoice.upcoming`
    case; the lifecycle event carries amount/currency/renewalDate +
    the source `invoice.upcoming` event id. Mirrored to
    `apps/marketing-site/src/pages/legal/privacy.md`.

- 2026-07-07 (S49) — Privacy Policy §7 sub-processor table: Cloudflare
  row corrected to match the S43 register correction (same processing,
  corrected description): R2 stores customer-uploaded avatars,
  encrypted profile blobs, and public status snapshots (not
  "Recordings" — never shipped); location is the R2 default
  jurisdiction with EU + US replication (the account-level "EU
  jurisdiction selected" claim was not verifiable and is withdrawn);
  transfer mechanism unchanged (2021 SCCs Module 2 + EU-US DPF).
  Mirrored to `apps/marketing-site/src/pages/legal/privacy.md`.
