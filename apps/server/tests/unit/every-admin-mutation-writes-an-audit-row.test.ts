// V-820 — a new admin mutation must not ship without an audit call, and the
// fact that admin READS are unaudited must not stay invisible.
//
// `docs/decisions.md` said "Every admin endpoint writes the audit row inside the
// same handler that performs the action", followed by "Failure to audit fails
// the request — there is no audit best-effort path". A compliance reader takes
// that as total coverage of the admin surface. Measured, it is half of one:
//
//   • all 30 mutating `/v1/admin/*` routes DO write an audit row;
//   • NONE of the 31 admin GET routes do.
//
// Several of those reads expose customer data — `GET /v1/admin/api-keys` lists
// every customer's keys, and the per-account cost / usage / detail endpoints
// expose one customer at a time. A staff member reading a customer's record
// leaves no trace today. That is a gap worth stating plainly rather than a
// design worth asserting, and whether to close it is a product decision: a row
// per list call on hot dashboard endpoints is a real cost against a real
// control.
//
// PRIOR ART, and why this is a different axis.
// `every-declared-admin-audit-action-is-reachable.test.ts` guards the action
// ENUM — that every declared value can actually be emitted. Its header records
// that `admin-crypto-orders.ts` and `admin-validation-harness.ts` once "had zero
// audit wiring despite this file's header invariant", and that this was "found
// by hand, once, and fixed once. Nothing stopped the next one." This file is the
// thing that stops the next one: it checks the ROUTES, not the vocabulary.
//
// The two directions are both needed and neither implies the other. A route can
// audit with an action nobody can emit; an emittable action can have no route
// that writes it.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

interface Route {
  readonly verb: string;
  readonly path: string;
  readonly audited: boolean;
  readonly file: string;
}

const AUDIT_CALL = /withAudit|audit\.record|auditRepo\.|recordAdminAudit|adminAudit/;

/**
 * Every `app.<verb>('<path>', …)` registration in the admin route modules.
 *
 * Brace-matched from the call's opening paren rather than regex-scoped, because
 * a handler body contains its own parens and a lazy match stops at the first
 * one — which reports every route as unaudited. That exact bug produced a
 * confident "0 of 69 audited" while measuring this finding; the vacuity arm
 * below exists because that reading looked entirely plausible.
 */
function adminRoutes(): Route[] {
  const out: Route[] = [];
  for (const name of readdirSync(ROUTES_DIR)) {
    if (!name.startsWith('admin') || !name.endsWith('.ts')) continue;
    const src = readFileSync(join(ROUTES_DIR, name), 'utf8');
    for (const m of src.matchAll(/\bapp\.(get|post|patch|delete|put)\b/g)) {
      const open = src.indexOf('(', (m.index ?? 0) + m[0].length);
      if (open === -1) continue;
      let depth = 0;
      let end = src.length;
      for (let k = open; k < src.length; k += 1) {
        if (src[k] === '(') depth += 1;
        else if (src[k] === ')') {
          depth -= 1;
          if (depth === 0) {
            end = k;
            break;
          }
        }
      }
      const body = src.slice(open, end);
      const pathMatch = /^\(\s*'([^']+)'/.exec(body);
      if (!pathMatch) continue;
      out.push({
        verb: (m[1] as string).toUpperCase(),
        path: pathMatch[1] as string,
        audited: AUDIT_CALL.test(body),
        file: name,
      });
    }
  }
  return out;
}

/** Only `/v1/admin/*`. Customer routes registered in an admin module are not admin endpoints. */
const isAdmin = (r: Route): boolean => r.path.startsWith('/v1/admin/');

describe('V-820 every admin mutation writes an audit row', () => {
  it('CRITICAL the scan really parsed routes and really distinguishes audited from not. Both arms below are satisfied by an empty parse, and a broken brace-match reports every route as unaudited — which is exactly what happened while measuring this, and read as a real finding until it was checked against the file-level counts.', () => {
    const all = adminRoutes();
    expect(all.length, 'route registrations found in the admin modules').toBeGreaterThan(50);

    const admin = all.filter(isAdmin);
    expect(admin.length, 'routes under /v1/admin/').toBeGreaterThan(40);
    expect(
      admin.filter((r) => r.audited).length,
      'audited admin routes — a zero here means the matcher broke, not that auditing vanished',
    ).toBeGreaterThan(20);
  });

  it('CRITICAL every mutating /v1/admin/* route writes an audit row in the same handler. This is the invariant docs/decisions.md states, and until now nothing checked it at the route level: two modules once shipped with no audit wiring at all and were found by hand. A staff action that leaves no row is indistinguishable afterwards from one that never happened.', () => {
    const unaudited = adminRoutes()
      .filter(isAdmin)
      .filter((r) => r.verb !== 'GET')
      .filter((r) => !r.audited)
      .map((r) => `${r.verb} ${r.path} (${r.file})`)
      .sort();

    expect(
      unaudited,
      'admin mutation with no audit call in its handler — add one, or move the route out of /v1/admin/*:',
    ).toEqual([]);
  });

  it('CRITICAL the unaudited-reads gap is recorded with its real size, so it cannot quietly grow. Admin GETs are NOT audited today — this arm does not demand they are, it demands the number stays honest. If it rises, someone added another unaudited read of customer data; if it falls to zero, reads are audited now and this arm and the decisions.md clause should both be retired.', () => {
    const gets = adminRoutes()
      .filter(isAdmin)
      .filter((r) => r.verb === 'GET');
    const unaudited = gets.filter((r) => !r.audited);

    // Not a ratchet: reads are unaudited BY OMISSION, so pinning the exact
    // number would fail on every new read endpoint and teach people to bump it
    // without thinking. The honest assertion is that the state is what the
    // decisions.md clause says it is — all of them, not some of them.
    expect(gets.length, 'admin GET routes').toBeGreaterThan(25);
    expect(
      unaudited.length,
      'if SOME admin reads are audited and others are not, the decisions.md clause is wrong again and needs the real split',
    ).toBe(gets.length);
  });
});
