# Driftstack — legal document set (baseline drafts)

**Status:** AI-generated baseline drafts. Counsel review required before
first paying customer.

**Generated:** 2026-05-03 under the AGENTS.md legal-content exception.

This directory holds the four bound legal documents for the Driftstack
service plus a shared definitions file:

| File                                                   | Purpose                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`definitions.md`](definitions.md)                     | Defined terms used across all four documents. Source of truth for terminology.                                                                                         |
| [`terms-of-service.md`](terms-of-service.md)           | Master commercial agreement with Customer. Incorporates AUP and Privacy Policy by reference.                                                                           |
| [`privacy-policy.md`](privacy-policy.md)               | GDPR-compliant disclosures for personal data Driftstack processes as **Controller** (account, billing, support).                                                       |
| [`dpa.md`](dpa.md)                                     | Art 28 GDPR processor agreement for personal data Driftstack processes as **Processor** on Customer's behalf (session content, recordings, customer-provided secrets). |
| [`acceptable-use-policy.md`](acceptable-use-policy.md) | Prohibited targets, prohibited techniques, customer responsibility framing, enforcement. Incorporated into ToS by reference.                                           |

## Provenance + revision policy

These documents are **AI-generated baseline drafts** produced under the
[AGENTS.md legal-content exception](../../AGENTS.md#%E2%9A%A0%EF%B8%8F-repository-scope) (effective 2026-05-03). They are starting points for
counsel review, **not final bound documents**. The founder accepts that
AI-generated legal text carries risk that counsel review may not catch
and treats all generated content as revisable.

**Pre-publication blocker:** counsel review is required before:

- The first paying customer is onboarded.
- Any of these documents is presented to a customer or prospect as
  representing the BV's binding position.
- Any of these documents binds a customer relationship via the
  `POST /v1/legal/accept` flow.

**Public DRAFT exposure (V-255 / 2026-05-07):** These documents are
now mirrored at `driftstack.dev/legal/{terms,privacy,dpa,aup}` as
DRAFT pages with a prominent banner ("Draft — counsel review pending;
not for customer reliance") + `<meta name="robots" content="noindex,nofollow">`
so they are not search-indexed. The footer of every marketing page
links these URLs (Footer.astro section "Legal"), unblocking 404s on
those routes. The pages are NOT yet bound to customer acceptance via
`POST /v1/legal/accept`; that gate still requires counsel-reviewed
content. The DRAFT banner + noindex carry the "not for customer
reliance" framing until counsel-reviewed `0.x.y` content replaces
the draft.

**Revision triggers (counsel re-review fires on any of):**

1. Material business model change (new product, new pricing tier,
   new commercial primitive).
2. New sub-processor added to the list in the Privacy Policy or DPA.
3. New jurisdiction served (i.e. Driftstack accepts customers from
   a jurisdiction not previously contemplated by these documents —
   the current draft assumes EU + UK + US + Switzerland customers).
4. Regulatory change in any covered jurisdiction (notably: Dutch DPA
   guidance, EU Commission decisions on Standard Contractual Clauses
   or the EU-US Data Privacy Framework, Court of Justice of the EU
   rulings affecting transfer mechanisms).
5. **Annual minimum** — counsel review at least once every 12 months
   regardless of trigger fires.

**Acceptance machinery:** customer acceptance of these documents is
tracked via the API at `POST /v1/legal/accept` (see
`docs/architecture.md` once the machinery lands). Each acceptance
records `account_id`, `document_key`, `version`, `content_hash` (SHA-256
of the document content at acceptance), and `accepted_at`. Version
bumps invalidate prior acceptances and trigger a re-accept flow on the
customer's next API call.

## Versioning

Each document carries a SemVer-shaped version in its header. Bumping
follows these rules:

- **Patch** (`0.1.0` → `0.1.1`): typo fix, formatting, no substantive
  legal change. **Does not** force re-acceptance.
- **Minor** (`0.1.x` → `0.2.0`): clarification or addition that does
  not materially change the customer's obligations. **Forces re-acceptance** under conservative posture.
- **Major** (`0.x.y` → `1.0.0` and beyond): material change to the
  customer's rights, obligations, or fees; new sub-processor; new
  jurisdiction. **Forces re-acceptance** with a `notice_period_days`
  parameter (default 30) and prominent surfacing in the API response
  to clients running on the prior version.

The current version of every document at the time of this commit is
`0.1.2-draft`. The `-draft` suffix retires when counsel review lands.

History:

- `0.1.0-draft` (2026-05-03, V-046): inaugural baseline drafts.
- `0.1.1-draft` (2026-05-03, V-048): Paddle removed from
  customer-facing legal text per founder direction (conditional
  sub-processor created disclosure obligations and customer
  confusion; treat as proper Art 28(2) sub-processor amendment if
  Paddle ever activates). Hosting sub-processors added to the
  Privacy Policy + DPA Annex 3 + definitions.md (Hetzner, Neon,
  Upstash, Cloudflare, Postmark, Sentry).
- `0.1.2-draft` (2026-05-03, V-052): Coinbase Commerce dropped
  from sub-processor list and customer-facing references. Coinbase
  Commerce closed for non-US/Singapore merchants 2026-03-31;
  Coinbase Business unavailable in NL. Stripe is the sole payment
  rail at launch (fiat-only). Crypto rail re-entry deferred to
  post-launch when transaction volume justifies evaluating EU-
  friendly alternatives (CoinGate, NOWPayments, BVNK, Triple-A) or
  Stripe's native USDC/USDB if EU merchant eligibility is
  confirmed at BV onboarding.

## Cross-document consistency

- Defined terms are **identical across all four documents** and live in
  `definitions.md`. If a term needs to mean different things in
  different documents, it is renamed; we do not redefine.
- Entity placeholders (`[BV LEGAL NAME]`, `[KvK NUMBER]`, `[BTW
NUMBER]`, `[REGISTERED ADDRESS]`) are bracketed and consistent across
  all documents. Post-KvK swap is one find-replace per document.
- Effective-date headers across all four documents must move in
  lockstep when a multi-document revision lands. Single-document
  revisions are allowed; the affected document's header updates while
  others remain at their previous version.

## Counsel review focus areas

Annotated for the reviewing counsel:

1. **Dutch BV liability cap enforceability**. Article 6:248 BW (good
   faith), Article 7:756 BW (consumer-protection carve-outs if any
   B2C sales materialise), and case law on contract limitation
   clauses for B2B SaaS in the Netherlands. The current draft caps at
   12 months of fees paid with carve-outs for gross negligence,
   willful misconduct, IP infringement indemnification, and breach of
   confidentiality. Counsel verify enforceability of cap structure
   under Dutch law and confirm carve-out wording is sufficient to
   defeat a plaintiff's "the entire cap is unconscionable" argument.

2. **DPO threshold determination**. Article 37(1)(b) GDPR. The current
   draft documents a threshold-based policy (appoint DPO when monthly
   active sessions exceed 1M, or when any single customer's monthly
   sessions involve regular monitoring of >5,000 unique data subjects,
   or when Dutch DPA issues guidance applying threshold to similar
   services). Counsel verify the threshold is defensible and that the
   "Privacy Contact" alternative complies with current Dutch DPA
   posture.

3. **SCC module choice for sub-processors**. The DPA incorporates 2021
   SCCs Module 3 (controller-to-processor) for the Customer →
   Driftstack relationship; Module 2 or 3 (processor-to-(sub)processor)
   for the Driftstack → Sub-processor relationships, depending on
   whether the sub-processor is itself a processor or controller.
   Counsel verify per sub-processor.

4. **EU-US Data Privacy Framework applicability**. The Privacy Policy
   relies on DPF self-certification status for US sub-processors
   (Stripe, MacStadium, Anthropic). Counsel verify
   each sub-processor's current self-certification status at
   <https://www.dataprivacyframework.gov/list> and update or fall back
   to SCCs as appropriate.

5. **Acceptable-use enforcement progression**. The AUP states a
   warning → suspension → termination progression with discretion to
   skip steps for severe violations. Counsel verify the progression is
   compliant with applicable consumer-protection law for any B2C
   accounts (current draft is B2B-only; verify carve-out).

6. **International transfer mechanisms** beyond the EU-US axis.
   Customer base is documented as "EU + UK + US + Switzerland." If
   counsel intends to widen the customer base, additional transfer
   mechanisms apply (e.g. UK IDTA addendum, Swiss FDPIC requirements).

7. **Customer-connected services framing**. The DPA distinguishes
   "Customer-Connected Services" (proxies, captcha, email, SMS — held
   by Customer's own credentials) from "Sub-processors" (processed on
   Driftstack's behalf). Counsel verify this framing holds in cases
   where Customer's authentication failure causes Driftstack-side data
   exposure.

## What's NOT in this set

- **Customer-facing onboarding copy** (signup flow, email templates,
  in-product banners). Lives outside this repo per AGENTS.md;
  marketing track.
- **Sub-processor agreements** themselves (e.g. the actual contract
  between Driftstack BV and Stripe Ireland). Out of scope; each
  sub-processor relationship is established through that
  sub-processor's own contracting flow.
- **Insurance certificates / liability proofs**. The ToS references
  "commercially reasonable insurance"; the actual policies are
  procured separately by the BV and not tracked here.
- **Internal corporate documents** (articles of association,
  shareholder agreements, employment contracts). These are
  founder-private artifacts that never enter any repo.

## Acceptance + revision machinery

See `apps/server/src/routes/legal.ts` (lands in V-048) for the
endpoints that record customer acceptance, and the `legal_acceptances`
table in `apps/server/src/db/schema.ts` for the audit log shape.
