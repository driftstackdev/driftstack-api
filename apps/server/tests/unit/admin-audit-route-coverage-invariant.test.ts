// V-1007 — every MUTATING /v1/admin route writes an audit row, or is on a list
// somebody had to look at.
//
// `services/admin-audit.ts` claimed "Every /v1/admin/* endpoint writes one row
// here before returning its response". That sentence is what a DPO or a SOC2
// auditor cites to assert staff access to customer data is traceable, and it was
// false in two different ways. Measured across the 68 admin registrations:
//
//   35 GETs, of which ZERO audit — including `GET /v1/admin/crypto-orders.csv`,
//   a bulk export of up to 1000 rows of account_id, payment_id and customer
//   notes. A staff member can pull every customer's crypto order notes and leave
//   nothing behind.
//
//   33 mutations, of which THREE audit nothing: the admin OAuth-client routes.
//   Registering, revoking and re-keying an OAuth client grants, withdraws and
//   rotates third-party access to customer accounts, and none of it is recorded.
//
// Six admin route files already said the read half out loud in their own comments
// ("Read-only; no audit row written for the read"). The header was the one place
// that claimed otherwise, and the pins froze it there.
//
// So the sentence is now derived rather than asserted. The lists below ARE the
// documented behaviour: a new admin mutation that forgets its audit row fails
// here, and a decision to start auditing reads reds the no-GET-audits arm below,
// which is where that decision gets recorded — the arm and the header paragraph
// move together instead of the prose drifting behind. That is what the sweep
// asked for: the open question becomes an edit to a checked list, not an edit to
// a sentence nothing verifies.
//
// ⚠️ This asserts an audit CALL exists in the handler, not that it is correct or
// that it fires on every path. A handler that records the wrong action, or skips
// the call on an early return, passes here. Written that way deliberately: the
// alternative is a matcher tuned until it stops complaining, and the readiness
// assessment records that shape failing twice.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

/**
 * Mutating admin routes that deliberately write no audit row.
 *
 * All three grant, revoke or re-key third-party access to customer accounts.
 * They are here rather than fixed because `admin_audit_action` is a closed
 * Postgres enum with no value for any of them — auditing these is a migration,
 * which `admin-audit.ts` notes is the intended cost of a new admin action. That
 * makes it a decision, and this list is where the decision is recorded.
 */
const UNAUDITED_MUTATIONS: ReadonlySet<string> = new Set([
  'POST /v1/admin/oauth/clients',
  'DELETE /v1/admin/oauth/clients/:id',
  'POST /v1/admin/oauth/clients/:id/rotate-secret',
]);

/** An audit call, in any of the shapes the admin routes use. */
const AUDIT_CALL = /withAudit\w*\(|audit\.record\(|auditLog\.|adminAudit\./;

const REGISTRATION =
  /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/admin\/[^'"`]*)['"`]/g;

interface AdminRoute {
  readonly verb: string;
  readonly path: string;
  readonly file: string;
  readonly audits: boolean;
}

/**
 * Every `/v1/admin` registration with whether its handler contains an audit call.
 *
 * The handler block runs from one registration to the next, which is what makes
 * the answer per-ROUTE rather than per-FILE — `admin-accounts.ts` alone holds
 * fourteen, and a file-level grep would call every one of them audited because
 * one of its neighbours is.
 */
function adminRoutes(): AdminRoute[] {
  const out: AdminRoute[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(ROUTES, file), 'utf8');
    const matches = [...src.matchAll(REGISTRATION)];
    for (const [i, m] of matches.entries()) {
      const start = m.index + m[0].length;
      const end = i + 1 < matches.length ? (matches[i + 1]?.index ?? src.length) : src.length;
      out.push({
        verb: (m[1] ?? '').toUpperCase(),
        path: m[2] ?? '',
        file,
        audits: AUDIT_CALL.test(src.slice(start, end)),
      });
    }
  }
  return out;
}

const key = (r: AdminRoute): string => `${r.verb} ${r.path}`;

describe('V-1007 admin audit coverage is derived, not asserted', () => {
  const routes = adminRoutes();

  it('CRITICAL the scan found the admin surface and the audit detector detects. Both halves are asserted: a registration regex that matched nothing, or an audit matcher that never fires, would make every arm below agree with anything — which is exactly how the sentence this file replaces survived so long.', () => {
    expect(routes.length, '/v1/admin registrations found').toBeGreaterThanOrEqual(60);
    expect(
      routes.filter((r) => r.audits).length,
      'routes detected as auditing',
    ).toBeGreaterThanOrEqual(20);
    expect(
      routes.filter((r) => r.verb === 'GET').length,
      'admin GET routes',
    ).toBeGreaterThanOrEqual(25);
    // The detector must distinguish the wrapper form from the plain one.
    expect(AUDIT_CALL.test('await withAuditOverrideClear(request, id, () =>')).toBe(true);
    expect(AUDIT_CALL.test('const result = await deps.service.registerClient({')).toBe(false);
  });

  it('CRITICAL every mutating /v1/admin route writes an audit row, or is listed as deliberately not doing so. A staff mutation that records nothing is invisible to an internal investigation, and the three on the list are exactly the ones that hand out and withdraw third-party access to customer accounts.', () => {
    const missing = routes
      .filter((r) => r.verb !== 'GET' && !r.audits && !UNAUDITED_MUTATIONS.has(key(r)))
      .map((r) => `${key(r)}  (${r.file})`)
      .sort();
    expect(
      missing,
      'these admin mutations write no audit row and are not on the deliberate list — add the ' +
        'audit call, or add the route here with the reason it does not need one:',
    ).toEqual([]);
  });

  it('CRITICAL the deliberate list holds no stale entry. An entry naming a route that no longer exists, or one that has since started auditing, reads as a considered decision while silencing whatever next lands under that key — the same failure the unreported-fields backlog is pinned against.', () => {
    const live = new Set(routes.map(key));
    const gone = [...UNAUDITED_MUTATIONS].filter((k) => !live.has(k)).sort();
    expect(gone, 'listed as deliberately unaudited but no longer registered:').toEqual([]);

    const nowAudits = routes.filter((r) => UNAUDITED_MUTATIONS.has(key(r)) && r.audits).map(key);
    expect(
      nowAudits,
      'these now write an audit row — delete them from the list and from the header paragraph:',
    ).toEqual([]);
  });

  it('CRITICAL no admin GET audits, which is the fact the corrected header states. Pinned so the sentence stays derived: the moment a read starts auditing, this fails and the paragraph gets rewritten with it rather than drifting behind. The reads are what the sweep flagged — `GET /v1/admin/crypto-orders.csv` exports up to 1000 rows of customer payment data and records nothing.', () => {
    const auditingReads = routes
      .filter((r) => r.verb === 'GET' && r.audits)
      .map(key)
      .sort();
    expect(
      auditingReads,
      'an admin READ now writes an audit row — good, but admin-audit.ts still says reads do not:',
    ).toEqual([]);
  });

  it('CRITICAL the header in services/admin-audit.ts matches what this file measures. Two sources for one fact is how the old claim outlived the code by months; this makes the prose fail with the invariant.', () => {
    const header = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'),
      'utf8',
    );
    expect(header, 'the header no longer states the mutating-only rule').toMatch(
      /Every MUTATING \/v1\/admin\/\* endpoint writes one row here before/,
    );
    expect(header, 'the retracted every-endpoint claim is back').not.toMatch(
      /Every \/v1\/admin\/\* endpoint writes one row here before returning/,
    );
    expect(header, 'the header no longer names the three excepted OAuth-client routes').toMatch(
      /rotate-secret/,
    );
  });
});
