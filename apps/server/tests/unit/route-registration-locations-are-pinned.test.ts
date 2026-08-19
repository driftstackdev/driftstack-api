// Where routes are allowed to live — and auth coverage for the one exception.
//
// Five guards in this directory assert security properties of "every route":
// auth coverage, admin authorization, the effective-account header, mutation
// rate-limiting, and the free-desktop policy. All five scan `src/routes`.
//
// `src/lib/app.ts` also registers routes. That is one file today and its five
// routes are all correct — four deliberately public ops endpoints and
// `/v1/whoami`, which carries `requireAuth` and `rateLimit('global')`. So this
// is latent, not live, and it is worth being precise about how latent:
//
//   * BEFORE this file existed, stripping `requireAuth` from `/v1/whoami` red
//     exactly ONE test — the hand-written content-parity pin that holds that
//     line verbatim. None of the five route guards noticed, because the file is
//     outside their root. Re-measured 2026-08-17: it now reds TWO, that pin plus
//     this file's own arm, which is the whole point. The count is written as a
//     BEFORE reading because a bare "reds exactly one" would read as current
//     state and be wrong the moment a guard is added — which is what happened.
//   * Adding a NEW unauthenticated route there reds three tests. But all three
//     check DOCUMENTATION coverage — openapi-route-coverage twice and
//     public-route-has-a-consumer. Document the route and give it a consumer
//     and they go quiet, with no auth check ever having run.
//
// Both were measured by mutation, not reasoned about, because the interesting
// claim here is about what does NOT fire and that cannot be read off the source.
//
// The fix is not to widen five parsers onto a sixth file shape. It is to make
// the shared assumption CHECKED: routes live under `src/routes`, except for a
// named file whose routes this guard verifies itself. A guard that assumes its
// own root is complete has the defect it exists to catch — which is what makes
// a third registration site the thing to fail on, loudly, the day it appears.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/** Registration sites the five `src/routes` guards do NOT cover. */
const ALLOWED_OUTSIDE_ROUTES: readonly string[] = ['lib/app.ts'];

/**
 * Routes in `lib/app.ts` that intentionally require no authentication.
 *
 * Each is an ops endpoint that must answer before, or without, a credential —
 * verified at the handler, not assumed from the path.
 */
const DELIBERATELY_PUBLIC: ReadonlyMap<string, string> = new Map([
  ['GET /health', 'liveness probe — must answer before any dependency is up'],
  ['GET /healthz', 'liveness probe under the kube-style name'],
  ['GET /version', 'V-195 — deploy SHA for ops tooling that has no credential'],
  ['GET /ready', 'readiness probe — reports dependency state to the load balancer'],
]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const REGISTRATION = /\bapp\.(get|post|put|patch|delete)[<(]/;

/** Source files that register at least one HTTP route, repo-relative. */
function registrationSites(): string[] {
  return tsFilesUnder(SRC)
    .filter((f) => REGISTRATION.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f))
    .sort();
}

interface AppRoute {
  readonly key: string;
  readonly authed: boolean;
}

/**
 * Every `app.method(…)` registration in a source, in BOTH shapes Fastify allows:
 * plain, and carrying a type argument (`app.post<{ Params: … }>(`).
 *
 * V-948 — the second shape is not a corner case. 119 of the 285 registrations
 * under `src/routes` carry a type argument, 41% of the surface, and a pattern
 * anchored on `\(` right after the method name sees none of them.
 */
const REGISTRATION_ANY = /\bapp\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(/g;

/**
 * Routes registered directly in `lib/app.ts`, with whether they authenticate.
 *
 * V-948 — this used to parse ONE line-anchored shape, `app.method('/path', …)`
 * with the options object on the same line, and its comment claimed "the count
 * case below fails if the shape ever changes, rather than silently parsing fewer
 * routes". That was not true. The count case was a FLOOR of 5, and 5 is what the
 * file has: a sixth registration written multi-line, or with a type argument like
 * 41% of the routes surface, parsed to nothing and cleared the floor. The auth arm
 * below — which its own text calls the only thing in the repo auditing this file —
 * would never have seen it.
 *
 * So the parse is no longer line-anchored, and the count case no longer floors.
 * It compares against `REGISTRATION_ANY`, which recognises both shapes: every
 * registration in the file must be accounted for, so a shape this parser cannot
 * read fails here instead of disappearing.
 *
 * `authed` is read from the registration head — the text between the opening
 * paren and the handler's arrow. An inline-arrow preHandler would truncate that
 * early and report the route as unguarded, which fails loudly; the failure
 * direction is deliberate.
 */
function appTsRoutes(): AppRoute[] {
  const src = readFileSync(resolve(SRC, 'lib', 'app.ts'), 'utf8');
  const out: AppRoute[] = [];
  for (const m of src.matchAll(REGISTRATION_ANY)) {
    const after = src.slice(m.index + m[0].length);
    const path = /^\s*'([^']+)'/.exec(after);
    if (path === null) continue;
    const arrow = after.indexOf('=>');
    const head = after.slice(0, arrow === -1 ? 400 : arrow);
    out.push({
      key: `${m[1]!.toUpperCase()} ${path[1]!}`,
      authed: head.includes('app.requireAuth'),
    });
  }
  return out;
}

/** How many registrations the file contains, independent of the parse above. */
function appTsRegistrationCount(): number {
  const src = readFileSync(resolve(SRC, 'lib', 'app.ts'), 'utf8');
  return [...src.matchAll(REGISTRATION_ANY)].length;
}

describe('route registrations live where the route guards can see them', () => {
  it('CRITICAL the scan found real registration sites. An empty scan would make every case below vacuously true, and each one guards an ABSENCE — so a broken scan hides the same shape three times over.', () => {
    const sites = registrationSites();
    expect(sites.length, 'source files registering routes').toBeGreaterThan(50);
    expect(
      sites.filter((f) => f.startsWith('routes/')).length,
      'registration sites under routes/',
    ).toBeGreaterThan(50);
  });

  it('CRITICAL routes are registered only under src/routes or a named exception. The five route-security guards scan src/routes alone, so a third registration site is surface none of them audit — and the mutation that proved this class showed the tests that DO fire check documentation, not auth.', () => {
    const stray = registrationSites()
      .filter((f) => !f.startsWith(`routes/`))
      .filter((f) => !ALLOWED_OUTSIDE_ROUTES.includes(f))
      .sort();
    expect(
      stray,
      'file(s) registering routes outside src/routes — either move them, or add the file here AND extend the five route-security guards to cover it:',
    ).toEqual([]);
  });

  it('CRITICAL EVERY registration in lib/app.ts is parsed, not merely five of them. Compared against an independent count rather than floored: the floor this replaces could not tell a route the parser could not read from a route that was not there, so a sixth registration written multi-line — or with a type argument, which 41% of the routes surface uses — would have skipped the auth arm below entirely.', () => {
    const routes = appTsRoutes();
    expect(routes.length, 'routes parsed from lib/app.ts').toBeGreaterThanOrEqual(5);
    expect(
      routes.length,
      'a registration in lib/app.ts was not parsed. It is still registered and still serving; it is ' +
        'just invisible to the auth arm below. Widen the parse rather than lowering this',
    ).toBe(appTsRegistrationCount());
    expect(
      routes.map((r) => r.key),
      'the authenticated one must be among them',
    ).toContain('GET /v1/whoami');
  });

  it('CRITICAL the registration pattern recognises a TYPE-ARGUMENT registration. Tested against a literal fixture rather than the current file, because lib/app.ts happens to use only the plain shape today — so a pattern blind to the other shape would look perfectly healthy right up to the commit that adds one, which is exactly how the parse this replaces stayed wrong.', () => {
    const generic = "  app.post<{ Params: { id: string } }>(\n    '/v1/things/:id',\n";
    const plain = "  app.post(\n    '/v1/things',\n";
    for (const [label, fixture] of [
      ['type-argument', generic],
      ['plain', plain],
    ] as const) {
      expect(
        [...fixture.matchAll(REGISTRATION_ANY)].length,
        `the registration pattern sees a ${label} registration`,
      ).toBe(1);
    }

    // And the fixture is not hypothetical — the shape is most of this codebase.
    // Floored well under the 119 measured so ordinary route churn does not touch
    // this, while a claim that the shape is rare stays falsifiable.
    const withTypeArgument = registrationSites()
      .filter((f) => f.startsWith('routes/'))
      .reduce(
        (n, f) =>
          n +
          [
            ...readFileSync(resolve(SRC, f), 'utf8').matchAll(
              /\bapp\.(?:get|post|put|patch|delete)\s*</g,
            ),
          ].length,
        0,
      );
    expect(
      withTypeArgument,
      'type-argument registrations under src/routes — if this collapses, either the surface was ' +
        'rewritten or this measurement broke, and the fixture above is no longer describing anything real',
    ).toBeGreaterThan(60);
  });

  it('CRITICAL every route in lib/app.ts authenticates or is a named public ops endpoint. Nothing else covers this: stripping requireAuth from /v1/whoami reds only the content-parity pin that happens to quote that line, and a documented new route here passes every guard in the repo.', () => {
    const unguarded = appTsRoutes()
      .filter((r) => !r.authed)
      .filter((r) => !DELIBERATELY_PUBLIC.has(r.key))
      .map((r) => r.key)
      .sort();
    expect(
      unguarded,
      'route(s) in lib/app.ts with neither requireAuth nor a stated reason to be public:',
    ).toEqual([]);
  });

  it('CRITICAL the public allowlist may only SHRINK. An entry for a route that no longer exists, or that has since gained requireAuth, stops meaning "checked" and starts meaning "ignored".', () => {
    const byKey = new Map(appTsRoutes().map((r) => [r.key, r]));
    const stale: string[] = [];
    for (const key of DELIBERATELY_PUBLIC.keys()) {
      const route = byKey.get(key);
      if (route === undefined) stale.push(`${key} — no longer registered in lib/app.ts`);
      else if (route.authed) stale.push(`${key} — now authenticates, remove the exemption`);
    }
    expect(stale.sort(), 'public-allowlist entr(ies) that no longer describe reality:').toEqual([]);
  });
});
