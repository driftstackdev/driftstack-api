// V-820 — a new admin mutation must not ship without an audit call, and the
// fact that admin READS are unaudited must not stay invisible.
//
// `docs/decisions.md` said "Every admin endpoint writes the audit row inside the
// same handler that performs the action", followed by "Failure to audit fails
// the request — there is no audit best-effort path". A compliance reader takes
// that as total coverage of the admin surface. Measured, it is half of one:
//
//   • every mutating `/v1/admin/*` route DOES write an audit row;
//   • NONE of the admin GET routes do.
//
// Counts are deliberately absent. This file derives both sets on every run, and
// V-861 found the figures written here had already drifted — the GET count was
// recorded as 31 and is 35 today, without anything failing, because the arms
// below assert the all-or-nothing split rather than a size.
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
    // V-1547 — this read only files NAMED `admin*`, which is a roster keyed by
    // filename rather than by what a route IS. Seven `/v1/admin/` routes live
    // elsewhere — five in `oauth.ts`, two in `internal-atlas-priority.ts` — so the
    // guard whose whole job is "a new admin mutation cannot ship unaudited" could
    // not see three admin mutations that ship unaudited today. Scan every route
    // file; `isAdmin` already decides membership by path.
    if (!name.endsWith('.ts')) continue;
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

/**
 * Admin mutations that write no audit row today, with the reason each cannot
 * simply be wired.
 *
 * V-1547 — all three manage third-party OAuth clients, and none can be audited
 * without a migration: `admin_audit_log.action` is a closed Postgres enum and
 * carries no `oauth_client.*` value, which `docs/decisions.md` records as the
 * deliberate design ("Adding a new admin endpoint is a migration-bearing
 * change"). Choosing the vocabulary is the migration-bearing part, so the entries
 * sit here rather than being quietly wired to an existing action that means
 * something else.
 *
 * Checked in BOTH directions below: a new unaudited admin mutation fails, and an
 * entry here that starts auditing fails too, so the list cannot outlive the gap.
 */
const KNOWN_UNAUDITED_ADMIN_MUTATIONS: ReadonlySet<string> = new Set([
  'POST /v1/admin/oauth/clients',
  'DELETE /v1/admin/oauth/clients/:id',
  'POST /v1/admin/oauth/clients/:id/rotate-secret',
]);

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
    const mutations = adminRoutes()
      .filter(isAdmin)
      .filter((r) => r.verb !== 'GET');
    const unaudited = mutations
      .filter((r) => !r.audited)
      .filter((r) => !KNOWN_UNAUDITED_ADMIN_MUTATIONS.has(`${r.verb} ${r.path}`))
      .map((r) => `${r.verb} ${r.path} (${r.file})`)
      .sort();

    expect(
      unaudited,
      'admin mutation with no audit call in its handler — add one, or move the route out of /v1/admin/*:',
    ).toEqual([]);
  });

  it('CRITICAL admin reads are unaudited as a whole, not in part. This arm does not demand they be audited and does not police how many there are — an earlier title claimed it caught the count rising, which it never did (V-861: 31 became 35 with this green). What it enforces is that the state stays all-or-nothing, so the moment ONE read starts auditing, the decisions.md clause describing reads as uniformly unaudited is wrong and this fails until someone writes the real split.', () => {
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

  it('V-1547 CRITICAL the recorded-unaudited list is checked in both directions, so it cannot outlive the gap it records. Every entry must still be a real admin mutation and must still be unaudited: one that starts writing a row, or that is renamed or deleted, fails here and has to be struck. A backlog nobody is forced to revisit becomes a permanent exemption, which is how the filename-keyed roster this file used to carry hid three admin mutations for as long as it did.', () => {
    const mutations = adminRoutes()
      .filter(isAdmin)
      .filter((r) => r.verb !== 'GET');
    const live = new Map(mutations.map((r) => [`${r.verb} ${r.path}`, r.audited]));

    const gone = [...KNOWN_UNAUDITED_ADMIN_MUTATIONS].filter((k) => !live.has(k)).sort();
    expect(gone, 'recorded as unaudited but no longer a mutating admin route — strike it').toEqual(
      [],
    );

    const nowAudited = [...KNOWN_UNAUDITED_ADMIN_MUTATIONS]
      .filter((k) => live.get(k) === true)
      .sort();
    expect(
      nowAudited,
      'recorded as unaudited but now writes an audit row — strike it so the list keeps meaning what it says',
    ).toEqual([]);
  });
});
