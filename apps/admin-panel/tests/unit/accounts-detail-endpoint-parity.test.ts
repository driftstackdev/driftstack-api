// W341.C — drift guard for admin /accounts/[id] detail page.
// The page calls 7 admin endpoints + 1 audit slice endpoint. If
// any one is renamed/removed server-side, a button on the detail
// page silently 404s.
//
// Also pins:
//   • AccountStatusSchema ↔ STATUS_BADGE keys parity (catches a
//     new status value going un-styled)
//   • acc_ id prefix display convention
//   • Static shell + Pages rewrite — the page remains deep-linkable
//     by arbitrary UUID without a Worker

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/account-detail.astro');
const REDIRECTS = resolve(REPO_ROOT, 'apps/admin-panel/public/_redirects');
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

  it('static shell rewrite keeps arbitrary UUID deep links without SSR', () => {
    expect(page).not.toMatch(/export const prerender\s*=\s*false/);
    expect(read(REDIRECTS)).toMatch(/^\/accounts\/:id \/shells\/account-detail\/ 200$/m);
    expect(page).toMatch(/window\.location\.pathname\.split\('\/'\)/);
  });

  it('displays the acc_ id prefix convention from the requested URL', () => {
    expect(page).toContain("const prefixedId = 'acc_' + accountUuid");
    expect(page).toContain("setText('account-id', accountUuid ? prefixedId : '—')");
  });

  it('"Back to accounts" breadcrumb resolves to the list page', () => {
    expect(page).toMatch(/href="\/accounts"/);
  });
});
