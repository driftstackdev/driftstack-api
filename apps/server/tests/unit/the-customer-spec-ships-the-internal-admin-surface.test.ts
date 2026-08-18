// V-862 — the whole internal admin surface is published to customers, and the
// source comment said it was not.
//
// `apps/server/src/lib/openapi.ts` carried "Admin endpoints (/v1/admin/oauth/*)
// are NOT registered — they're internal-only." All three are in the generated
// spec. So are 58 other `/v1/admin/*` paths, including
// `/v1/admin/owner/secrets/{name}/reveal`, `/v1/admin/accounts/{id}/delete` and
// `/v1/admin/api-keys/{id}/revoke`.
//
// That document has two customer-facing distributions:
//
//   • `GET /openapi.json` is registered with no preHandler and is rendered at
//     `/docs` by Scalar. The integration test `templated-routes-refuse-anonymous
//     -callers` fetches it anonymously to build its own fixture, which is how
//     this was confirmed rather than assumed.
//   • `packages/sdk-python/openapi.json` ships inside the Python SDK, and
//     `_generated/models.py` carries classes for the admin schemas.
//
// WHAT THIS IS AND IS NOT. Access is not affected: the routes are gated on the
// `driftstack_internal_admin` scope, and the anonymous-caller test proves
// templated routes answer 401/403 without credentials. This is disclosure of
// SHAPE — every privileged path, its parameters and its response schema — to an
// audience that cannot use it. The strongest argument is not obscurity, which is
// weak; it is audience. A customer installing the Python SDK receives a file
// enumerating the endpoint that reveals platform secrets.
//
// WHY THIS FILE DOES NOT FIX IT. The fix is to filter `/v1/admin/*` from the
// generated spec, drop the orphaned component schemas, and regenerate the
// published Python SDK. That is a subtractive change to a served endpoint and a
// shipped package, and it deserves to land as one reviewed unit rather than be
// rushed in beside a comment correction.
//
// So this pins the surface as a CEILING. It can only fall. A new admin route
// widens what customers are handed and fails here, which makes adding one a
// decision instead of a side effect — and when the filter lands, these numbers
// go to zero and this file should be deleted with it.

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const GENERATOR = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');
const SPEC_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/openapi.ts');

/** Measured 2026-08-18. A ceiling, never a target — it may fall, never rise. */
const ADMIN_PATHS_CEILING = 61;
/** Component schemas named for the admin surface. Same rule. */
const ADMIN_SCHEMAS_CEILING = 3;

interface Spec {
  readonly paths: Record<string, unknown>;
  readonly components?: { schemas?: Record<string, unknown> };
}

function spec(): Spec {
  return JSON.parse(readFileSync(SPEC, 'utf8')) as Spec;
}

function adminPaths(): string[] {
  return Object.keys(spec().paths)
    .filter((p) => p.startsWith('/v1/admin/'))
    .sort();
}

function adminSchemas(): string[] {
  return Object.keys(spec().components?.schemas ?? {})
    .filter((k) => k.toLowerCase().startsWith('admin'))
    .sort();
}

describe('V-862 the customer spec ships the internal admin surface', () => {
  it('CRITICAL the spec parses into real content. Every arm below counts a subset, so an empty parse would report zero admin paths and read as a surface that had already been cleaned up — the exact false green this guard exists to prevent.', () => {
    expect(statSync(SPEC).size, 'the shipped spec file').toBeGreaterThan(100_000);
    expect(Object.keys(spec().paths).length, 'total paths in the spec').toBeGreaterThan(150);
    expect(
      Object.keys(spec().components?.schemas ?? {}).length,
      'component schemas',
    ).toBeGreaterThan(50);
  });

  it('CRITICAL the published admin surface does not grow. This is a ceiling, not a pin: it may fall freely and the day it reaches zero this file goes away. A rise means a new privileged endpoint was handed to every customer who installs the SDK, which should be a decision somebody made rather than a consequence of adding a route.', () => {
    expect(
      adminPaths().length,
      'admin paths in the customer-shipped spec — if this rose, a new /v1/admin/* route was published to customers:',
    ).toBeLessThanOrEqual(ADMIN_PATHS_CEILING);
    expect(
      adminSchemas().length,
      'admin-named component schemas, which become classes in the generated Python models:',
    ).toBeLessThanOrEqual(ADMIN_SCHEMAS_CEILING);
  });

  it('CRITICAL the three admin OAuth paths really are published, which is the specific claim the generator comment got wrong. Asserted positively rather than left implicit: the comment said they were not registered, the suite was green, and nothing contradicted it. A guard that only counts would have stayed green too.', () => {
    const published = adminPaths();
    for (const p of [
      '/v1/admin/oauth/clients',
      '/v1/admin/oauth/clients/{id}',
      '/v1/admin/oauth/clients/{id}/rotate-secret',
    ]) {
      expect(published, `${p} is in the customer-shipped spec`).toContain(p);
    }
  });

  it('CRITICAL the generator no longer claims the admin OAuth endpoints are unregistered. The comment is the reason this went unexamined — a reader who trusted it had no reason to look. If the filter ever lands and the claim becomes true again, this arm and the ceiling above should be retired together.', () => {
    const src = readFileSync(GENERATOR, 'utf8');
    expect(src, 'the corrected note must survive edits to this area').toMatch(
      /V-862 — this comment used to say the admin OAuth endpoints/,
    );
    expect(src, 'and the false claim itself must not come back').not.toMatch(
      /are NOT registered — they're internal-only/,
    );
  });

  it('CRITICAL the spec endpoint is still served without an auth gate, which is what makes this a customer-facing surface rather than an internal one. If a gate is ever added, the disclosure argument changes and the ceiling above stops being the interesting measurement.', () => {
    const route = readFileSync(SPEC_ROUTE, 'utf8');
    expect(route, 'the unauthenticated spec route').toMatch(
      /app\.get\('\/openapi\.json',\s*\(\)\s*=>\s*generateOpenApiSpec\(\)\)/,
    );
  });
});
