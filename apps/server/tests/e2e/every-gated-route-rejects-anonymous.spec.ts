// V-1038 — the gated surface really does refuse an anonymous caller, measured
// against a running server rather than read out of a preHandler array.
//
// V-1023 derives which routes are gated by matching one of the six auth
// mechanisms in each registration's options. That is a claim about SOURCE TEXT.
// Before this file, only 22 distinct routes had an explicit "401 without auth"
// assertion anywhere in the e2e or integration suites, against 212 gated
// registrations. This boots the real app and asks all of them; 139 are reachable
// in this build and every one refuses.
//
// WHAT THIS DOES NOT PROVE, established by mutation rather than assumed. Deleting
// `app.requireAuth` from a route does NOT open it, so this file cannot tell you a
// route-level gate is doing the work. Two layers refuse before the handler runs:
//
//   1. `app.rateLimit(...)` is account-keyed and throws
//      `UnauthorizedError('Rate limit requires an authenticated request.')` when
//      there is no credential (middleware/rate-limit.ts). Every gated route in
//      this repo also carries a rate-limit preHandler.
//   2. The device-key deny-gate lazy-auths, for the routes it covers.
//
// Either layer alone is sufficient, which the mutations show: deleting the route's
// `requireAuth` still returns 401, and neutralising the rate limiter's
// UnauthorizedError still returns 401. Only removing BOTH opens the route — and
// that this file catches, which is what makes it worth having.
//
// So the rate limiter is load-bearing for authentication, not only throttling.
// And a route quietly losing its own gate is caught by V-1023 reading the source,
// not here: the two are complementary and neither alone covers both directions.
//
// What counts as a pass: 401 for a missing credential, 403 for a present-but-
// insufficient one. Both mean the request was refused. Anything else fails.
//
// With one exception, measured rather than assumed. This build does not serve
// every route the source registers: 30 gated paths answer 503 because their
// feature is unwired and the `…DisabledRoutes` stub is active, and 43 are absent
// entirely at 404. Neither can be asked the question, so both are counted and
// skipped — and the count of routes actually EXERCISED carries a floor, because
// an arm that silently shrank to nothing would pass while checking nothing.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

const REGISTRATION =
  /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g;

/** The six mechanisms, enumerated from `app.decorate` and the preHandler helpers in use. */
const AUTH_MECHANISM =
  /\brequireAuth\b|\brequireAuthEventSource\b|\brequireScope\b|\brequireOwner\b|\brequireInternalAuth\b|\bcontrolKeyOrAccountAuth\b/;

/**
 * Routes excluded from the behavioural check, with the reason.
 *
 * The websocket upgrade authenticates in an inline preHandler and cannot be
 * exercised with an HTTP verb — V-1023 lists it for the same reason.
 */
const NOT_HTTP_TESTABLE: ReadonlySet<string> = new Set(['GET /v1/fleet/events']);

interface Gated {
  readonly verb: 'get' | 'post' | 'put' | 'patch' | 'delete';
  readonly path: string;
  readonly file: string;
}

function gatedRoutes(): Gated[] {
  const out: Gated[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(ROUTES, file), 'utf8');
    const fns = [...src.matchAll(/^export function (\w+)/gm)].map(
      (m) => [m.index, m[1] as string] as const,
    );
    const owner = (pos: number): string => {
      let cur = '(top)';
      for (const [at, name] of fns) {
        if (at <= pos) cur = name;
        else break;
      }
      return cur;
    };
    const ms = [...src.matchAll(REGISTRATION)];
    for (const [i, m] of ms.entries()) {
      // The `…DisabledRoutes` fallbacks re-register the same paths to answer a
      // deployment-state signal; only the live registrar is under test.
      if (/Disabled/.test(owner(m.index))) continue;
      const start = m.index + m[0].length;
      const end = i + 1 < ms.length ? (ms[i + 1]?.index ?? src.length) : src.length;
      const segment = src.slice(start, end);
      const handlerAt = segment.search(/async\s*\(\s*(?:request|req|socket|_)/);
      const options = handlerAt > 0 ? segment.slice(0, handlerAt) : segment.slice(0, 500);
      if (!AUTH_MECHANISM.test(options)) continue;
      const verb = (m[1] ?? 'get') as Gated['verb'];
      const path = m[2] ?? '';
      if (NOT_HTTP_TESTABLE.has(`${verb.toUpperCase()} ${path}`)) continue;
      out.push({ verb, path, file });
    }
  }
  return out;
}

/** Path parameters get a syntactically plausible value; auth runs before the handler reads it. */
function concrete(path: string): string {
  return path
    .replace(/:accountId/g, 'acc_00000000-0000-4000-8000-000000000000')
    .replace(/:sessionId|:id\b/g, 'ses_00000000-0000-4000-8000-000000000000')
    .replace(/:[A-Za-z_]+/g, 'placeholder');
}

const GATED = gatedRoutes();

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('the derived roster really found the gated surface', () => {
  // A matcher that stopped matching would make every case below vacuous by
  // simply having nothing to iterate.
  expect(GATED.length, 'gated registrations derived from source').toBeGreaterThanOrEqual(200);
  expect(
    GATED.some((r) => r.path.startsWith('/v1/admin/')),
    'no admin routes in the roster — the walk missed a file',
  ).toBe(true);
  expect(
    GATED.some((r) => !r.path.startsWith('/v1/admin/')),
    'only admin routes in the roster — the walk missed the customer surface',
  ).toBe(true);
});

test('every gated route the build serves refuses an anonymous request', async ({ request }) => {
  const answered: string[] = [];
  const notServed: string[] = [];
  let exercised = 0;

  for (const route of GATED) {
    const url = `${server.baseUrl}${concrete(route.path)}`;
    const res = await request[route.verb](url, {
      // No Authorization header. A body is supplied so a route that parses one
      // cannot fail for a reason unrelated to authentication.
      data: route.verb === 'get' || route.verb === 'delete' ? undefined : {},
      failOnStatusCode: false,
    });
    const status = res.status();

    // This build does not serve every route the source registers. A feature whose
    // dependencies are unwired gets its `…DisabledRoutes` stub, which answers 503
    // to everyone by design, and a feature with no stub is simply absent (404).
    // Neither is a gate failure, and neither can be checked here — but they are
    // counted, so the arm cannot quietly shrink to nothing.
    if (status === 404 || status === 503) {
      notServed.push(`${route.verb.toUpperCase()} ${route.path} → ${status}`);
      continue;
    }

    exercised += 1;
    if (status !== 401 && status !== 403) {
      answered.push(`${route.verb.toUpperCase()} ${route.path} → ${status}  (${route.file})`);
    }
  }

  expect(
    exercised,
    `only ${exercised} gated routes were actually served by this build (${notServed.length} were ` +
      'absent or behind a disabled stub) — too few for this check to mean anything',
  ).toBeGreaterThanOrEqual(120);

  expect(
    answered.sort(),
    'these routes declare an auth mechanism and are served by this build, but answered an ' +
      'anonymous request with something other than 401/403 — the gate is in the source and not ' +
      'in the response:',
  ).toEqual([]);
});
