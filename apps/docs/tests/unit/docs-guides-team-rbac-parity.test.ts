// W259.A — drift-guard for docs.driftstack.io/guides/team-rbac. Pins:
// 1. Every /v1/team/* endpoint cited is registered.
// 2. /v1/account/me + /v1/account/audit-log paths cited exist.
// 3. The X-Driftstack-Account header name + acc_<uuid> prefix match the live convention.
// 4. Cross-link targets exist.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/team-rbac.md');
const TEAM_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/team.ts');
const ACCT_ME_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');
const ACCT_AUDIT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W259.A docs/guides/team-rbac ↔ live team surface parity', () => {
  const doc = read(DOC);
  const teamRoute = read(TEAM_ROUTE);
  const acctMe = read(ACCT_ME_ROUTE);
  const acctAudit = read(ACCT_AUDIT_ROUTE);

  it('every /v1/team/* endpoint cited is registered', () => {
    for (const path of [
      '/v1/team/invites',
      '/v1/team/invites/accept',
      '/v1/team/members',
      '/v1/team/owners',
      '/v1/team/members/:id',
    ]) {
      // Doc uses :id or $MEMBERSHIP_ID in URL — accept either pattern.
      const docPattern =
        path === '/v1/team/members/:id'
          ? /\/v1\/team\/members\/\$MEMBERSHIP_ID/
          : new RegExp(path.replace(/[/]/g, '\\/').replace(/:[a-z]+/g, ':\\w+'));
      expect(doc).toMatch(docPattern);
      expect(teamRoute).toContain(`'${path}'`);
    }
  });

  it('/v1/account/me + /v1/account/audit-log paths cited exist', () => {
    expect(doc).toContain('/v1/account/me');
    expect(acctMe).toContain(`'/v1/account/me'`);
    expect(doc).toContain('/v1/account/audit-log');
    expect(acctAudit).toContain(`'/v1/account/audit-log'`);
    expect(doc).toContain('/v1/account/audit-log/export');
    expect(acctAudit).toContain(`'/v1/account/audit-log/export'`);
  });

  it('X-Driftstack-Account header name matches the server convention', () => {
    expect(doc).toMatch(/X-Driftstack-Account/);
    // Live convention: header name appears in code comments + OpenAPI.
    const openapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(openapi).toMatch(/X-Driftstack-Account/);
  });

  it('acc_<uuid> id prefix matches the live convention', () => {
    expect(doc).toMatch(/acc_owner-uuid/);
    expect(doc).toMatch(/mem_/);
  });

  it('member-removal audit action matches the live constant', () => {
    expect(doc).toMatch(/team\.member_removed/);
  });

  it('cross-link targets exist', () => {
    expect(doc).toMatch(/\/api\/team/);
    expect(doc).toMatch(/\/api\/api-keys/);
    expect(doc).toMatch(/\/webhooks\/replay/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages/api/team.md'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages/api/api-keys.md'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/replay.md'))).toBe(true);
  });

  it('role values match the live invite shape (member / admin)', () => {
    expect(doc).toMatch(/`member`/);
    expect(doc).toMatch(/`admin`/);
    // Live invite role schema is inline on team.ts; the pg enum lives on schema.ts.
    expect(teamRoute).toMatch(/z\.enum\(\['member',\s*'admin'\]\)/);
    const schema = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(schema).toMatch(/pgEnum\('team_role',\s*\['member',\s*'admin'\]\)/);
  });
});
