# Driftstack — legal document set

This directory holds the four bound legal documents for the Driftstack
service plus a shared definitions file:

| File                                                   | Purpose                                                                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`definitions.md`](definitions.md)                     | Defined terms used across all four documents. Source of truth for terminology.                                                                                             |
| [`terms-of-service.md`](terms-of-service.md)           | Master commercial agreement with Customer. Incorporates AUP and Privacy Policy by reference.                                                                               |
| [`privacy-policy.md`](privacy-policy.md)               | GDPR-compliant disclosures for personal data Driftstack processes as **Controller** (account, billing, support).                                                           |
| [`dpa.md`](dpa.md)                                     | Article 28 GDPR processor agreement for personal data Driftstack processes as **Processor** on Customer's behalf (session content, recordings, customer-provided secrets). |
| [`acceptable-use-policy.md`](acceptable-use-policy.md) | Prohibited targets, prohibited techniques, customer responsibility framing, enforcement. Incorporated into ToS by reference.                                               |

The four bound documents are mirrored to public-facing pages on the
Driftstack marketing site under `/legal/{terms,privacy,dpa,aup}` (see
`apps/marketing-site/src/pages/legal/`). The DPA Annex 3
sub-processor list is mirrored to a customer-facing transparency page
at `/trust/sub-processors` driven by
`apps/marketing-site/src/data/sub-processors.ts`.

## Acceptance + revision

Customer acceptance of these documents is tracked via
`POST /v1/legal/accept`. Each acceptance records `account_id`,
`document_key`, `version`, `content_hash` (SHA-256 of the document
content at acceptance), and `accepted_at`. Version bumps invalidate
prior acceptances and trigger a re-accept flow on the customer's next
API call.

## Versioning

Each document carries a SemVer-shaped version in its header. Bumping
follows these rules:

- **Patch** (`1.0.0` → `1.0.1`): typo fix, formatting, no substantive
  legal change. **Does not** force re-acceptance.
- **Minor** (`1.0.x` → `1.1.0`): clarification or addition that does
  not materially change the customer's obligations. **Forces re-acceptance** under conservative posture.
- **Major** (`1.x.y` → `2.0.0` and beyond): material change to the
  customer's rights, obligations, or fees; new sub-processor; new
  jurisdiction. **Forces re-acceptance** with a `notice_period_days`
  parameter (default 30) and prominent surfacing in the API response
  to clients running on the prior version.

## Revision triggers

A revision pass is required on any of:

1. Material business model change (new product, new pricing tier,
   new commercial primitive).
2. New sub-processor added to the list in the Privacy Policy or DPA.
3. New jurisdiction served (i.e. Driftstack accepts customers from
   a jurisdiction not previously contemplated by these documents —
   the current set assumes EU + UK + US + Switzerland customers).
4. Regulatory change in any covered jurisdiction (notably: Dutch DPA
   guidance, EU Commission decisions on Standard Contractual Clauses
   or the EU-US Data Privacy Framework, Court of Justice of the EU
   rulings affecting transfer mechanisms).
5. **Annual minimum** — review at least once every 12 months
   regardless of trigger fires.

## Cross-document consistency

- Defined terms are **identical across all four documents** and live
  in `definitions.md`. If a term needs to mean different things in
  different documents, it is renamed; we do not redefine.
- Effective-date headers across all four documents move in lockstep
  when a multi-document revision lands. Single-document revisions are
  allowed; the affected document's header updates while others remain
  at their previous version.

## What's NOT in this set

- **Customer-facing onboarding copy** (signup flow, email templates,
  in-product banners). Lives outside this directory in the marketing
  - product surfaces.
- **Sub-processor agreements** themselves (e.g. the actual contract
  between Driftstack B.V. and Stripe Ireland). Each sub-processor
  relationship is established through that sub-processor's own
  contracting flow.
- **Insurance certificates**. The ToS references "commercially
  reasonable insurance"; the actual policies are procured separately
  and not tracked here.
- **Internal corporate documents** (articles of association,
  shareholder agreements, employment contracts).

## Acceptance + revision machinery

See `apps/server/src/routes/legal.ts` for the endpoints that record
customer acceptance, and the `legal_acceptances` table in
`apps/server/src/db/schema.ts` for the audit log shape.
