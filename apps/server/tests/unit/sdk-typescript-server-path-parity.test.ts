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

/**
 * Customer-facing operations the DOCUMENT publishes, normalised like the rest.
 *
 * Read from `registerRoute(…)` in `lib/openapi.ts` — the published contract,
 * which is what a customer generates a client from. Staff (`/v1/admin/*`),
 * internal and inbound-provider-webhook surfaces are excluded: they are not part
 * of the customer client surface and most carry no operation at all.
 */
function publishedCustomerPaths(): Set<string> {
  const spec = readFileSync(join(SERVER_SRC, 'lib', 'openapi.ts'), 'utf8');
  const excluded = [
    '/v1/admin/',
    '/v1/internal/',
    '/v1/mac-nodes',
    '/v1/webhooks/stripe',
    '/v1/webhooks/nowpayments',
  ];
  const out = new Set<string>();
  for (const m of spec.matchAll(
    /method:\s*'(?:get|post|put|patch|delete)',\s*\n\s*path:\s*'([^']+)'/g,
  )) {
    const path = (m[1] ?? '').replace(/\{[^}]+\}/g, ':p').replace(/\/$/, '');
    if (excluded.some((e) => path.startsWith(e))) continue;
    out.add(path);
  }
  return out;
}

/**
 * Published customer operations this SDK does not reach, each with its reason.
 *
 * V-1622 — the arm at the top of this file runs SDK -> server: an SDK path that
 * no route serves. The reverse has never been checked, and it is the direction a
 * customer feels: an endpoint the document publishes and the client library
 * cannot call. Measured when this landed, by extracting quoted `/v1/…` path
 * LITERALS from each SDK's source — the TypeScript SDK reaches 100 of 134 customer
 * operations, Python 54 and Go 55, and **none of the 34 below is reachable from
 * Python or Go either**. So this is the customer surface no client library
 * reaches, not a TypeScript omission. (A looser first measurement matched paths as
 * substrings anywhere in each SDK and reported Python 70 / Go 71; it was counting
 * paths that appear only in comments and docstrings.)
 *
 * ⚠️ A reason of REASON OWED means nobody has supplied one. The evidence-backed
 * entries state what was actually checked (a gate that is not `requireAuth`, a
 * non-JSON response body); the rest say plainly that they are undecided. This map
 * exists so a THIRTY-FIFTH cannot appear in silence, not to bless the thirty-four.
 */
const SDK_ABSENT = new Map<string, string>([
  ['/health', 'infra — liveness probe, not customer API surface'],
  [
    '/v1/account/cost',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/account/me/billing-portal',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/account/me/notifications',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/account/me/oauth-links',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/account/me/organization',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/account/mfa/disable',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/agent-sessions/:p/cookies',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/agent-sessions/:p/cookies/set',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/agent-sessions/:p/downloads',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/agent-sessions/:p/downloads/content',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/agent-sessions/:p/files',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/agent-sessions/:p/history',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/agent-sessions/:p/page-state',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/agent-sessions/:p/transcript',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  ['/v1/auth/oauth-client/confirm-merge', 'OAuth 2 browser flow step — redirect-driven'],
  ['/v1/auth/oauth-client/start', 'OAuth 2 browser flow entry — redirect-driven'],
  [
    '/v1/auth/resend-verification',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/billing/crypto-orders/:p/receipt.pdf',
    'returns application/pdf; the SDK’s typed-response shape models JSON only',
  ],
  [
    '/v1/billing/crypto-orders/:p/receipt.txt',
    'returns text/plain; the SDK’s typed-response shape models JSON only',
  ],
  [
    '/v1/egress/echo',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/fleet/events',
    'REASON OWED (OPEN-ITEMS W-7) — a documented customer endpoint with no method here and none in the Python or Go SDKs either',
  ],
  [
    '/v1/oauth/authorize',
    'OAuth 2 protocol — authorizeGate, not requireAuth; driven by a browser redirect from a third-party app, not by the account holder’s client',
  ],
  ['/v1/oauth/introspect', 'OAuth 2 protocol — introspectGate; third-party client credentials'],
  ['/v1/oauth/revoke', 'OAuth 2 protocol — revokeGate; third-party client credentials'],
  [
    '/v1/oauth/token',
    'OAuth 2 protocol — tokenGate; a third-party client exchanges here with its own credentials',
  ],
  [
    '/v1/status',
    'public status page — gated by statusSnapshotGate with no requireAuth, so no API key is involved and no client-library call exists to make',
  ],
  ['/v1/status/incidents', 'public status page — no requireAuth'],
  ['/v1/status/incidents/:p', 'public status page — no requireAuth'],
  ['/v1/status/sla', 'public status page — statusSlaGate, no requireAuth'],
  [
    '/v1/status/subscribe',
    'public status page — subscribeGate, no requireAuth; an email-confirmation flow rather than an API call',
  ],
  [
    '/v1/status/subscribe/confirm',
    'public status page — email-link confirmation, driven by a browser',
  ],
  [
    '/v1/status/subscribe/unsubscribe',
    'public status page — email-link unsubscribe, driven by a browser',
  ],
  ['/version', 'infra — build identity probe, not customer API surface'],
]);

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
    // V-1026 — a ratchet, not a smoke test. This floor was `> 10` against a real
    // population of 100: extraction could have regressed to a dozen paths and every
    // arm below would still have passed while checking an eighth of the SDK. The
    // number rises when the typescript SDK gains endpoints, in the same commit.
    expect(
      sdkPaths.size,
      'typescript SDK paths extracted — if this dropped, the parity arms below are checking a fraction of the surface',
    ).toBeGreaterThanOrEqual(100);

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

  it('V-1622 CRITICAL every published customer operation is reachable from this SDK, or is recorded with its reason. The first arm runs SDK -> server and catches a stale SDK path; this is the reverse, and it is the direction a customer feels — an endpoint the published document offers and no client library can call. Both directions assert: an unrecorded absence fails, and a recorded entry the SDK has since gained fails as stale.', () => {
    const sdkPaths = new Set<string>();
    for (const m of sdkBlob.matchAll(/path:\s*[`'"]([^`'"]+)[`'"]/g)) {
      const raw = m[1]!;
      if (!raw.startsWith('/v1/')) continue;
      sdkPaths.add(raw.replace(/\$\{[^}]+\}/g, ':p').replace(/\/$/, ''));
    }
    const published = publishedCustomerPaths();

    // Vacuity on the READERS. This arm's result is empty once the debt is paid,
    // so an empty result can never itself be the signal that something is wrong.
    expect(sdkPaths.size, 'SDK path literals extracted').toBeGreaterThanOrEqual(100);
    expect(published.size, 'published customer operations extracted').toBeGreaterThanOrEqual(120);

    const absent = [...published].filter((p) => !sdkPaths.has(p)).sort();

    expect(
      absent.filter((p) => !SDK_ABSENT.has(p)),
      'the document publishes these customer operations and this SDK cannot call them, with no reason recorded:',
    ).toEqual([]);

    expect(
      [...SDK_ABSENT.keys()].filter((k) => !absent.includes(k)).sort(),
      'these entries claim the SDK cannot reach an operation and it now can — a stale entry makes the list look considered while hiding nothing:',
    ).toEqual([]);
  });
});
