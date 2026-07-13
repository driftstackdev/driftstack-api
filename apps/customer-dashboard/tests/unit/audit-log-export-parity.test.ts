// W313.C — drift guard for /audit-log page export. The page calls
// GET /v1/account/audit-log/export?format=csv|json. Both the
// list endpoint and the export endpoint must be registered on the
// server, and the page must expose both CSV + JSON buttons.

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

describe('W313.C /audit-log page export parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page calls GET /v1/account/audit-log', () => {
    expect(page).toContain('/v1/account/audit-log');
  });

  it('page calls GET /v1/account/audit-log/export', () => {
    expect(page).toContain('/v1/account/audit-log/export');
  });

  it('page exposes both CSV + JSON export triggers', () => {
    expect(page).toMatch(/downloadExport\(['"]csv['"]\)/);
    expect(page).toMatch(/downloadExport\(['"]json['"]\)/);
  });

  it('server registers /v1/account/audit-log/export', () => {
    expect(route).toContain("'/v1/account/audit-log/export'");
  });

  it('page mentions GDPR Article 20 portability framing', () => {
    expect(page).toMatch(/GDPR Article 20|Article 20 portability/);
  });

  it('export failure surfaces the problem+json detail (W151/W152), not a bare HTTP code', () => {
    // A failed export returns problem+json (not the blob); the page must
    // read `detail` so a refused export (e.g. an export rate-limit)
    // explains why rather than showing "Export failed (HTTP 429)".
    expect(page).toMatch(/throw window\.driftstackResponseError\(r, b\)/);
  });
});
