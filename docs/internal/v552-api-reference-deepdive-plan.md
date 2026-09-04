# V-552 — API reference deep-dive plan

**Date:** 2026-05-11
**Wave:** 25
**Status:** PLAN — current API reference is auto-generated from the
OpenAPI 3.1 spec + ships at `/docs` (Swagger UI) + powers the
docs.driftstack.io reference section. V-552 designs the
human-authored deep-dive layer that complements the auto-generated
reference.

## Current state

- `/openapi.json` — generated from Zod schemas; canonical contract.
- `/docs` — Swagger UI rendering of the OpenAPI doc.
- `docs.driftstack.io/api/*` — Astro-rendered per-route pages
  generated from the same OpenAPI doc + per-route handwritten pages
  for the trickier surfaces (auth, webhooks, sessions, etc. — landed
  in V-499 / V-512 / V-523).

What's auto-generated is accurate but thin: it shows the shape of each
endpoint but not why you'd use it or how it fits with other endpoints.

## V-552 scope

Four layers of human-authored content that the auto-generation can't
produce.

### V-552.A — concept docs per resource

For each top-level resource (accounts, profiles, sessions, api-keys,
webhooks, captures, etc.), one concept doc that answers:

- What is this resource? (1 paragraph)
- When do you use it? (3-4 use cases)
- Lifecycle (create → use → revoke).
- Cross-resource relationships (e.g. "an api-key belongs to an
  account; a session is created with an api-key; a session emits
  webhook events").
- Quotas + limits per tier.
- Common gotchas.

Lives at `apps/docs/src/pages/concepts/<resource>.md`. ~500 words
each.

### V-552.B — code samples per SDK per endpoint

The reference today shows the request/response shape. V-552.B adds
per-SDK code samples for every endpoint, tabbed:

```
[TypeScript] [Python] [Go] [curl]

const session = await driftstack.sessions.create({
  profileId: 'prof_abc123',
  metadata: { campaign: 'launch' }
});
```

Source of truth: a `docs/code-samples/<endpoint-id>/` directory with
4 files per endpoint (`ts.ts`, `py.py`, `go.go`, `curl.sh`). The
docs site renders the matching sample via tab UI.

Maintenance: each sample is itself a test fixture. CI runs every
sample against the live test API to catch drift between docs +
runtime.

### V-552.C — error catalogue

Today the docs site has a single error-handling page. V-552.C
expands to a full per-error-code catalogue:

- One page per error code.
- For each code: HTTP status + problem+json `type` URI + when it
  fires + how to recover + per-SDK error-class mapping.
- Example: `https://docs.driftstack.io/errors/concurrency_limit_exceeded`
  shows the 429 trigger + how to back off + the SDK class
  (`ConcurrencyLimitError` in TS, `concurrency_limit_error` enum in
  Python, etc.).

Source of truth: a JSON catalogue at `docs/data/error-catalogue.json`
(NEW). Auto-rendered into per-error pages at build time.

### V-552.D — endpoint deep-dive for the hard ones

Some endpoints carry enough subtlety that they deserve a 2000-word
deep-dive vs a 50-word reference entry. Candidates:

- `POST /v1/sessions` — concurrent-cap + tier interaction + behaviour
  on retry.
- `POST /v1/webhooks/stripe` — signature verification + idempotency +
  partial-state recovery.
- `POST /v1/auth/cli-authorize/{initiate,bind-device-code,exchange}` —
  polling-loop semantics + token-expiry handling. (V-827/V-828: the plan
  named an `complete` step; the flow is initiate → bind-device-code →
  exchange, and no `complete` route exists.)
- `POST /v1/sessions/:id/capture` — content-type negotiation + inline-bytes
  semantics.

  > **V-828 — the endpoint this line originally named cannot be built as
  > described.** It named a GET on a top-level captures collection, with R2
  > streaming and a retention policy. No such route exists; capture is
  > `POST /v1/sessions/:id/capture`, which returns the bytes INLINE. And a
  > retrievable-by-id capture requires retaining the artifact, which
  > `docs/legal/privacy-policy.md` forbids in three places — including
  > Annex-style row "API Capture artifacts | Returned inline to Customer;
  > the Capture endpoint does not retain the response bytes."
  >
  > So this was not a stale path, it was a planned architecture a shipped
  > legal commitment rules out. Building it would need the privacy policy
  > changed first, which is a decision, not a doc fix.

Each deep-dive at `apps/docs/src/pages/deep-dives/<endpoint>.md`.
Authored, not generated.

## Drift prevention

Auto-generated content (OpenAPI → reference pages) updates whenever
the Zod schemas change. Human-authored content lags. Mitigation:

1. **CI check** — fails if an endpoint exists in OpenAPI but has no
   concept page entry (V-552.A coverage check).
2. **CI check** — fails if a code sample's request/response doesn't
   pass the live API contract test (V-552.B drift check).
3. **CI check** — fails if a problem+json `type` URI exists in any
   route handler but isn't in the error catalogue (V-552.C coverage
   check).

## What this enables

- **Self-serve customer onboarding** — the docs site answers "how do
  I do X?" without requiring a support email.
- **SDK consistency** — code samples in 4 languages per endpoint make
  the polyglot SDK story credible.
- **Enterprise-evaluation depth** — deep-dives + error catalogue
  satisfy the procurement-review depth check.

## Sub-slices

- **V-552.A** — concept docs for top 10 resources (account / profile /
  session / api-key / web-session / webhook / capture / billing /
  legal / audit-log). One wave's work.
- **V-552.B** — code-sample directory scaffolding + samples for top
  20 endpoints + tab UI integration in the docs site. One wave's
  work.
- **V-552.C** — error-catalogue JSON + per-error page rendering +
  CI coverage check. One wave's work.
- **V-552.D** — deep-dives for 4 hard endpoints. Two waves' work.

Total: ~5 waves of content authoring. Lands incrementally as customer
feedback surfaces which surface needs more depth first.

## Open questions for team review

1. **Authoring lead.** Engineering authors the docs (current proposal)
   vs technical writer hired post-launch? Recommendation: engineering
   for v1; consider a fractional technical writer when traffic +
   doc-feedback volume justify.
2. **Translation roadmap.** English-only at launch vs commit to
   localising into Japanese / German based on customer geo?
   Recommendation: English-only for v1; localise demand-driven.
3. **Versioning the docs.** Per-API-version docs (separate site for
   v1 vs v2) vs single site with "since version" callouts?
   Recommendation: single site with callouts until v2 actually
   ships; pre-launch v2 doesn't exist.

## Verification

- File written.
- Cross-references V-499 / V-512 / V-523 docs work + V-484 audit-log
  - the OpenAPI auto-generation.
- V-205 + V-211 sweep: zero hits.
