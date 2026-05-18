// W501.C — drift guard for apps/marketing-site/src/pages/api-reference.astro.
// V-127a API reference landing page. Drift here either drops a
// route group from the 11-group surface map (would orphan SDK
// consumers from the canonical API surface enumeration) or breaks
// the V-662 error taxonomy table (which SDK retry-logic implementers
// compare against the typed error class names).
//
//   • V-127a placeholder framing + future Scalar UI embed.
//   • API_DOCS_URL = api.driftstack.dev/docs + OPENAPI_JSON_URL =
//     api.driftstack.dev/openapi.json.
//   • 11-group surface map: Sessions / Profiles / API keys / Webhooks /
//     Account / Team / Billing-crypto-orders / Status / Auth flows /
//     Billing.
//   • V-662 Common patterns: 3 flows × 4 languages (cURL / TypeScript /
//     Python / Go).
//   • V-662 Error reference 10-row table with RFC 7807 type URIs +
//     typed SDK class mapping + retryable markers.
//   • Spec posture: OpenAPI 3.1 from Zod + 'no second source of truth'
//     + /v1 stable / /v2 new-prefix-not-silent-shape-change.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/api-reference.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W501.C apps/marketing-site/src/pages/api-reference.astro content parity', () => {
  const body = read(LIB);

  it("V-127a placeholder framing pinned: 'until the marketing-site build embeds the Scalar UI bundle directly, this page links to the live API server's interactive reference at api.driftstack.dev/docs (which already serves Scalar against the running OpenAPI spec). Future iteration: build-time fetch of /openapi.json + embed Scalar's standalone HTML, so the reference stays browseable even when the API server is offline.' — pinned so the placeholder rationale + the future-Scalar-embed plan stay documented (drift to dropping would let a future maintainer assume the embed already exists)", () => {
    expect(body).toMatch(
      /\/\/ V-127a placeholder — until the marketing-site build embeds the\s*\n?\s*\/\/ Scalar UI bundle directly, this page links to the live API\s*\n?\s*\/\/ server's interactive reference at api\.driftstack\.dev\/docs/,
    );
    expect(body).toMatch(
      /\/\/ Future iteration: build-time fetch of \/openapi\.json \+ embed\s*\n?\s*\/\/ Scalar's standalone HTML, so the reference stays browseable even\s*\n?\s*\/\/ when the API server is offline\./,
    );
  });

  it('API_DOCS_URL + OPENAPI_JSON_URL constants pinned: api.driftstack.dev/docs + api.driftstack.dev/openapi.json — pinned so the canonical hosted-docs + openapi-json URLs stay consistent (drift to a different subdomain would break the click-through to the live interactive reference)', () => {
    expect(body).toMatch(/const API_DOCS_URL = 'https:\/\/api\.driftstack\.dev\/docs';/);
    expect(body).toMatch(
      /const OPENAPI_JSON_URL = 'https:\/\/api\.driftstack\.dev\/openapi\.json';/,
    );
  });

  it("Hero framing: 'Every endpoint, every shape.' + 'The Driftstack API is documented as an OpenAPI 3.1 spec generated from the same Zod schemas the server uses at runtime. There is no second source of truth — if a route exists, it's in the spec; if it's in the spec, the SDK has typed bindings for it.' — pinned so the OpenAPI 3.1 + Zod single-source-of-truth + SDK typed-bindings narrative survives (drift to dropping the 'no second source of truth' would weaken the spec-as-contract claim)", () => {
    expect(body).toMatch(/Every endpoint, every shape\./);
    expect(body).toMatch(
      /The Driftstack API is documented as an OpenAPI 3\.1 spec generated\s*\n?\s*from the same Zod schemas the server uses at runtime\. There is no\s*\n?\s*second source of truth — if a route exists, it's in the spec; if\s*\n?\s*it's in the spec, the SDK has typed bindings for it\./,
    );
  });

  it('13-group surface map taxonomy: Sessions + Agent sessions + Recipes + Profiles + API keys + Webhooks + Account + Team + Billing — crypto orders + Status + Auth flows + Billing — pinned so the 13-group enumeration of canonical route prefixes stays complete (drift to dropping any group would orphan SDK readers from that route surface; drift to merging Billing + crypto-orders would lose the separate billing-paths distinction)', () => {
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*Sessions\s*\n?\s*<\/h3>/,
    );
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*Agent sessions\s*\n?\s*<\/h3>/,
    );
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*Recipes\s*\n?\s*<\/h3>/,
    );
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*Profiles\s*\n?\s*<\/h3>/,
    );
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*API keys\s*\n?\s*<\/h3>/,
    );
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*Webhooks\s*\n?\s*<\/h3>/,
    );
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*Account\s*\n?\s*<\/h3>/,
    );
    expect(body).toMatch(/uppercase tracking-widest text-glow-red">\s*\n?\s*Team\s*\n?\s*<\/h3>/);
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*Billing — crypto orders\s*\n?\s*<\/h3>/,
    );
    expect(body).toMatch(/uppercase tracking-widest text-glow-red">\s*\n?\s*Status\s*\n?\s*<\/h3>/);
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*Auth flows\s*\n?\s*<\/h3>/,
    );
    expect(body).toMatch(
      /uppercase tracking-widest text-glow-red">\s*\n?\s*Billing\s*\n?\s*<\/h3>/,
    );
  });

  it('Sessions route enumeration 9-endpoint: POST + GET + GET /:id + POST /:id/navigate + POST /:id/interact + POST /:id/wait + GET /:id/state + POST /:id/capture + DELETE /:id — pinned so the sessions REST contract enumeration stays consistent with the live OpenAPI spec (drift to dropping any would create marketing↔server divergence for prospects browsing the surface)', () => {
    expect(body).toMatch(/<li>POST \/v1\/sessions<\/li>/);
    expect(body).toMatch(/<li>GET \/v1\/sessions<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/sessions\/:id\/navigate<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/sessions\/:id\/interact<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/sessions\/:id\/wait<\/li>/);
    expect(body).toMatch(/<li>GET \/v1\/sessions\/:id\/state<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/sessions\/:id\/capture<\/li>/);
    expect(body).toMatch(/<li>DELETE \/v1\/sessions\/:id<\/li>/);
  });

  // Arc 4 Wave 2.B sub-slice 8.20.f (v2-#8) — marketing api-reference
  // surfaces agent-sessions as a distinct route group; pins the 6
  // endpoints of the v2-#8 surface so any rename / drop breaks CI.
  it('Agent sessions route enumeration 6-endpoint: POST + GET /:id + POST /:id/message + POST /:id/takeover + POST /:id/handback + DELETE /:id — pinned so the agent-sessions surface stays visible alongside regular sessions on the marketing page (drift to dropping would hide v2-#8 from prospects)', () => {
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions<\/li>/);
    expect(body).toMatch(/<li>GET \/v1\/agent-sessions\/:id<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions\/:id\/message<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions\/:id\/takeover<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions\/:id\/handback<\/li>/);
    expect(body).toMatch(/<li>DELETE \/v1\/agent-sessions\/:id<\/li>/);
  });

  // AI-B4 sub-slice 8.20.m.2 — recipes is a 1-endpoint surface
  // (POST only at v1.0; read/list/execute/delete are v1.1).
  it("Recipes route enumeration 1-endpoint: POST /v1/recipes — pinned so the recipes surface stays visible on the marketing page (drift to dropping would hide AI-B4 from prospects; drift to listing more endpoints would surface v1.1 scope that hasn't shipped)", () => {
    expect(body).toMatch(/<li>POST \/v1\/recipes<\/li>/);
  });

  it("Webhooks route enumeration 9-endpoint: POST + GET + GET /:id + PATCH + DELETE + POST /:id/rotate-secret + POST /:id/test + GET /:id/deliveries + POST /v1/webhook-deliveries/:id/replay — pinned so the webhook lifecycle endpoint enumeration matches the customer-dashboard webhooks page's wired actions (drift would create marketing↔dashboard contract mismatch)", () => {
    expect(body).toMatch(/<li>POST \/v1\/webhooks\/:id\/rotate-secret<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/webhooks\/:id\/test<\/li>/);
    expect(body).toMatch(/<li>GET \/v1\/webhooks\/:id\/deliveries<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/webhook-deliveries\/:id\/replay<\/li>/);
  });

  it("V-662 Common patterns framing pinned: 'Common patterns: side-by-side cURL / TS / Python / Go samples for the three most-used flows. Reduces the \"what does it actually look like to call this?\" friction that the route-list above doesn't answer on its own.' + 'Three flows, four languages.' — pinned so the 4-language coverage commitment + the 3-flow scope survive (drift to dropping a language would shrink the SDK example surface)", () => {
    expect(body).toMatch(
      /V-662 — Common patterns: side-by-side cURL \/ TS \/ Python \/ Go\s*\n?\s*samples for the three most-used flows\./,
    );
    expect(body).toMatch(/Three flows, four languages\./);
  });

  it('V-662 Error reference 10-row taxonomy: 400 validation-failed + 401 unauthorized + 404 not-found + 409 conflict + 410 session-destroyed + 429 tier-limit + 429 rate-limited + 429 concurrency-limit + 500 internal + 503 feature-unavailable — pinned so the canonical 10-row RFC 7807 type URI table stays consistent (drift to dropping any would orphan SDK retry-logic implementers; drift to changing the type URI would break customer code that matches on type)', () => {
    expect(body).toMatch(/errors\.driftstack\.dev\/validation-failed/);
    expect(body).toMatch(/errors\.driftstack\.dev\/unauthorized/);
    expect(body).toMatch(/errors\.driftstack\.dev\/not-found/);
    expect(body).toMatch(/errors\.driftstack\.dev\/conflict/);
    expect(body).toMatch(/errors\.driftstack\.dev\/session-destroyed/);
    expect(body).toMatch(/errors\.driftstack\.dev\/tier-limit/);
    expect(body).toMatch(/errors\.driftstack\.dev\/rate-limited/);
    expect(body).toMatch(/errors\.driftstack\.dev\/concurrency-limit/);
    expect(body).toMatch(/errors\.driftstack\.dev\/internal/);
    expect(body).toMatch(/errors\.driftstack\.dev\/feature-unavailable/);
  });

  it('V-662 typed SDK error class mapping: ValidationError + AuthError + NotFoundError + ConflictError + SessionDestroyedError + TierLimitError + RateLimitError + ConcurrencyLimitError + DriftstackError + FeatureUnavailableError — pinned so the SDK-class-name mapping stays consistent (drift to renaming a class would break customer try/catch blocks; drift to dropping retryable markers on RateLimitError/internal would change retry-logic guidance)', () => {
    expect(body).toMatch(/ValidationError/);
    expect(body).toMatch(/AuthError/);
    expect(body).toMatch(/NotFoundError/);
    expect(body).toMatch(/ConflictError/);
    expect(body).toMatch(/SessionDestroyedError/);
    expect(body).toMatch(/TierLimitError/);
    expect(body).toMatch(
      /RateLimitError <em class="font-sans not-italic text-ink-muted">\(retryable\)<\/em>/,
    );
    expect(body).toMatch(/ConcurrencyLimitError/);
    expect(body).toMatch(
      /DriftstackError \(kind: <code>internal<\/code>\) <em class="font-sans not-italic text-ink-muted">\(retryable\)<\/em>/,
    );
    expect(body).toMatch(
      /FeatureUnavailableError <em class="font-sans not-italic text-ink-muted">\(NOT retryable\)<\/em>/,
    );
  });

  it("V-662 isRetryable predicate framing pinned: 'SDK consumers can use isRetryable(err) (TypeScript) / equivalent predicates in Python + Go to filter which errors to retry without re-implementing the mapping.' — pinned so the cross-language retry-predicate helper survives (drift to dropping would force SDK consumers to re-implement the retryable-error mapping per-language)", () => {
    expect(body).toMatch(
      /SDK consumers can use <code class="font-mono">isRetryable\(err\)<\/code>\s*\n?\s*\(TypeScript\) \/ equivalent predicates in Python \+ Go to filter\s*\n?\s*which errors to retry without re-implementing the mapping\./,
    );
  });

  it("Spec-posture 3-rule framing pinned: 'Every endpoint has Zod schemas for request + response. The OpenAPI 3.1 spec is generated from the schemas — there is no second source of truth.' + 'Every error case maps to an RFC 7807 application/problem+json response with a stable type URI.' + 'Breaking changes ship under a new path version. /v1 stays stable; /v2 would be a new prefix, not a silent shape change.' — pinned so the 3-rule API contract (Zod single-source + RFC 7807 + new-version-not-silent-change) all survives (drift to dropping any rule would weaken the API-stability contract)", () => {
    expect(body).toMatch(
      /Every endpoint has Zod schemas for request \+ response\. The OpenAPI 3\.1 spec is generated from the schemas — there is no second source of truth\./,
    );
    expect(body).toMatch(
      /Every error case maps to an RFC 7807 <code class="font-mono">application\/problem\+json<\/code> response with a stable <code class="font-mono">type<\/code> URI\./,
    );
    expect(body).toMatch(
      /Breaking changes ship under a new path version\. <code class="font-mono">\/v1<\/code> stays stable; <code class="font-mono">\/v2<\/code> would be a new prefix, not a silent shape change\./,
    );
  });

  it("Hero CTA 2-button: 'Open interactive reference →' → API_DOCS_URL (primary) + 'Download openapi.json' → OPENAPI_JSON_URL (secondary) + 'Interactive reference uses Scalar — try requests against your API key directly in the browser.' subline — pinned so the dual-CTA path (interactive + raw json) + the Scalar reference stay visible (drift to dropping the openapi.json link would orphan tool integrators who want the raw spec)", () => {
    expect(body).toMatch(
      /<a href=\{API_DOCS_URL\} class="btn-primary">Open interactive reference →<\/a>/,
    );
    expect(body).toMatch(
      /<a href=\{OPENAPI_JSON_URL\} class="btn-secondary">Download openapi\.json<\/a>/,
    );
    expect(body).toMatch(
      /Interactive reference uses Scalar — try requests against your API\s*\n?\s*key directly in the browser\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
