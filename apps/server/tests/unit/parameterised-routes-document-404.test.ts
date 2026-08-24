// Every path-parameterised route either documents 404 or says why it cannot.
//
// The OpenAPI spec drives codegen — `packages/sdk-python/openapi.json` encodes
// each operation's response status set — so a status a route returns but the
// spec omits is a status a customer's generated client never models. Seven
// routes were in that state, three of them customer-facing proxy endpoints
// whose own source comment already said "404 for an unknown/foreign id".
//
// A blanket "every `/{id}` route must document 404" would be wrong in the other
// direction, and that is not hypothetical: five routes here legitimately never
// 404, and telling an SDK to model a branch that cannot occur is its own defect.
// So the rule is: document it, or be listed with a reason that was checked.
//
// Every exemption below was verified at the source, not inferred from the path:
// each names the file and the behaviour that makes 404 unreachable. An entry
// that cannot be justified that way does not belong here — an allowlist whose
// entries nobody re-checked is how a guard turns into decoration.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '..', '..', 'src', 'lib', 'openapi.ts');

/**
 * Routes that CANNOT return 404, with the reason each was cleared.
 *
 * Keyed `METHOD path`. Verified individually; the reason is the point of the
 * entry, because it is what a reviewer checks when the handler changes.
 */
const NO_404_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'DELETE /v1/profiles/{id}',
    'idempotent delete — profiles service does `if (!ok) return`, so a missing profile is a 204',
  ],
  [
    'DELETE /v1/admin/oauth/clients/{id}',
    'idempotent delete — revokeClient returns void and both stores no-op on an unknown id, so a missing client is a 204. This one DOCUMENTED a 404 it could never return, which is why it never surfaced here: the check below asks whether 404 is documented, and it was.',
  ],
  [
    'POST /v1/admin/oauth/clients/{id}/rotate-secret',
    'unknown client throws OAuthError(invalid_client), which oauthErrorToHttp maps to 401 — not 404',
  ],
  [
    'PUT /v1/admin/owner/secrets/{name}',
    'upsert — an absent name is created, so there is nothing to miss',
  ],
  [
    'PATCH /v1/admin/owner/pricing/{tier}',
    'tier is enum-validated in the params schema, so an unknown tier is a 400',
  ],
  [
    'POST /v1/admin/validation-schedules/{archetype}/trigger',
    'harness.triggerNow accepts any archetype id and enqueues; it never looks one up',
  ],
]);

/** Status codes carried by each `...spread` constant in the spec. */
function spreadCodes(spec: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of spec.matchAll(/const (\w+) = \{([\s\S]{0,1200}?)\n {2}\};/g)) {
    const codes = new Set([...m[2]!.matchAll(/\n\s*(\d{3}):/g)].map((c) => c[1]!));
    if (codes.size > 0) out.set(m[1]!, codes);
  }
  return out;
}

interface Route {
  readonly key: string;
  readonly codes: ReadonlySet<string>;
}

/**
 * Every registered route with its documented status codes, spreads resolved.
 *
 * Resolving spreads is not optional: `directSessionOperationErrors` alone
 * carries 404/409/410/502/503, and a scan that only reads literal numbers
 * reported eight session routes as missing a 404 they document perfectly well.
 */
function routes(): Route[] {
  const spec = readFileSync(SPEC, 'utf8');
  const spreads = spreadCodes(spec);
  const out: Route[] = [];
  for (const block of spec.split('registerRoute(r, {').slice(1)) {
    const path = /path: '([^']+)'/.exec(block);
    const method = /method: '(\w+)'/.exec(block);
    if (path === null || method === null) continue;
    const start = block.indexOf('responses:');
    const body = start >= 0 ? block.slice(start, start + 1400) : '';
    const codes = new Set([...body.matchAll(/\n\s*(\d{3}):/g)].map((c) => c[1]!));
    for (const s of body.matchAll(/\.\.\.(\w+)/g)) {
      for (const c of spreads.get(s[1]!) ?? []) codes.add(c);
    }
    out.push({ key: `${method[1]!.toUpperCase()} ${path[1]!}`, codes });
  }
  return out;
}

describe('path-parameterised routes document 404 or are exempt with a reason', () => {
  it('CRITICAL the spec parsed into real routes with real codes. An empty parse would make the check below vacuously true, and the failure it guards is an omission — so a broken parse would hide the same shape twice.', () => {
    const all = routes();
    expect(all.length, 'routes parsed from the spec').toBeGreaterThan(200);
    expect(
      all.filter((r) => r.codes.size > 0).length,
      'routes with documented status codes',
    ).toBeGreaterThan(200);
  });

  it('CRITICAL spreads are resolved, so a route documenting 404 via `...directSessionOperationErrors` is not reported as missing it. Without this the guard produces false findings and gets ignored, which is worse than not existing.', () => {
    const nav = routes().find((r) => r.key === 'POST /v1/sessions/{id}/navigate');
    expect(nav, 'the session navigate route is in the spec').toBeDefined();
    expect(nav!.codes, 'its 404 comes from a spread, not a literal').toContain('404');
  });

  it('CRITICAL every parameterised route documents 404 or is exempt. A status the route returns but the spec omits is one a generated SDK never models — that is how three customer-facing proxy endpoints shipped a 404 no client handled.', () => {
    const missing = routes()
      .filter((r) => r.key.includes('{'))
      .filter((r) => !r.codes.has('404'))
      .filter((r) => !NO_404_BY_DESIGN.has(r.key))
      .map((r) => r.key)
      .sort();
    expect(
      missing,
      'parameterised route(s) with no documented 404 — document it, or add an exemption with the reason it cannot 404:',
    ).toEqual([]);
  });

  it('CRITICAL the exemption list may only SHRINK. An entry for a route that no longer exists, or that has since gained a 404, stops meaning "checked" and starts meaning "ignored" — which is exactly how the stale dashboard-only list in this repo began misleading people.', () => {
    const byKey = new Map(routes().map((r) => [r.key, r]));
    const stale: string[] = [];
    for (const key of NO_404_BY_DESIGN.keys()) {
      const route = byKey.get(key);
      if (route === undefined) stale.push(`${key} — no longer in the spec`);
      else if (route.codes.has('404'))
        stale.push(`${key} — now documents 404, remove the exemption`);
    }
    expect(stale.sort(), 'exemption(s) that no longer describe reality:').toEqual([]);
  });
  /**
   * V-1487 — a route can 404 without having a path parameter.
   *
   * Everything above keys on `/{id}`, because the motivating failure was a
   * lookup missing. That scope is why four MFA operations escaped it: they take
   * no path parameter and 404 on a STATE — "MFA is not enrolled for this
   * account" — thrown from the service, not from an id that resolved to
   * nothing. `docs/api/mfa` had documented that 404 all along; the spec had
   * never declared it.
   *
   * So this arm works from the SERVICE outwards instead of from the path
   * inwards: for each route whose handler delegates to a named service method,
   * read the errors that method throws and require the published operation to
   * declare the status each maps to. Derived on the error side, so a new
   * `throw new ConflictError` in a covered method fails here rather than
   * reaching a customer as an undeclared 409.
   *
   * The route→method pairing is listed because it cannot be derived reliably —
   * handlers call services through several shapes. The staleness arm below
   * keeps that list honest: every method named must still exist and still
   * throw.
   */
  const ERROR_STATUS: Record<string, string> = {
    NotFoundError: '404',
    ConflictError: '409',
    BadRequestError: '400',
  };

  const SERVICE_BACKED: ReadonlyArray<readonly [string, string, string]> = [
    // [published operation, service file, method]
    ['post /v1/account/mfa/verify', 'apps/server/src/services/mfa.ts', 'completeEnrollment'],
    ['post /v1/account/mfa/enroll', 'apps/server/src/services/mfa.ts', 'startEnrollment'],
    [
      'post /v1/account/mfa/recovery-codes/regenerate',
      'apps/server/src/services/mfa.ts',
      'regenerateRecoveryCodes',
    ],
  ];

  function methodThrows(file: string, method: string): string[] {
    const src = readFileSync(resolve(HERE, '..', '..', '..', '..', file), 'utf8');
    const starts = [...src.matchAll(/\n {2}async (\w+)\(/g)];
    const at = starts.findIndex((m) => m[1] === method);
    if (at === -1) return [];
    const from = starts[at]!.index ?? 0;
    const to = starts[at + 1]?.index ?? src.length;
    return [
      ...new Set([...src.slice(from, to).matchAll(/throw new (\w+Error)/g)].map((m) => m[1]!)),
    ];
  }

  it('CRITICAL a route that 404s on STATE rather than on a missing id still declares it. The arms above key on /{id}, which is why four MFA operations sat undeclared: they take no path parameter and refuse with "MFA is not enrolled". This reads the service method each one delegates to and requires every error it throws to have a declared status.', () => {
    // The GENERATED document, not the builder source: this is the artifact
    // customers generate clients from, and reading it makes this a comparison
    // between two independent things rather than a re-read of one.
    const doc = JSON.parse(
      readFileSync(
        resolve(HERE, '..', '..', '..', '..', 'packages/sdk-python/openapi.json'),
        'utf8',
      ),
    ) as { paths: Record<string, Record<string, { responses?: Record<string, unknown> }>> };
    const missing: string[] = [];
    let pairs = 0;

    for (const [operation, file, method] of SERVICE_BACKED) {
      const thrown = methodThrows(file, method);
      expect(
        thrown.length,
        `${file}::${method} throws nothing — the scan or the roster is stale`,
      ).toBeGreaterThan(0);
      const [verb, path] = operation.split(' ') as [string, string];
      const responses = doc.paths[path]?.[verb]?.responses;
      expect(
        responses,
        `${operation} is not a published operation — the roster is stale`,
      ).toBeDefined();
      const codes = new Set(Object.keys(responses ?? {}));
      for (const err of thrown) {
        const status = ERROR_STATUS[err];
        if (status === undefined) continue; // an error class with no fixed status
        pairs += 1;
        if (!codes.has(status))
          missing.push(`${operation}: throws ${err} but does not declare ${status}`);
      }
    }

    expect(
      pairs,
      'no (error, status) pairs compared — the throw scan stopped matching and this arm would pass having read nothing',
    ).toBeGreaterThanOrEqual(4);
    expect(
      missing.sort(),
      'operation(s) whose service throws an error the published spec does not declare',
    ).toEqual([]);
  });
  /**
   * V-1488 — the general form: a handler's OWN throws, for every route.
   *
   * V-1487 compared thrown errors to declared statuses through a listed
   * route→service-method roster, because a handler that delegates cannot be read
   * without knowing what it delegates to. Errors thrown IN the handler need no
   * such pairing — the registration block owns them — so this covers the whole
   * route surface rather than three named methods, and found eight operations
   * short a status their own handler raises.
   *
   * The worst was `GET /v1/status/incidents`, which declared `200` and nothing
   * else while refusing `?state=` and `?cursor=` outright: a public feed
   * documented as unable to fail. The rest split between routinely reachable
   * (an unknown `profile_id` on agent-session create, an unknown `document_key`
   * on legal accept, a concurrent proxy update) and race-reachable (an account
   * row deleted between `requireAuth` and the write). Both kinds are returnable,
   * so both are declared, with the reachability written into each description
   * rather than left for a reader to guess.
   *
   * Blocks are bounded by the NEXT registration, so a helper defined between two
   * routes would be attributed to the earlier one. Every one of the eight was
   * read at its throw site before being declared — the census names candidates,
   * it does not confirm them.
   */
  const HANDLER_ERROR_STATUS: Record<string, string> = {
    NotFoundError: '404',
    ConflictError: '409',
    ForbiddenError: '403',
    BadRequestError: '400',
    ValidationError: '400',
    GoneError: '410',
    PayloadTooLargeError: '413',
  };

  it('CRITICAL no operation omits a status its own handler throws. Errors raised inside a registration block belong to that route with no roster to keep in step, so this covers every route rather than a named few — eight operations were short a status they raise, including a public feed that declared 200 alone while refusing two query parameters.', () => {
    const routesDir = resolve(HERE, '..', '..', 'src', 'routes');
    const doc = JSON.parse(
      readFileSync(
        resolve(HERE, '..', '..', '..', '..', 'packages/sdk-python/openapi.json'),
        'utf8',
      ),
    ) as { paths: Record<string, Record<string, { responses?: Record<string, unknown> }>> };

    const missing: string[] = [];
    let compared = 0;
    for (const file of readdirSync(routesDir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(resolve(routesDir, file), 'utf8');
      const regs = [
        ...src.matchAll(/app\.(get|post|put|patch|delete)[^(]*\(\s*\n?\s*'([^']+)'/g),
      ].map((m) => ({ at: m.index ?? 0, verb: (m[1] ?? '').toLowerCase(), path: m[2] ?? '' }));
      for (const [i, reg] of regs.entries()) {
        const block = src.slice(reg.at, regs[i + 1]?.at ?? src.length);
        const statuses = new Set(
          [...block.matchAll(/throw new (\w+Error)/g)]
            .map((m) => HANDLER_ERROR_STATUS[m[1] ?? ''])
            .filter((x): x is string => x !== undefined),
        );
        if (statuses.size === 0) continue;
        const published = reg.path.replace(/:([a-zA-Z_]+)/g, '{$1}');
        const responses = doc.paths[published]?.[reg.verb]?.responses;
        if (responses === undefined) continue; // not a published operation
        compared += 1;
        for (const status of statuses) {
          if (!(status in responses)) {
            missing.push(`${reg.verb.toUpperCase()} ${published}: throws ${status} (${file})`);
          }
        }
      }
    }

    expect(
      compared,
      'no published operation was compared — the registration or throw scan stopped matching, and this arm would pass having read nothing',
    ).toBeGreaterThan(80);
    expect(
      [...new Set(missing)].sort(),
      'operation(s) whose own handler raises a status the published document does not declare',
    ).toEqual([]);
  });
});
