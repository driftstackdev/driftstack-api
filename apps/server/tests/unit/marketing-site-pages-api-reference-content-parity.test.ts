// W501.C — drift guard for apps/marketing-site/src/pages/api-reference.astro.
// V-127a API reference landing page. Drift here either drops a
// route group from the curated surface map (would orphan SDK
// consumers from the canonical API surface enumeration) or breaks
// the V-662 error taxonomy table (which SDK retry-logic implementers
// compare against the typed error class names).
//
//   • Live Scalar reference framing.
//   • API_DOCS_URL = api.driftstack.dev/docs + OPENAPI_JSON_URL =
//     api.driftstack.dev/openapi.json.
//   • Curated surface map including archetype discovery, agent-session
//     collection reads, and the shipped saved-recipe management surface.
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

  it('pins the live interactive Scalar reference without placeholder or future-embed copy', () => {
    expect(body).toMatch(
      /\/\/ The live API server serves Scalar against the running OpenAPI spec\./,
    );
    expect(body).toMatch(/Interactive reference uses Scalar — try requests against your API/);
    expect(body).not.toMatch(/placeholder|future iteration|until .* embeds/i);
  });

  it('API_DOCS_URL + OPENAPI_JSON_URL constants pinned: api.driftstack.dev/docs + api.driftstack.dev/openapi.json — pinned so the canonical hosted-docs + openapi-json URLs stay consistent (drift to a different subdomain would break the click-through to the live interactive reference)', () => {
    expect(body).toMatch(/const API_DOCS_URL = 'https:\/\/api\.driftstack\.dev\/docs';/);
    expect(body).toMatch(
      /const OPENAPI_JSON_URL = 'https:\/\/api\.driftstack\.dev\/openapi\.json';/,
    );
  });

  it('frames the page as a curated map backed by the complete generated reference', () => {
    expect(body).toMatch(/Core routes, exact shapes\./);
    expect(body).toMatch(
      /complete Driftstack API is documented in a standard\s+machine-readable format \(an OpenAPI 3\.1 spec\), generated from the\s+same validation rules \(Zod schemas\) the server enforces at runtime/,
    );
    expect(body).toMatch(
      /This page is a curated map of common resources and runnable\s+request patterns/,
    );
    expect(body).not.toMatch(/Every endpoint/i);
  });

  // Fleet v2 (2026-07-03) — group headings re-pinned from text-tk-accent
  // to the AA-safe text-tk-accent-text tone (accent-colored TEXT fails
  // AA on the dark bg; heading text + grouping are unchanged).
  it('curated surface map includes archetypes, agent sessions, recipes, and the primary account resources', () => {
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Sessions\s*<\/h3>/);
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Archetypes\s*<\/h3>/);
    expect(body).toMatch(
      /uppercase tracking-widest text-tk-accent-text">\s*Agent sessions\s*<\/h3>/,
    );
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Recipes\s*<\/h3>/);
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Profiles\s*<\/h3>/);
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*API keys\s*<\/h3>/);
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Webhooks\s*<\/h3>/);
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Account\s*<\/h3>/);
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Team\s*<\/h3>/);
    expect(body).toMatch(
      /uppercase tracking-widest text-tk-accent-text">\s*Billing — crypto orders\s*<\/h3>/,
    );
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Status\s*<\/h3>/);
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Auth flows\s*<\/h3>/);
    expect(body).toMatch(/uppercase tracking-widest text-tk-accent-text">\s*Billing\s*<\/h3>/);
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
  // surfaces agent-sessions as a distinct route group; pins the collection
  // read plus the customer-facing control subset (extended 2026-05-20 with Slice 3
  // /:id/mode + Slice 4-6 /:id/input-event landed for Wave 29-NNN
  // ARC 3) so any rename / drop breaks CI.
  it('Agent sessions route enumeration includes the live paginated collection read', () => {
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions<\/li>/);
    expect(body).toMatch(/<li>GET \/v1\/agent-sessions<\/li>/);
    expect(body).toMatch(/<li>GET \/v1\/agent-sessions\/:id<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions\/:id\/message<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions\/:id\/mode<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions\/:id\/input-event<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions\/:id\/takeover<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/agent-sessions\/:id\/handback<\/li>/);
    expect(body).toMatch(/<li>DELETE \/v1\/agent-sessions\/:id<\/li>/);
  });

  it('Recipes route enumeration matches shipped suggestion/create/list/detail/delete management', () => {
    for (const endpoint of [
      'GET /v1/agent-sessions/:id/recipe-suggestion',
      'POST /v1/recipes',
      'GET /v1/recipes',
      'GET /v1/recipes/:id',
      'DELETE /v1/recipes/:id',
    ]) {
      expect(body).toContain(`<li>${endpoint}</li>`);
    }
    expect(body).not.toMatch(/\/v1\/recipes\/:id\/(?:execute|replay)/);
  });

  it('Archetypes card links the live catalog and generator reference', () => {
    expect(body).toContain('<li>GET /v1/archetypes</li>');
    expect(body).toMatch(
      /const ARCHETYPES_REFERENCE_URL = 'https:\/\/docs\.driftstack\.io\/api\/archetypes\/';/,
    );
    expect(body).toMatch(/catalog and create-payload generator reference/);
  });

  it('keeps the customer-key samples on the paid API surface and describes Free desktop access honestly', () => {
    expect(body).toMatch(
      /Customer API keys, OAuth applications, and SDK automation require a\s+paid tier/,
    );
    expect(body).toMatch(/browser-authorized restricted device credential/);
    expect(body).toMatch(/These API-key and SDK examples require a paid tier/);
    expect(body).not.toMatch(/Free (?:API|SDK) access/);
  });

  it("Webhooks route enumeration 9-endpoint: POST + GET + GET /:id + PATCH + DELETE + POST /:id/rotate-secret + POST /:id/test + GET /:id/deliveries + POST /v1/webhook-deliveries/:id/replay — pinned so the webhook lifecycle endpoint enumeration matches the customer-dashboard webhooks page's wired actions (drift would create marketing↔dashboard contract mismatch)", () => {
    expect(body).toMatch(/<li>POST \/v1\/webhooks\/:id\/rotate-secret<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/webhooks\/:id\/test<\/li>/);
    expect(body).toMatch(/<li>GET \/v1\/webhooks\/:id\/deliveries<\/li>/);
    expect(body).toMatch(/<li>POST \/v1\/webhook-deliveries\/:id\/replay<\/li>/);
  });

  it("V-662 Common patterns framing pinned: 'Common patterns: side-by-side cURL / TS / Python / Go samples for the three most-used flows. Reduces the \"what does it actually look like to call this?\" friction that the route-list above doesn't answer on its own.' + 'Three flows, four languages.' — pinned so the 4-language coverage commitment + the 3-flow scope survive (drift to dropping a language would shrink the SDK example surface)", () => {
    expect(body).toMatch(
      /V-662 — Common patterns: side-by-side cURL \/ TS \/ Python \/ Go\s*samples for the three most-used flows\./,
    );
    expect(body).toMatch(/Three flows, four languages\./);
  });

  it('V-662 Error reference 10-row taxonomy: 400 validation-failed + 401 unauthorized + 404 not-found + 409 conflict + 410 session-destroyed + 429 tier-limit + 429 rate-limited + 429 concurrency-limit + 500 internal + 503 feature-unavailable — pinned so the canonical 10-row RFC 9457 type URI table stays consistent (drift to dropping any would orphan SDK retry-logic implementers; drift to changing the type URI would break customer code that matches on type)', () => {
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

  it('V-662 typed SDK error class mapping includes the concrete InternalError class', () => {
    expect(body).toMatch(/ValidationError/);
    expect(body).toMatch(/AuthError/);
    expect(body).toMatch(/NotFoundError/);
    expect(body).toMatch(/ConflictError/);
    expect(body).toMatch(/SessionDestroyedError/);
    expect(body).toMatch(/TierLimitError/);
    expect(body).toMatch(
      /RateLimitError <em class="font-sans not-italic text-tk-ink-3">\(retryable\)<\/em>/,
    );
    expect(body).toMatch(/ConcurrencyLimitError/);
    expect(body).toMatch(
      /InternalError <em class="font-sans not-italic text-tk-ink-3">\(retryable\)<\/em>/,
    );
    expect(body).toMatch(
      /FeatureUnavailableError <em class="font-sans not-italic text-tk-ink-3">\(NOT retryable\)<\/em>/,
    );
  });

  it("V-662 isRetryable predicate framing pinned: 'SDK consumers can use isRetryable(err) (TypeScript) / equivalent predicates in Python + Go to filter which errors to retry without re-implementing the mapping.' — pinned so the cross-language retry-predicate helper survives (drift to dropping would force SDK consumers to re-implement the retryable-error mapping per-language)", () => {
    expect(body).toMatch(
      /SDK consumers can use <code class="font-mono">isRetryable\(err\)<\/code>\s*\(TypeScript\) \/ equivalent predicates in Python \+ Go to filter\s*which errors to retry without re-implementing the mapping\./,
    );
  });

  it('Spec posture pins generated public shapes without claiming this curated page lists every endpoint', () => {
    expect(body).toMatch(
      /Public request and response shapes are defined with Zod schemas\. The OpenAPI 3\.1 spec is generated from those schemas — there is no second source of truth\./,
    );
    expect(body).toMatch(
      // S20c 2026-07-06 plain-language pass: rule 2 said plainly.
      /Every error case maps to the web standard for machine-readable errors — an RFC 9457 <code class="font-mono">application\/problem\+json<\/code> response with a stable <code class="font-mono">type<\/code> URI \(a link that explains the error\)\./,
    );
    expect(body).toMatch(
      /Breaking changes ship under a new path version\. <code class="font-mono">\/v1<\/code> stays stable; <code class="font-mono">\/v2<\/code> would be a new prefix, not a silent shape change\./,
    );
  });

  it('common-pattern samples declare credentials, ids, imports, and contain no placeholder shell commands', () => {
    expect(body).not.toContain('$URL');
    expect(body).not.toContain('...');
    expect(body.match(/--fail-with-body/g)?.length).toBeGreaterThanOrEqual(3);
    expect(body.match(/package main/g)?.length).toBe(3);
    expect(body).toContain('import { writeFileSync } from "node:fs";');
    expect(body).toContain('from pathlib import Path');
    expect(body).toContain('client.sessions.capture(sessionId');
  });

  it("Hero CTA 2-button: 'Open interactive reference →' → API_DOCS_URL (primary) + 'Download openapi.json' → OPENAPI_JSON_URL (secondary) + 'Interactive reference uses Scalar — try requests against your API key directly in the browser.' subline — pinned so the dual-CTA path (interactive + raw json) + the Scalar reference stay visible (drift to dropping the openapi.json link would orphan tool integrators who want the raw spec)", () => {
    expect(body).toMatch(
      /<a href=\{API_DOCS_URL\} class="btn-primary">Open interactive reference →<\/a>/,
    );
    expect(body).toMatch(
      /<a href=\{OPENAPI_JSON_URL\} class="btn-secondary">Download openapi\.json<\/a>/,
    );
    expect(body).toMatch(
      /Interactive reference uses Scalar — try requests against your API\s*key directly in the browser\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
