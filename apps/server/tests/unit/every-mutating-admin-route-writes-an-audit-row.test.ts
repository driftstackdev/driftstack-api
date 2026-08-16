// A staff action that changes state and leaves no audit row is a change nobody
// can account for afterwards.
//
// This has shipped twice. Migration 0097's own comment records that
// `admin-crypto-orders.ts` and `admin-validation-harness.ts` "had zero audit
// wiring despite this file's header invariant" — found by hand, fixed by hand,
// with nothing left behind to catch the third one.
//
// `every-declared-admin-audit-action-is-reachable` guards the other direction:
// a declared enum value that no code can emit. It cannot see this one. A new
// admin route that mutates and never audits adds no enum value, so that guard
// stays green while the action goes unrecorded.
//
// Scope, stated because it bounds the claim: this proves an audit call is
// REACHED from the route's registration block, not that the row lands with
// correct content. `admin.test.ts` drives the row itself over HTTP. The block
// runs from one `app.<verb>(` registration to the next, so the final route in a
// file extends to end-of-file and is the one place a stray helper could satisfy
// the check for it — every other block is bounded by the next registration.
//
// Measured when this landed: 30 mutating admin routes, 0 without an audit call.
// It is a regression guard, not a fix.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

/** `app.post<{...}>(` — the generic argument sits between the verb and the paren. */
const ROUTE_REGISTRATION = /app\.(get|post|patch|put|delete)\s*(<[^(]*>)?\s*\(/g;

/** Verbs that change state. A GET that mutates is a bug this does not try to find. */
const MUTATING = new Set(['post', 'patch', 'put', 'delete']);

/**
 * Any spelling that reaches the audit recorder.
 *
 * `withAudit` is the wrapper most admin routes use, and matching only
 * `audit.record` would have missed every one of them — the first draft of this
 * measurement did exactly that and reported `admin-webhooks.ts` as having three
 * unaudited mutating routes, which was an artefact of the pattern rather than a
 * finding.
 */
const AUDIT_CALL = /withAudit|audit\.record|adminAudit|recordAdminAction/;

function adminRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.startsWith('admin-') && f.endsWith('.ts'))
    .map((f) => join(ROUTES_DIR, f))
    .sort();
}

interface RouteBlock {
  file: string;
  verb: string;
  path: string;
  body: string;
}

function routeBlocks(): RouteBlock[] {
  const blocks: RouteBlock[] = [];
  for (const file of adminRouteFiles()) {
    const source = readFileSync(file, 'utf-8');
    const marks = [...source.matchAll(ROUTE_REGISTRATION)];
    marks.forEach((m, i) => {
      const start = m.index;
      const end = i + 1 < marks.length ? marks[i + 1]!.index : source.length;
      const body = source.slice(start, end);
      blocks.push({
        file: file.slice(file.lastIndexOf('/') + 1),
        verb: m[1]!,
        path: /'(\/v1\/[^']+)'/.exec(body)?.[1] ?? '(path not parsed)',
        body,
      });
    });
  }
  return blocks;
}

describe('every mutating admin route writes an audit row', () => {
  it('CRITICAL the scan finds real admin routes, so an absence is measured against a real set', () => {
    const blocks = routeBlocks();
    expect(
      adminRouteFiles().length,
      'no admin route files found — the scan is broken',
    ).toBeGreaterThan(10);
    expect(
      blocks.filter((b) => MUTATING.has(b.verb)).length,
      'no mutating admin route found — either the registration idiom changed or the pattern is broken',
    ).toBeGreaterThan(25);
    // The detector must be able to answer BOTH ways, or the check below is
    // decided by the pattern rather than by the routes.
    expect(
      AUDIT_CALL.test('await withAudit(request, ...)'),
      'detector cannot see an audit call',
    ).toBe(true);
    expect(AUDIT_CALL.test('return reply.send(rows)'), 'detector says yes to anything').toBe(false);
  });

  it('CRITICAL a mutating admin route reaches an audit call', () => {
    const unaudited = routeBlocks()
      .filter((b) => MUTATING.has(b.verb) && !AUDIT_CALL.test(b.body))
      .map((b) => `${b.file} ${b.verb.toUpperCase()} ${b.path}`)
      .sort();

    expect(
      unaudited,
      'these change state as a staff action and never reach the audit recorder, so the change ' +
        'cannot be attributed afterwards — migration 0097 records this shipping twice already',
    ).toEqual([]);
  });
});
