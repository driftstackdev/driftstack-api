// W510.B — drift guard for apps/marketing-site/src/pages/docs/api-versioning.astro.
// V-696 API versioning developer doc. Drift here either changes the
// breaking-change definition (would invite customer disputes when
// changes ship) or shifts the deprecation timeline (would create
// marketing↔ops divergence).
//
//   • V-696 doc-comment framing.
//   • /v1/ in URL path, not header.
//   • 8-state breaking-change definition.
//   • 7-state non-breaking change list + 'open enum status' framing.
//   • Deprecation timeline: Day 0 announce + Deprecation header (RFC
//     5988 sunset) + Day 60/30 email + Day 90+ 410 Gone.
//   • Major version transition: 12-month parallel availability.
//   • X-Request-Id always set on response.
//   • SDK semver independent of API.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-versioning.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W510.B apps/marketing-site/src/pages/docs/api-versioning.astro content parity', () => {
  const body = read(LIB);

  it("V-696 framing pinned: 'API versioning developer docs. Covers how versions are expressed, what counts as a breaking change, and how deprecations are communicated.' — pinned so the V-696 anchor + the 3-topic scope (expression / breaking-change-def / deprecation) survive (drift to softening would let the versioning policy drift unintentionally)", () => {
    expect(body).toMatch(
      /\/\/ V-696 — API versioning developer docs\. Covers how versions are\s*\/\/ expressed, what counts as a breaking change, and how deprecations\s*\/\/ are communicated\./,
    );
  });

  it("Version-in-URL-not-header framing pinned: 'Every endpoint is prefixed with /v1/. The version lives in the URL, not in a header, so callers always know which contract they're hitting.' + major prefixes run in parallel — pinned so the in-URL-not-header + parallel-major commitments survive (drift to a header-based scheme would create marketing↔server divergence; drift to dropping the 'parallel' promise would force destructive migrations)", () => {
    expect(body).toMatch(
      /Every endpoint is prefixed with <code>\/v1\/<\/code>\. The version\s*lives in the URL, not in a header, so callers always know\s*which contract they're hitting\./,
    );
    expect(body).toMatch(
      /Breaking changes use a new major prefix such as <code>\/v2\/<\/code>\s*in parallel with v1, so old clients keep working during the\s*announced migration window\./,
    );
  });

  it("8-state breaking-change definition: Removing endpoint + Removing field + Type-change + Renaming + Adding required field + Changing-status-code-meaning + Tightening-validation + Changing-URL-or-method — pinned so the 8-state breaking-change taxonomy stays complete (drift to dropping 'Tightening validation' would let validation-tightening slip in as non-breaking; drift to dropping 'Changing status-code meaning' would let semantic changes break clients silently)", () => {
    expect(body).toMatch(/<li>Removing an endpoint\.<\/li>/);
    expect(body).toMatch(/<li>Removing a field from a response\.<\/li>/);
    expect(body).toMatch(
      /<li>Changing the type of a response field \(e\.g\. string → number\)\.<\/li>/,
    );
    expect(body).toMatch(/<li>Renaming a field\.<\/li>/);
    expect(body).toMatch(
      /<li>Adding a new <strong>required<\/strong> field to a request body\.<\/li>/,
    );
    expect(body).toMatch(/<li>Changing the meaning of an existing status code\.<\/li>/);
    expect(body).toMatch(
      /<li>Tightening validation on an existing field \(e\.g\. shrinking\s*the max length, restricting the regex\)\.<\/li>/,
    );
    expect(body).toMatch(/<li>Changing the URL path or HTTP method of an endpoint\.<\/li>/);
  });

  it("Open-enum status framing pinned: 'Adding a new value to an enum field whose schema is documented as open-ended (e.g. status may gain new states over time — clients should default-handle unknown values).' + 'Build clients defensively against the \"open enum\" cases' — pinned so the open-enum + default-handle-unknown commitment + 'build defensively' guidance survive (drift to dropping the 'open enum' framing would let unsuspecting clients crash on new status values)", () => {
    expect(body).toMatch(
      /Adding a new value to an enum field whose schema is\s*documented as open-ended \(e\.g\. <code>status<\/code> may gain\s*new states over time — clients should default-handle unknown\s*values\)\./,
    );
    expect(body).toMatch(/Build clients defensively against the "open enum" cases/);
  });

  it('Deprecation timeline 3-phase pinned: Day 0 announce + Deprecation header (RFC 5988 sunset) + Day 0–90 working (60d/30d email reminders) + Day 90+ 410 Gone — pinned so the 3-phase deprecation cadence + the RFC 5988 sunset-header format + the 410-Gone-with-replacement-pointer commitments survive (drift to a different status (e.g. 404) would create marketing↔server divergence; drift to dropping the 60d/30d email pattern would let deprecations land unannounced)', () => {
    expect(body).toMatch(
      /<strong>Day 0:<\/strong> Deprecation announced in the\s*<a href="\/changelog\/">changelog<\/a> and via a\s*<code>Deprecation<\/code> response header on the affected\s*endpoint\. The header includes a sunset date in RFC 5988\s*format\./,
    );
    expect(body).toMatch(
      /<strong>Day 0 → 90:<\/strong> Endpoint continues to work\s*unchanged\. We email accounts that have called the endpoint\s*in the last 30 days at the 60-day and 30-day marks\./,
    );
    expect(body).toMatch(
      /<strong>Day 90\+:<\/strong> Endpoint returns a non-fatal\s*<code>410 Gone<\/code> with a pointer to the replacement\./,
    );
  });

  it("Major version transition 12-month framing pinned: 'Major version transitions (v1 → v2) follow a longer schedule: minimum 12 months of parallel availability, with the same 60-day / 30-day email reminders.' — pinned so the 12-month-parallel-availability commitment survives (drift to a shorter window would force customer migrations on tighter timelines than the doc commits to)", () => {
    expect(body).toMatch(
      /Major version transitions \(v1 → v2\) follow a longer schedule:\s*<strong>minimum 12 months<\/strong> of parallel availability,\s*with the same 60-day \/ 30-day email reminders\./,
    );
  });

  it("X-Request-Id always-set commitment pinned: 'The X-Request-Id header is always set on the response; our SDKs surface it on every typed error.' — pinned so the always-on request-id header + SDK-surfaces-on-error commitment survive (drift to softening 'always' would let customers question whether they can rely on the header)", () => {
    expect(body).toMatch(
      /The\s*<code>X-Request-Id<\/code> header is always set on the response;\s*our SDKs surface it on every typed error\./,
    );
  });

  it("Beta-endpoints framing pinned: 'No customer-facing endpoints are in beta today — the surface under /v1/ is stable per the breaking-change policy above.' + beta paths are labeled and announced before use — pinned so the no-beta-today commitment + beta announcement-path framing survive (drift to ambiguously claiming 'some endpoints are beta' would weaken the v1 stability guarantee)", () => {
    expect(body).toMatch(
      /No customer-facing endpoints are in beta today — the surface\s*under <code>\/v1\/<\/code> is stable per the breaking-change policy\s*above\./,
    );
    expect(body).toMatch(
      /Any beta path is explicitly labeled on its docs page and\s*announced in the <a href="\/changelog\/">changelog<\/a> before use\./,
    );
  });

  it('v1 5-guarantee pinned: same URL paths + same response shapes (additive only) + same status-code semantics + same auth scheme (Bearer or OAuth) + same idempotency semantics (DELETE / POST / PUT/PATCH) — pinned so the 5-guarantee v1 contract survives (drift to dropping the auth-scheme guarantee would invite OAuth-only or API-key-only shifts; drift to dropping the idempotency guarantee would let DELETE become non-idempotent silently)', () => {
    expect(body).toMatch(/<li>The same URL paths\.<\/li>/);
    expect(body).toMatch(/<li>The same response shapes \(additive fields only\)\.<\/li>/);
    expect(body).toMatch(/<li>The same status-code semantics\.<\/li>/);
    expect(body).toMatch(/<li>The same authentication scheme \(Bearer API key or OAuth\)\.<\/li>/);
    expect(body).toMatch(
      /<li>The same idempotency semantics \(DELETE is idempotent,\s*POST creates new resources, PUT\/PATCH are explicit\s*replacements\)\.<\/li>/,
    );
  });

  it('SDK semver independent of API + 0.x current pre-1.0 line + supported 1.x→v1 + 2.x→v2 mapping pinned — pinned so the SDK-independent-semver + current compatibility rules survive (drift to claiming SDK majors track API majors 1:1 today would create marketing↔SDK-versioning divergence)', () => {
    expect(body).toMatch(
      /The official SDKs \(<a href="\/docs\/sdk-typescript\/">TypeScript<\/a>,\s*<a href="\/docs\/sdk-python\/">Python<\/a>,\s*<a href="\/docs\/sdk-go\/">Go<\/a>\) follow semver independently of\s*the API\./,
    );
    expect(body).toMatch(/SDK <code>0\.x<\/code> is the current pre-1\.0 line/);
    expect(body).toMatch(
      /SDK majors and API majors are independent:\s*a supported SDK <code>1\.x<\/code> can still target API\s*<code>\/v1\/<\/code>, while an SDK targeting API <code>\/v2\/<\/code>\s*uses SDK <code>2\.x<\/code>\./,
    );
    for (const path of ['/changelog', '/docs/sdk-typescript', '/docs/sdk-python', '/docs/sdk-go']) {
      expect(body).not.toContain(`href="${path}"`);
    }
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
