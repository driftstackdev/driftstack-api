// W373.A — drift guard for marketing-site /api-reference page
// content. V-127a + V-662. Existing api-reference-* tests cover
// resource coverage + status group + SDK class + problem-types
// citation. This guard pins the load-bearing developer-facing
// claims that anchor the API contract narrative:
//
//   • API_DOCS_URL + OPENAPI_JSON_URL constants point at the
//     live Scalar surface (api.driftstack.dev/docs +
//     openapi.json), while the page clearly labels its route map as curated.
//   • V-662 "Three flows, four languages" patterns: each of
//     {create / drive / capture} session has cURL + TypeScript
//     + Python + Go sample.
//   • Default archetype id "iphone17_ios18_7_safari26_4"
//     pinned (matches index.astro + roadmap.astro).
//   • Error taxonomy: 10 rows with stable type URIs (400 / 401
//     / 404 / 409 / 410 / 429×3 / 500 / 503), retryable markers
//     pinned, and SDK class names aligned with packages/sdk-
//     typescript/src/errors.ts.
//   • "No second source of truth" Zod-spec claim pinned.
//   • /v1 stable + /v2 new prefix (no silent shape change)
//     versioning posture pinned.
//   • isRetryable predicate cross-SDK convention pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/api-reference.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W373.A marketing-site /api-reference page content parity', () => {
  const body = read(PAGE);

  it('pins the live Scalar and archetype-generator references', () => {
    expect(body).toMatch(/const API_DOCS_URL = 'https:\/\/api\.driftstack\.dev\/docs'/);
    expect(body).toMatch(
      /const OPENAPI_JSON_URL = 'https:\/\/api\.driftstack\.dev\/openapi\.json'/,
    );
    expect(body).toMatch(
      /const ARCHETYPES_REFERENCE_URL = 'https:\/\/docs\.driftstack\.io\/api\/archetypes\/'/,
    );
    expect(body).toMatch(/Interactive reference uses Scalar/);
  });

  it('documents the live Scalar reference without deferred implementation copy', () => {
    expect(body).toContain('The live API server serves Scalar against the running OpenAPI spec');
    expect(body).not.toMatch(/placeholder|future iteration/i);
  });

  it('labels this page as curated and leaves the exhaustive contract to the live reference', () => {
    expect(body).toMatch(/title="Core routes, exact shapes\."/);
    expect(body).toMatch(
      /This page is a curated map of common resources and runnable\s+request patterns/,
    );
    expect(body).toMatch(
      /interactive reference carries the complete\s+operation and schema catalog/,
    );
    expect(body).not.toMatch(/Every endpoint/i);
  });

  it("V-662 'Three flows, four languages' pattern: each of {create / drive / capture} × {cURL, TS, Python, Go}", () => {
    expect(body).toMatch(/V-662 — Common patterns/);
    expect(body).toMatch(/Three flows, four languages/);
    // 3 flow headings.
    expect(body).toMatch(
      /<h3 class="text-xl font-semibold text-tk-ink">1\. Create a session<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="text-xl font-semibold text-tk-ink">2\. Drive the session<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="text-xl font-semibold text-tk-ink">3\. Capture a screenshot<\/h3>/,
    );
    // Each language appears at least 3× (once per flow).
    for (const langTag of ['# cURL', '// TypeScript', '# Python', '// Go']) {
      const occurrences = body.match(new RegExp(langTag.replace(/[+]/g, '\\$&'), 'g'));
      expect(occurrences, `language tag missing or undercounted: ${langTag}`).not.toBeNull();
      expect(occurrences!.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('default archetype id pinned: iphone17_ios18_7_safari26_4 (aligned with /index + /roadmap)', () => {
    expect(body).toMatch(/iphone17_ios18_7_safari26_4/);
  });

  it('error taxonomy: 10 status-code rows pinned with stable type URIs', () => {
    for (const row of [
      ['400', 'errors.driftstack.dev/validation-failed', 'ValidationError'],
      ['401', 'errors.driftstack.dev/unauthorized', 'AuthError'],
      ['404', 'errors.driftstack.dev/not-found', 'NotFoundError'],
      ['409', 'errors.driftstack.dev/conflict', 'ConflictError'],
      ['410', 'errors.driftstack.dev/session-destroyed', 'SessionDestroyedError'],
      ['429', 'errors.driftstack.dev/tier-limit', 'TierLimitError'],
      ['429', 'errors.driftstack.dev/rate-limited', 'RateLimitError'],
      ['429', 'errors.driftstack.dev/concurrency-limit', 'ConcurrencyLimitError'],
      ['500', 'errors.driftstack.dev/internal', 'InternalError'],
      ['503', 'errors.driftstack.dev/feature-unavailable', 'FeatureUnavailableError'],
    ] as const) {
      const [, typeUri, sdkClass] = row;
      expect(body, `error type URI missing: ${typeUri}`).toContain(typeUri);
      expect(body, `SDK class missing: ${sdkClass}`).toContain(sdkClass);
    }
  });

  it('retryable markers pinned: RateLimitError + InternalError retryable / FeatureUnavailableError NOT retryable', () => {
    expect(body).toMatch(/RateLimitError <em[^>]*>\(retryable\)<\/em>/);
    expect(body).toMatch(/InternalError <em[^>]*>\(retryable\)<\/em>/);
    expect(body).not.toMatch(/DriftstackError \(kind:[\s\S]*?<\/code>\)/);
    expect(body).toMatch(/FeatureUnavailableError <em[^>]*>\(NOT retryable\)<\/em>/);
  });

  it('isRetryable predicate cross-SDK convention pinned', () => {
    expect(body).toMatch(
      /<code class="font-mono">isRetryable\(err\)<\/code>\s*\(TypeScript\) \/ equivalent predicates in Python \+ Go/,
    );
  });

  it('"no second source of truth" Zod-spec claim pinned (twice — hero + spec-posture)', () => {
    // The hero copy splits "no\n        second source of truth"; spec-
    // posture has it inline. Allow whitespace between "no" + "second".
    const occurrences = body.match(/no\s+second source of truth/gi);
    expect(occurrences).not.toBeNull();
    expect(occurrences!.length).toBeGreaterThanOrEqual(2);
  });

  it('/v1 stable + /v2 new-prefix versioning posture pinned (no silent shape change)', () => {
    expect(body).toMatch(
      /Breaking changes ship under a new path version\. <code class="font-mono">\/v1<\/code> stays stable; <code class="font-mono">\/v2<\/code> would be a new prefix, not a silent shape change\./,
    );
  });

  it('RFC 9457 application/problem+json mapping pinned (stable type URI)', () => {
    expect(body).toMatch(
      // S20c 2026-07-06 plain-language pass: same RFC 9457 + stable-type
      // facts, plain words lead ('web standard for machine-readable
      // errors', the URI explained as a link).
      /web standard for machine-readable\s+errors — RFC 9457\s+<code class="font-mono">application\/problem\+json<\/code> — and\s+carries a stable <code class="font-mono">type<\/code> URI: a\s+web link that identifies, and explains, the error kind/,
    );
  });

  it('surface map includes the primary API groups and the public archetype catalog', () => {
    for (const section of [
      'Sessions',
      'Archetypes',
      'Agent sessions',
      'Recipes',
      'Profiles',
      'API keys',
      'Webhooks',
      'Account',
      'Team',
      'Billing — crypto orders',
      'Status',
      'Auth flows',
      'Billing',
    ]) {
      // Use the surface-map heading class to anchor. Fleet v2
      // (2026-07-03): headings re-pinned to the AA-safe accent-text tone.
      expect(body, `surface section missing: ${section}`).toMatch(
        new RegExp(
          `<h3 class="font-mono text-sm uppercase tracking-widest text-tk-accent-text">\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/h3>`,
        ),
      );
    }
    expect(body).toContain('GET /v1/archetypes');
  });

  it('surfaces the live agent collection, recipe management, suggestion, and archetype generator', () => {
    for (const endpoint of [
      'GET /v1/agent-sessions',
      'GET /v1/agent-sessions/:id/recipe-suggestion',
      'POST /v1/recipes',
      'GET /v1/recipes',
      'GET /v1/recipes/:id',
      'DELETE /v1/recipes/:id',
    ]) {
      expect(body).toContain(`<li>${endpoint}</li>`);
    }
    expect(body).toMatch(/catalog and create-payload generator reference/);
    expect(body).not.toMatch(/\/v1\/recipes\/:id\/(?:execute|replay)/);
  });

  it('states the paid customer-key boundary without misrepresenting the Free desktop credential', () => {
    expect(body).toMatch(
      /Customer API keys, OAuth applications, and SDK automation require a\s+paid tier/,
    );
    expect(body).toMatch(/browser-authorized restricted device credential/);
    expect(body).toMatch(/These API-key and SDK examples require a paid tier/);
    expect(body).not.toMatch(/Free (?:API|SDK) access/);
  });

  it('keeps all common-pattern samples free of placeholders and declares their prerequisites', () => {
    expect(body).not.toContain('$URL');
    expect(body).not.toContain('...');
    expect(body.match(/--fail-with-body/g)?.length).toBeGreaterThanOrEqual(3);
    expect(body.match(/package main/g)?.length).toBe(3);
    expect(body).toContain('import { writeFileSync } from "node:fs";');
    expect(body).toContain('from pathlib import Path');
    expect(body).toContain('import base64');
    expect(body).toContain('DRIFTSTACK_SESSION_ID');
    expect(body).toContain('client.sessions.capture(sessionId');
  });

  it('"Capture kind" pins the three live inline capture variants only', () => {
    expect(body).toMatch(
      /capture<\/code> takes one of three kinds:\s*<code class="font-mono">screenshot<\/code>,\s*<code class="font-mono">dom_snapshot<\/code>, or\s*<code class="font-mono">pdf<\/code>/,
    );
    expect(body).toMatch(/nothing is stored\s+server-side/);
    expect(body).not.toMatch(/recording|roadmap/i);
  });
});
