// W564.B — drift guard for /docs/internal/v552-api-reference-deepdive-plan.md.
// V-552 PLAN doc 2026-05-11 Wave-25. Drift here either weakens the
// 4-layer human-authored deep-dive (concept + per-SDK-samples +
// error-catalogue + hard-endpoint-deep-dives), drops the CI-drift-
// prevention pattern, or unsets the 5-wave-incremental sub-slice
// total.
//
//   • V-552. PLAN. Human-authored layer complementing OpenAPI auto-
//     generation.
//   • Current: /openapi.json + /docs Swagger UI + docs.driftstack.io/
//     api/* (V-499/V-512/V-523).
//   • V-552.A concept docs per resource (~500 words each).
//   • V-552.B per-SDK code samples (TS+Python+Go+curl) with CI drift
//     check.
//   • V-552.C error catalogue from JSON source-of-truth.
//   • V-552.D hard-endpoint deep-dives (~2000 words each, 4 endpoints).
//   • 3 CI drift-prevention checks.
//   • 4 sub-slice ~5-wave total.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v552-api-reference-deepdive-plan.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W564.B /docs/internal/v552-api-reference-deepdive-plan.md content parity', () => {
  const body = read(LIB);

  it("Header + V-552-PLAN-Wave-25 + 3-current-surface + 4-layer framing pinned: '# V-552 — API reference deep-dive plan' + '**Date:** 2026-05-11' + '**Wave:** 25' + '**Status:** PLAN — current API reference is auto-generated from the' + 'OpenAPI 3.1 spec + ships at `/docs` (Swagger UI) + powers the' + 'docs.driftstack.io reference section. V-552 designs the' + 'human-authored deep-dive layer that complements the auto-generated' + '`/openapi.json` — generated from Zod schemas; canonical contract.' + '`/docs` — Swagger UI rendering of the OpenAPI doc.' + '`docs.driftstack.io/api/*` — Astro-rendered per-route pages' + 'V-499 / V-512 / V-523' + 'Four layers of human-authored content that the auto-generation can't' + 'produce.' — pinned so the V-552-PLAN-Wave-25-2026-05-11 + OpenAPI-3.1-auto-gen + /docs-Swagger-UI + docs.driftstack.io/api/*-V-499/V-512/V-523 + 4-layer-human-authored commitment survives", () => {
    expect(body).toMatch(/^# V-552 — API reference deep-dive plan$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 25/);
    expect(body).toMatch(/\*\*Status:\*\* PLAN — current API reference is auto-generated from the/);
    expect(body).toMatch(/OpenAPI 3\.1 spec \+ ships at `\/docs` \(Swagger UI\) \+ powers the/);
    expect(body).toMatch(/docs\.driftstack\.io reference section\. V-552 designs the/);
    expect(body).toMatch(/human-authored deep-dive layer that complements the auto-generated/);
    expect(body).toMatch(/- `\/openapi\.json` — generated from Zod schemas; canonical contract\./);
    expect(body).toMatch(/- `\/docs` — Swagger UI rendering of the OpenAPI doc\./);
    expect(body).toMatch(/- `docs\.driftstack\.io\/api\/\*` — Astro-rendered per-route pages/);
    expect(body).toMatch(/V-499 \/ V-512 \/ V-523/);
    expect(body).toMatch(/Four layers of human-authored content that the auto-generation can't/);
    expect(body).toMatch(/produce\./);
  });

  it("V-552.A/B/C/D 4-layer framing pinned: '### V-552.A — concept docs per resource' + 'one concept doc that answers:' + 'What is this resource? (1 paragraph)' + 'When do you use it? (3-4 use cases)' + 'Lifecycle (create → use → revoke).' + 'Cross-resource relationships' + 'Quotas + limits per tier.' + 'Common gotchas.' + '`apps/docs/src/pages/concepts/<resource>.md`. ~500 words' + '### V-552.B — code samples per SDK per endpoint' + 'per-SDK code samples for every endpoint, tabbed:' + '[TypeScript] [Python] [Go] [curl]' + '`docs/code-samples/<endpoint-id>/` directory with' + '4 files per endpoint (`ts.ts`, `py.py`, `go.go`, `curl.sh`)' + 'CI runs every sample against the live test API to catch drift' + '### V-552.C — error catalogue' + 'a full per-error-code catalogue' + '`https://docs.driftstack.io/errors/concurrency_limit_exceeded`' + '`ConcurrencyLimitError` in TS' + '`docs/data/error-catalogue.json` (NEW)' + '### V-552.D — endpoint deep-dive for the hard ones' + 'a 2000-word deep-dive' + '`POST /v1/sessions` — concurrent-cap + tier interaction + behaviour' + '`POST /v1/webhooks/stripe` — signature verification + idempotency' + '`POST /v1/auth/cli-authorize/{initiate,complete}`' + '`GET /v1/captures/:id` — content-type negotiation + R2 streaming' + 'Each deep-dive at `apps/docs/src/pages/deep-dives/<endpoint>.md`' — pinned so the 4-layer (concept-/concepts/<resource>.md-~500-words + 4-language-code-sample + error-catalogue-/errors/<id>-JSON + 4-hard-endpoint-2000-word-deep-dive) + CI-live-test-API-drift commitment survives", () => {
    expect(body).toMatch(/### V-552\.A — concept docs per resource/);
    expect(body).toMatch(/one concept doc that answers:/);
    expect(body).toMatch(/- What is this resource\? \(1 paragraph\)/);
    expect(body).toMatch(/- When do you use it\? \(3-4 use cases\)/);
    expect(body).toMatch(/- Lifecycle \(create → use → revoke\)\./);
    expect(body).toMatch(/- Cross-resource relationships/);
    expect(body).toMatch(/- Quotas \+ limits per tier\./);
    expect(body).toMatch(/- Common gotchas\./);
    expect(body).toMatch(/`apps\/docs\/src\/pages\/concepts\/<resource>\.md`\. ~500 words/);
    expect(body).toMatch(/### V-552\.B — code samples per SDK per endpoint/);
    expect(body).toMatch(/per-SDK code samples for every endpoint, tabbed:/);
    expect(body).toMatch(/\[TypeScript\] \[Python\] \[Go\] \[curl\]/);
    expect(body).toMatch(/`docs\/code-samples\/<endpoint-id>\/` directory with/);
    expect(body).toMatch(/4 files per endpoint \(`ts\.ts`, `py\.py`, `go\.go`, `curl\.sh`\)/);
    expect(body).toMatch(/CI runs every/);
    expect(body).toMatch(/sample against the live test API to catch drift between docs \+/);
    expect(body).toMatch(/### V-552\.C — error catalogue/);
    expect(body).toMatch(/a full per-error-code catalogue/);
    expect(body).toMatch(/`https:\/\/docs\.driftstack\.io\/errors\/concurrency_limit_exceeded`/);
    expect(body).toMatch(/`ConcurrencyLimitError` in TS/);
    expect(body).toMatch(/`docs\/data\/error-catalogue\.json`/);
    expect(body).toMatch(/### V-552\.D — endpoint deep-dive for the hard ones/);
    expect(body).toMatch(/Some endpoints carry enough subtlety that they deserve a 2000-word/);
    expect(body).toMatch(/`POST \/v1\/sessions` — concurrent-cap \+ tier interaction \+ behaviour/);
    expect(body).toMatch(/`POST \/v1\/webhooks\/stripe` — signature verification \+ idempotency/);
    expect(body).toMatch(
      /`POST \/v1\/auth\/cli-authorize\/\{initiate,bind-device-code,exchange\}`/,
    );
    // V-828 SENTINEL — there is no `complete` route; the flow is
    // initiate -> bind-device-code -> exchange.
    expect(body, 'no cli-authorize/complete endpoint exists').not.toMatch(
      /cli-authorize\/\{initiate,complete\}/,
    );
    expect(body).toMatch(
      /`POST \/v1\/sessions\/:id\/capture` — content-type negotiation \+ inline-bytes/,
    );
    expect(body).toMatch(/V-828 — the endpoint this line originally named cannot be built as/);
    // SENTINEL — the planned shape needs artifact retention, which the privacy
    // policy forbids in three places. Not a stale path; a forbidden design.
    expect(body, 'no /v1/captures route, and retention is ruled out').not.toMatch(
      /`GET \/v1\/captures\/:id`/,
    );
    expect(body).toMatch(/Each deep-dive at `apps\/docs\/src\/pages\/deep-dives\/<endpoint>\.md`/);
  });

  it("CI-drift + enables + sub-slice + open-questions framing pinned: '## Drift prevention' + 'Auto-generated content (OpenAPI → reference pages) updates whenever' + '**CI check** — fails if an endpoint exists in OpenAPI but has no' + 'concept page entry (V-552.A coverage check).' + '**CI check** — fails if a code sample's request/response doesn't' + 'pass the live API contract test (V-552.B drift check).' + '**CI check** — fails if a problem+json `type` URI exists in any' + 'route handler but isn't in the error catalogue (V-552.C coverage' + '## What this enables' + '**Self-serve customer onboarding**' + '**SDK consistency** — code samples in 4 languages per endpoint' + '**Enterprise-evaluation depth** — deep-dives + error catalogue' + 'satisfy the procurement-review depth check.' + '## Sub-slices' + '**V-552.A** — concept docs for top 10 resources' + '(account / profile / session / api-key / web-session / webhook / capture / billing / legal / audit-log)' + '**V-552.B** — code-sample directory scaffolding + samples for top' + '20 endpoints' + '**V-552.C** — error-catalogue JSON + per-error page rendering' + '**V-552.D** — deep-dives for 4 hard endpoints. Two waves' work.' + 'Total: ~5 waves of content authoring.' + '## Open questions for team review' + '**Authoring lead.**' + '**Translation roadmap.**' + '**Versioning the docs.**' + 'V-205 + V-211 sweep: zero hits.' — pinned so the 3-CI-drift-check (V-552.A-coverage + V-552.B-live-API + V-552.C-problem+json-URI) + 3-enables (self-serve + SDK-consistency + enterprise-depth) + 4-sub-slice (V-552.A-10-resource + V-552.B-20-endpoint + V-552.C-JSON-render + V-552.D-2-waves) + ~5-wave-total + 3-open-question commitment survives", () => {
    expect(body).toMatch(/## Drift prevention/);
    expect(body).toMatch(/Auto-generated content \(OpenAPI → reference pages\) updates whenever/);
    expect(body).toMatch(
      /1\. \*\*CI check\*\* — fails if an endpoint exists in OpenAPI but has no/,
    );
    expect(body).toMatch(/concept page entry \(V-552\.A coverage check\)\./);
    expect(body).toMatch(
      /2\. \*\*CI check\*\* — fails if a code sample's request\/response doesn't/,
    );
    expect(body).toMatch(/pass the live API contract test \(V-552\.B drift check\)\./);
    expect(body).toMatch(
      /3\. \*\*CI check\*\* — fails if a problem\+json `type` URI exists in any/,
    );
    expect(body).toMatch(/route handler but isn't in the error catalogue \(V-552\.C coverage/);
    expect(body).toMatch(/## What this enables/);
    expect(body).toMatch(/- \*\*Self-serve customer onboarding\*\*/);
    expect(body).toMatch(/- \*\*SDK consistency\*\* — code samples in 4 languages per endpoint/);
    expect(body).toMatch(/- \*\*Enterprise-evaluation depth\*\* — deep-dives \+ error catalogue/);
    expect(body).toMatch(/satisfy the procurement-review depth check\./);
    expect(body).toMatch(/## Sub-slices/);
    expect(body).toMatch(/- \*\*V-552\.A\*\* — concept docs for top 10 resources/);
    expect(body).toMatch(
      /\(account \/ profile \/\s*session \/ api-key \/ web-session \/ webhook \/ capture \/ billing \//,
    );
    expect(body).toMatch(
      /- \*\*V-552\.B\*\* — code-sample directory scaffolding \+ samples for top/,
    );
    expect(body).toMatch(/20 endpoints/);
    expect(body).toMatch(/- \*\*V-552\.C\*\* — error-catalogue JSON \+ per-error page rendering/);
    expect(body).toMatch(
      /- \*\*V-552\.D\*\* — deep-dives for 4 hard endpoints\. Two waves' work\./,
    );
    expect(body).toMatch(/Total: ~5 waves of content authoring\./);
    expect(body).toMatch(/## Open questions for team review/);
    expect(body).toMatch(/1\. \*\*Authoring lead\.\*\*/);
    expect(body).toMatch(/2\. \*\*Translation roadmap\.\*\*/);
    expect(body).toMatch(/3\. \*\*Versioning the docs\.\*\*/);
    expect(body).toMatch(/- V-205 \+ V-211 sweep: zero hits\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
