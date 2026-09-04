# V-550 — trust center expansion

**Date:** 2026-05-11
**Wave:** 24
**Status:** DESIGN — current trust surface is the marketing-site
security page + DPA + privacy policy. V-550 designs the next-layer
trust-center expansion before first enterprise customer.

## Current state

Marketing site has:

- `/security` — sub-processor list, encryption at rest/transit,
  data-residency claims.
- `/legal/dpa` — DPA template ready for execution.
- `/legal/privacy` — GDPR-compliant privacy policy.
- `/legal/terms` — terms of service.
- `/legal/acceptable-use-policy` — AUP.

What's missing for an enterprise-credible trust center:

1. Versioned + dated sub-processor list with a "subscribe to changes"
   RSS / email feed.
2. Public incident history page.
3. Compliance certifications surface — even a "in progress: SOC 2
   Type I expected Q3 2026" honest disclosure beats silence.
4. Pen-test report access — gated download for prospective customers
   under NDA.
5. Vulnerability disclosure policy.
6. Data subprocessor change notification SLA disclosure.

## V-550 scope

Three sub-slices.

### V-550.A — sub-processor changes feed

Today the sub-processor list lives at `apps/marketing-site/src/data/
sub-processors.ts` + renders on `/security`. V-550.A adds:

1. **Versioning** — each sub-processor entry gains an `added_at` date
   - an optional `removed_at` date.
2. **Public RSS feed** — `https://driftstack.io/trust/sub-processors/
feed.xml` lists every change (additions / removals / status
   changes) in reverse-chronological order.
3. **Email-on-change** — customers can opt into Postmark notifications
   when the sub-processor list changes. This satisfies the GDPR Art.
   28(2) 30-day notice requirement (already documented in V-493
   sub-processor parity audit).

### V-550.B — incident history page

Builds on V-545.C (status-site history view). Adds:

- Public-readable summary per incident (resolved incidents only;
  no operator-only updates leak).
- Year-archive page: `/trust/incidents/2026/`.
- Per-incident permalink.
- Mean-time-to-resolution (MTTR) rolling stats over last 30 / 90 /
  365 days.

### V-550.C — compliance + pen-test posture page

New page at `/trust/compliance`:

1. **Honest current state**: list certifications in progress + their
   expected timeline. Don't claim certs we don't have.
2. **Pen-test access**: form for prospective customers to request
   the most recent pen-test report. Gated on NDA acceptance.
3. **Vulnerability disclosure policy**: `security@driftstack.dev`
   inbox; 90-day responsible-disclosure window; recognition page
   for reporters (post-launch).
4. **Subprocessor change SLA**: 30-day notice for material changes
   (referencing DPA Annex 3).
5. **Audit log retention disclosure**: how long we retain audit
   logs + customer-data access logs (per ADR-006).

## Operational considerations

- **Pen-test access form**: ties to a `nda_requests` table (proposed)
  - admin-approval workflow before granting the report download URL.
    The report is stored as a private R2 object with a 7-day signed-URL
    per approval.
- **RSS feed generation**: rendered at build time by the marketing-
  site CI from the sub-processor data file. No runtime endpoint
  needed.
- **MTTR stats**: rendered from the incidents table at build time
  (cached for 1 hour) — daily rebuild is sufficient given incident
  cadence.

## What this enables

- **Enterprise sales motion** — a prospect's security review can
  self-serve through the trust center rather than blocking on a
  questionnaire round-trip.
- **DPA compliance** — the sub-processor change feed satisfies Art.
  28(2) without per-customer email blasts.
- **Trust posture credibility** — "honest current state" outperforms
  silence on the certification axis. Prospects see real timelines,
  not vague "enterprise-ready" claims.

## Open questions for team review

1. **MTTR public exposure** — public 30/90/365-day MTTR (current
   proposal) creates a competitive metric we have to maintain. Worth
   the exposure? Recommendation: yes; transparency beats hidden
   under-performance.
2. **Pen-test gating** — NDA-then-download workflow (current proposal)
   adds friction. Alternative: public summary + private full report
   (lower friction, less control over the full content). Recommendation:
   summary-public + full-NDA-gated.
3. **Compliance roadmap honesty** — list certifications we're NOT
   pursuing (e.g. "no SOC 2 Type II planned in 2026") OR stay silent
   on those? Recommendation: stay silent on those; positive list only.

## Sub-slices

- **V-550.A** — sub-processor changes RSS + email-on-change opt-in.
- **V-550.B** — public incident history page + MTTR rolling stats.
- **V-550.C** — compliance page + pen-test NDA workflow +
  vulnerability disclosure policy + audit-log retention disclosure.

## Verification

- File written.
- Cross-references V-493 sub-processor parity audit + V-545 status
  enhancements + ADR-006 audit-log retention.
- V-205 + V-211 sweep: zero hits.
