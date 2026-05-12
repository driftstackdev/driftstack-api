// W373.A — drift guard for marketing-site /api-reference page
// content. V-127a + V-662. Existing api-reference-* tests cover
// resource coverage + status group + SDK class + problem-types
// citation. This guard pins the load-bearing developer-facing
// claims that anchor the API contract narrative:
//
//   • API_DOCS_URL + OPENAPI_JSON_URL constants point at the
//     live Scalar surface (api.driftstack.dev/docs +
//     openapi.json). The marketing page is a deliberate
//     placeholder until the build embeds Scalar standalone.
//   • V-662 "Three flows, four languages" patterns: each of
//     {create / drive / capture} session has cURL + TypeScript
//     + Python + Go sample.
//   • Default archetype id "iphone16pro_ios18_7_safari26_4"
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

  it('API_DOCS_URL + OPENAPI_JSON_URL constants pinned (live Scalar surface)', () => {
    expect(body).toMatch(/const API_DOCS_URL = 'https:\/\/api\.driftstack\.dev\/docs'/);
    expect(body).toMatch(
      /const OPENAPI_JSON_URL = 'https:\/\/api\.driftstack\.dev\/openapi\.json'/,
    );
    expect(body).toMatch(/Interactive reference uses Scalar/);
  });

  it('V-127a placeholder framing pinned (future build-time Scalar embed)', () => {
    expect(body).toMatch(/V-127a placeholder/);
    expect(body).toMatch(
      /Future iteration: build-time fetch of \/openapi\.json \+ embed\s*\n?\s*\/\/\s*Scalar's standalone HTML/,
    );
  });

  it("V-662 'Three flows, four languages' pattern: each of {create / drive / capture} × {cURL, TS, Python, Go}", () => {
    expect(body).toMatch(/V-662 — Common patterns/);
    expect(body).toMatch(/Three flows, four languages/);
    // 3 flow headings.
    expect(body).toMatch(
      /<h3 class="text-xl font-semibold text-slate-900">1\. Create a session<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="text-xl font-semibold text-slate-900">2\. Drive the session<\/h3>/,
    );
    expect(body).toMatch(
      /<h3 class="text-xl font-semibold text-slate-900">3\. Capture a screenshot<\/h3>/,
    );
    // Each language appears at least 3× (once per flow).
    for (const langTag of ['# cURL', '// TypeScript', '# Python', '// Go']) {
      const occurrences = body.match(new RegExp(langTag.replace(/[+]/g, '\\$&'), 'g'));
      expect(occurrences, `language tag missing or undercounted: ${langTag}`).not.toBeNull();
      expect(occurrences!.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('default archetype id pinned: iphone16pro_ios18_7_safari26_4 (aligned with /index + /roadmap)', () => {
    expect(body).toMatch(/iphone16pro_ios18_7_safari26_4/);
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
      ['500', 'errors.driftstack.dev/internal', 'DriftstackError'],
      ['503', 'errors.driftstack.dev/feature-unavailable', 'FeatureUnavailableError'],
    ] as const) {
      const [, typeUri, sdkClass] = row;
      expect(body, `error type URI missing: ${typeUri}`).toContain(typeUri);
      expect(body, `SDK class missing: ${sdkClass}`).toContain(sdkClass);
    }
  });

  it('retryable markers pinned: RateLimitError + DriftstackError(internal) retryable / FeatureUnavailableError NOT retryable', () => {
    expect(body).toMatch(/RateLimitError <em[^>]*>\(retryable\)<\/em>/);
    expect(body).toMatch(/DriftstackError \(kind:[\s\S]*?<\/code>\) <em[^>]*>\(retryable\)<\/em>/);
    expect(body).toMatch(/FeatureUnavailableError <em[^>]*>\(NOT retryable\)<\/em>/);
  });

  it('isRetryable predicate cross-SDK convention pinned', () => {
    expect(body).toMatch(
      /<code class="font-mono">isRetryable\(err\)<\/code>\s*\n?\s*\(TypeScript\) \/ equivalent predicates in Python \+ Go/,
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

  it('RFC 7807 application/problem+json mapping pinned (stable type URI)', () => {
    expect(body).toMatch(
      /RFC 7807\s+<code class="font-mono">application\/problem\+json<\/code> with a\s+stable <code class="font-mono">type<\/code> URI/,
    );
  });

  it('10 surface-map sections present (Sessions / Profiles / API keys / Webhooks / Account / Team / Billing-crypto / Status / Auth / Billing)', () => {
    for (const section of [
      'Sessions',
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
      // Use the surface-map heading class to anchor.
      expect(body, `surface section missing: ${section}`).toMatch(
        new RegExp(
          `<h3 class="font-mono text-sm uppercase tracking-widest text-oxblood-700">\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/h3>`,
        ),
      );
    }
  });

  it('"Capture kind" 4-variant explainer pinned (screenshot / dom / pdf / recording)', () => {
    expect(body).toMatch(
      /capture<\/code> takes one of four kinds:\s*\n?\s*<code class="font-mono">screenshot<\/code>,\s*<code class="font-mono">dom<\/code>,\s*\n?\s*<code class="font-mono">pdf<\/code>, or <code class="font-mono">recording<\/code>/,
    );
    expect(body).toMatch(/recordings stream to R2 \+ return a\s+signed-URL handle/);
  });
});
