// W249.C — drift-guard between the TypeScript SDK and the server's
// registered routes. Every `path: '/v1/...'` literal in the SDK
// resources must correspond to a server-side route registration.
// Catches the case where an SDK method points at a stale path after
// a server-side rename.
//
// V-987 — the sentence above is the claim this file has always made. Until now
// it checked something weaker: `serverPaths` was built from ANY quoted `/v1/…`
// literal anywhere under `apps/server/src`, which includes `lib/openapi.ts`
// (a spec DECLARATION, not a registration), middleware policy rosters, and
// error-message text. A path can appear in all of those while no route serves it.
//
// Demonstrated rather than reasoned: renaming the real registration
// `app.get('/v1/archetypes'` to `/v1/archetype-catalog` left this file GREEN,
// because `lib/openapi.ts` still declared `path: '/v1/archetypes'`. That is the
// precise scenario the header says it catches, and it did not.
//
// The set is now built from registration calls only. Measured before the change:
// 214 quoted literals under `apps/server/src` against 209 real registrations, and
// all 100 TypeScript SDK paths map to registrations — so tightening this costs
// nothing today. The hole was latent, not live, which is the moment to close it.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const SDK_RESOURCES = join(REPO, 'packages', 'sdk-typescript', 'src', 'resources');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function readAll(dir: string, ext: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out += readAll(p, ext);
    } else if (entry.name.endsWith(ext)) {
      out += readFileSync(p, 'utf8');
      out += '\n';
    }
  }
  return out;
}

/**
 * Paths the server actually REGISTERS, normalised for comparison.
 *
 * Anchored on the `app.<verb>(` call so a declaration cannot pass for an
 * endpoint. The optional `<…>` allows a type argument, and the `\s*` before the
 * quote allows the path to sit on the next line — both forms the routes use.
 */
function registeredPaths(blob: string): Set<string> {
  const out = new Set<string>();
  for (const m of blob.matchAll(
    /app\.(?:get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g,
  )) {
    out.add((m[1] ?? '').replace(/:[a-zA-Z_]+/g, ':p').replace(/\/$/, ''));
  }
  return out;
}

describe('W249.C SDK-typescript ↔ server path parity', () => {
  const sdkBlob = readAll(SDK_RESOURCES, '.ts');
  const serverBlob = readAll(SERVER_SRC, '.ts');

  it('every SDK path literal resolves to a server route', () => {
    // Normalise a path: replace `${encodeURIComponent(x)}` and any
    // other ${…} placeholder with `:p`. Then look for the same
    // normalised shape on the server side, also normalising server
    // `:param` segments.
    const sdkPaths = new Set<string>();
    for (const m of sdkBlob.matchAll(/path:\s*[`'"]([^`'"]+)[`'"]/g)) {
      const raw = m[1]!;
      if (!raw.startsWith('/v1/')) continue;
      // SDK uses template literals like `/v1/foo/${encodeURIComponent(id)}/bar`.
      const normalized = raw.replace(/\$\{[^}]+\}/g, ':p').replace(/\/$/, '');
      sdkPaths.add(normalized);
    }
    expect(sdkPaths.size).toBeGreaterThan(10);

    const serverPaths = registeredPaths(serverBlob);

    const missing = [...sdkPaths].filter((p) => !serverPaths.has(p));
    expect(
      missing,
      'these SDK paths are not REGISTERED by any route — a path that merely appears in ' +
        'lib/openapi.ts or a policy roster is a declaration, not an endpoint:',
    ).toEqual([]);
  });

  it('V-987 CRITICAL the server side is route REGISTRATIONS, not every /v1 string in the source tree. Asserted against fixtures because the repo is currently consistent, which is exactly when this distinction is invisible: a spec declaration, a middleware policy row and an error message all contain the path, so the loose form of this check passes for an endpoint nothing serves. Renaming a real registration left the old check green because openapi.ts still declared the old path.', () => {
    const registration = "app.get('/v1/thing', handler);";
    const withTypeArg = "app.post<{ Params: { id: string } }>(\n  '/v1/thing/:id/act',\n  opts,";
    const declaration = "  { method: 'GET', path: '/v1/declared-only', summary: 'x' },";
    const policyRow = "  'POST:/v1/policy-listed/:id/replay',";
    const errorText = "throw new Error('use /v1/mentioned-in-prose instead');";

    expect(registeredPaths(registration).has('/v1/thing'), 'a plain registration').toBe(true);
    expect(
      registeredPaths(withTypeArg).has('/v1/thing/:p/act'),
      'a registration whose path follows a type argument on the next line — the form the ' +
        'webhook-delivery replay route uses',
    ).toBe(true);
    expect(registeredPaths(declaration).size, 'an OpenAPI declaration is not a registration').toBe(
      0,
    );
    expect(registeredPaths(policyRow).size, 'a middleware policy row is not a registration').toBe(
      0,
    );
    expect(registeredPaths(errorText).size, 'a path named in prose is not a registration').toBe(0);
  });
});
