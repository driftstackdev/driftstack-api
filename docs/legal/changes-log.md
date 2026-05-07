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
