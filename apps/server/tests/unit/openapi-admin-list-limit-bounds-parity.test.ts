// Drift-guard: the hand-written OpenAPI spec (apps/server/src/lib/openapi.ts)
// must advertise the SAME `limit` query max as the route schema actually
// enforces, for every admin list endpoint.
//
// Why this guard exists: the spec is hand-maintained separately from the
// route Zod schemas. /v1/admin/accounts drifted — the spec advertised
// `limit` max 200 while the route enforced 100, so an integrator trusting
// the published spec who sent limit=150 got an unexpected 400. No test
// pinned the spec-max ↔ route-max relationship, so the drift was silent.
// This asserts the equality invariant directly (extracts both sides, no
// hardcoded expected value) so any future divergence on either side fails.
//
// The spec declares the query two ways: inline inside the registerRoute
// block (anchor = the path string) or via a named `*QueryOpenApi` const
// above it (anchor = the const name). Each admin list route file carries
// exactly one `limit: z.coerce...max(N)` field, so extracting the single
// match is unambiguous.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const SPEC = readFileSync(resolve(REPO, 'apps/server/src/lib/openapi.ts'), 'utf8');

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), 'utf8');
}

/** The single `limit ... max(N)` the route Zod schema enforces. */
function routeLimitMax(routeFile: string): number | null {
  const src = read(`apps/server/src/routes/${routeFile}`);
  const m = src.match(/limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\((\d+)\)/);
  const g = m?.[1];
  return g !== undefined ? Number(g) : null;
}

/**
 * The `limit ... max(N)` the spec advertises. `anchor` is either a route
 * path (inline query) or a `*QueryOpenApi` const name; in both cases we
 * slice the enclosing block and read the single limit max inside it.
 */
function specLimitMax(anchor: string): number | null {
  const startToken = anchor.startsWith('/v1/')
    ? `path: '${anchor}'`
    : `const ${anchor} = z.object({`;
  const start = SPEC.indexOf(startToken);
  if (start < 0) return null;
  const rest = SPEC.slice(start);
  // Inline path blocks terminate at the next registerRoute(); named const
  // blocks terminate at their first `});`.
  const endTok = anchor.startsWith('/v1/') ? 'registerRoute(' : '});';
  const endIdx = rest.indexOf(endTok, 1);
  const block = endIdx > 0 ? rest.slice(0, endIdx) : rest;
  const m = block.match(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\((\d+)\)/);
  const g = m?.[1];
  return g !== undefined ? Number(g) : null;
}

// endpoint → { route file, spec anchor (path for inline, const for named) }
const ADMIN_LIST_ENDPOINTS: ReadonlyArray<{
  label: string;
  routeFile: string;
  specAnchor: string;
}> = [
  { label: '/v1/admin/accounts', routeFile: 'admin-accounts.ts', specAnchor: '/v1/admin/accounts' },
  {
    label: '/v1/admin/api-keys',
    routeFile: 'admin-api-keys.ts',
    specAnchor: 'ListAdminApiKeysQueryOpenApi',
  },
  {
    label: '/v1/admin/rate-limit-overrides',
    routeFile: 'admin-rate-limit-overrides.ts',
    specAnchor: 'ListAdminOverridesQueryOpenApi',
  },
  {
    label: '/v1/admin/sessions',
    routeFile: 'admin-sessions.ts',
    specAnchor: 'ListAdminSessionsQueryOpenApi',
  },
  {
    label: '/v1/admin/status-subscribers',
    routeFile: 'admin-status-subscribers.ts',
    specAnchor: '/v1/admin/status-subscribers',
  },
];

describe('OpenAPI spec ↔ route `limit` max parity (admin list endpoints)', () => {
  for (const ep of ADMIN_LIST_ENDPOINTS) {
    it(`${ep.label}: spec-advertised limit max === route-enforced limit max`, () => {
      const routeMax = routeLimitMax(ep.routeFile);
      const specMax = specLimitMax(ep.specAnchor);
      expect(routeMax, `route limit max not found in ${ep.routeFile}`).not.toBeNull();
      expect(specMax, `spec limit max not found for ${ep.specAnchor}`).not.toBeNull();
      expect(
        specMax,
        `${ep.label}: spec advertises max ${specMax} but route enforces ${routeMax}`,
      ).toBe(routeMax);
    });
  }
});
