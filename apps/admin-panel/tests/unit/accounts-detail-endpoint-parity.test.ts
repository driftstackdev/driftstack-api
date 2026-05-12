// W341.C — drift guard for admin /accounts/[id] detail page.
// The page calls 7 admin endpoints + 1 audit slice endpoint. If
// any one is renamed/removed server-side, a button on the detail
// page silently 404s.
//
// Also pins:
//   • AccountStatusSchema ↔ STATUS_BADGE keys parity (catches a
//     new status value going un-styled)
//   • acc_ id prefix display convention
//   • SSR-disabled (export const prerender = false) — the page is
//     deep-linkable by arbitrary UUID

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/accounts/[id].astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts');
const AUDIT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W341.C admin /accounts/[id] detail endpoint parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const auditRoute = read(AUDIT_ROUTE);

  // The 7 admin endpoints the detail page exercises.
  const adminEndpoints: Array<[string, string]> = [
    ['GET account-detail', '/v1/admin/accounts/'],
    ['POST tier change', "/tier'"],
    ['POST suspend', "/suspend'"],
    ['POST unsuspend', "/unsuspend'"],
    ['POST/DELETE quota-override', "/quota-override'"],
    ['POST audit-note', "/audit-note'"],
    ['POST refund-record', "/refund-record'"],
  ];

  for (const [label, hint] of adminEndpoints) {
    it(`${label}: page references it`, () => {
      expect(page).toContain(hint);
    });
  }

  it('every endpoint above is registered in admin-accounts.ts', () => {
    expect(route).toContain("'/v1/admin/accounts/:id'");
    expect(route).toContain("'/v1/admin/accounts/:id/tier'");
    expect(route).toContain("'/v1/admin/accounts/:id/suspend'");
    expect(route).toContain("'/v1/admin/accounts/:id/unsuspend'");
    expect(route).toContain("'/v1/admin/accounts/:id/quota-override'");
    expect(route).toContain("'/v1/admin/accounts/:id/audit-note'");
    expect(route).toContain("'/v1/admin/accounts/:id/refund-record'");
  });

  it('audit-slice endpoint /v1/admin/audit-log is registered', () => {
    expect(page).toContain('/v1/admin/audit-log');
    expect(auditRoute).toContain("'/v1/admin/audit-log'");
  });

  it('STATUS_BADGE keys match AccountStatusSchema exactly', () => {
    const sevMatch = page.match(/STATUS_BADGE:[^={]*=?\s*\{([\s\S]*?)\};/);
    expect(sevMatch).not.toBeNull();
    const keys = [...sevMatch![1]!.matchAll(/^\s*([a-z_]+):\s*'[^']+',/gm)]
      .map((m) => m[1]!)
      .sort();
    const schemaValues = [
      ...(AccountStatusSchema._def as { values: readonly string[] }).values,
    ].sort();
    expect(keys).toEqual(schemaValues);
  });

  it('page is SSR-only (prerender=false) so any UUID deep-links', () => {
    // V-200 — the detail page is no longer pre-built from a static
    // mock list. Pin the export so a refactor doesn't accidentally
    // flip back to SSG (which would re-introduce the 404 problem
    // for live, non-mock account UUIDs).
    expect(page).toMatch(/export const prerender\s*=\s*false/);
  });

  it('displays the acc_ id prefix convention (acc_{account.id})', () => {
    expect(page).toMatch(/acc_\{account\.id\}/);
  });

  it('"Back to accounts" breadcrumb resolves to the list page', () => {
    expect(page).toMatch(/href="\/accounts"/);
  });
});
