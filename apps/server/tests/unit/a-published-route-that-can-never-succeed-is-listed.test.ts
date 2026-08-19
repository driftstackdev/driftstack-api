// V-1048 — a live route that ALWAYS answers 503 is on a list somebody had to look at.
//
// V-1047 found `POST /v1/sessions/:id/proxy` published in the OpenAPI document,
// declaring a 200, with a handler that throws `FeatureUnavailableError`
// unconditionally — its own words, "including when a backend IS present". An SDK
// generated from that spec carries a success shape no caller can reach.
//
// That is a legitimate state to be in (the route is on a standing implement-or-
// delete decision, and the shape documents what it will answer once wired), but it
// should be a decision rather than a drift. A second one appearing quietly is the
// failure this file exists to prevent.
//
// ── The instrument, which took three tries ─────────────────────────────────
//
// Counting these is where the difficulty is, not deciding about them.
//
//   A naive scan for `FeatureUnavailableError` in a route file returns 21
//   registrations. Most throw CONDITIONALLY, when a dependency is missing, which
//   is exactly right and not this file's business.
//
//   Adding "the handler returns `never`" narrows it to 7 — and 6 of those are
//   wrong. `GET /v1/billing` and `DELETE /v1/recipes/:id` have ordinary handlers
//   that return data; the `never` belonged to the `…DisabledRoutes` stub further
//   down the file. The per-route segment ran from one registration to the NEXT
//   one, which for the last live route means it swallows the disabled registrar
//   underneath it.
//
//   Bounding each segment at the enclosing function as well gives 1.
//
// So the walk below stops at `export function` boundaries, and an arm asserts that
// it does — because the difference between 7 and 1 here is the difference between
// reporting six endpoints as permanently broken and reporting none.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

const REGISTRATION =
  /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g;

/**
 * Live routes that can never succeed, with the reason each is acceptable.
 *
 * `POST /v1/sessions/:id/proxy` — customer-configurable egress. The route layer is
 * not wired to the egress service, and the handler says so; the published 200
 * documents the contract it will answer once it is. On the implement-or-delete
 * decision list, and V-1047 made the spec prose agree with the handler.
 */
const PERMANENTLY_UNAVAILABLE: ReadonlySet<string> = new Set(['POST /v1/sessions/:id/proxy']);

interface Found {
  readonly key: string;
  readonly file: string;
}

/** Registrations whose own handler always throws, segments bounded by function. */
function alwaysUnavailable(): Found[] {
  const out: Found[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(ROUTES, file), 'utf8');
    const fns = [...src.matchAll(/^export function (\w+)/gm)].map(
      (m) => [m.index, m[1] as string] as const,
    );
    const boundaries = [...fns.map(([at]) => at), src.length];
    const ms = [...src.matchAll(REGISTRATION)];
    for (const [i, m] of ms.entries()) {
      let owner = '(top)';
      let fnEnd = src.length;
      for (const [idx, [at, name]] of fns.entries()) {
        if (at <= m.index) {
          owner = name;
          fnEnd = boundaries[idx + 1] ?? src.length;
        } else break;
      }
      if (/Disabled/.test(owner)) continue;
      const nextReg = i + 1 < ms.length ? (ms[i + 1]?.index ?? src.length) : src.length;
      const segment = src.slice(m.index + m[0].length, Math.min(nextReg, fnEnd));
      if (!segment.includes('FeatureUnavailableError')) continue;
      if (!/\)\s*:\s*never\s*=>/.test(segment)) continue;
      out.push({ key: `${(m[1] ?? '').toUpperCase()} ${m[2] ?? ''}`, file });
    }
  }
  return out;
}

describe('V-1048 a published route that can never succeed is listed', () => {
  it('CRITICAL the segment walk stops at function boundaries. Without that bound the last live registration in a file swallows the `…DisabledRoutes` stub beneath it, and this scan reports 7 permanently-unavailable routes instead of 1 — six of them ordinary endpoints that return data. The bound is the whole instrument.', () => {
    const billing = readFileSync(resolve(ROUTES, 'billing.ts'), 'utf8');
    expect(
      billing,
      'billing.ts no longer holds both a live registrar and a disabled stub, so it can no longer ' +
        'demonstrate the overrun this arm guards against',
    ).toMatch(/export function registerBillingDisabledRoutes/);

    // The live billing read is an ordinary handler; if the walk crossed into the
    // stub it would be reported below, and it is not.
    expect(
      alwaysUnavailable().map((r) => r.key),
      'GET /v1/billing was reported as permanently unavailable — the walk crossed a function ' +
        'boundary into the disabled registrar',
    ).not.toContain('GET /v1/billing');
  });

  it('CRITICAL every live route that always throws FeatureUnavailable is listed with a reason. A published endpoint that can never answer 200 puts a method in three generated SDKs that no customer call can reach; one such route is a recorded decision, a second appearing quietly is drift.', () => {
    const found = alwaysUnavailable();
    const unlisted = found
      .filter((r) => !PERMANENTLY_UNAVAILABLE.has(r.key))
      .map((r) => `${r.key}  (${r.file})`)
      .sort();
    expect(
      unlisted,
      'these live routes throw FeatureUnavailable unconditionally and are not listed — either wire ' +
        'them, remove them from the OpenAPI document, or add them here with the reason:',
    ).toEqual([]);
  });

  it('CRITICAL the list holds no stale entry. A route that has since been wired, or removed, would sit here reading as a considered decision while pre-approving whatever next lands on that path.', () => {
    const live = new Set(alwaysUnavailable().map((r) => r.key));
    const gone = [...PERMANENTLY_UNAVAILABLE].filter((k) => !live.has(k)).sort();
    expect(
      gone,
      'listed as permanently unavailable but no longer throwing unconditionally — good, and the ' +
        'entry plus the spec prose in lib/openapi.ts should go with it:',
    ).toEqual([]);
  });
});
