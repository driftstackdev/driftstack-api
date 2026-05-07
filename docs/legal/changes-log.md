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
