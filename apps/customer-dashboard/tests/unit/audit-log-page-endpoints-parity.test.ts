// W269.C — drift-guard for customer-dashboard /audit-log page. Pins
// the /v1/account/audit-log + /v1/account/audit-log/export endpoints
// used by the inline list + CSV/JSON export handlers to live route
// registrations in apps/server/src/routes/account-audit.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/audit-log.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W269.C /audit-log page ↔ /v1/account/audit-log* route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('GET /v1/account/audit-log is registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/account\/audit-log(?!\/)/);
    expect(route).toContain(`'/v1/account/audit-log'`);
  });

  it('GET /v1/account/audit-log/export is registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/account\/audit-log\/export/);
    expect(route).toContain(`'/v1/account/audit-log/export'`);
  });

  it('export buttons cover both CSV and JSON formats', () => {
    expect(page).toMatch(/data-export-csv/);
    expect(page).toMatch(/data-export-json/);
    expect(page).toMatch(/downloadExport\(['"]csv['"]\)/);
    expect(page).toMatch(/downloadExport\(['"]json['"]\)/);
  });

  it('reads ds_web_session_token from localStorage for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('framed as GDPR Article 20 data portability', () => {
    expect(page).toMatch(/GDPR Article 20|Article 20/);
  });

  it('server-side 10,000-row export ceiling is documented in the route', () => {
    expect(route).toMatch(/10[,_]?000/);
    expect(route).toContain('x-driftstack-export-truncated');
  });
});
