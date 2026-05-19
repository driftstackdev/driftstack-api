// Cross-source invariant: the 10,000-row audit-log export ceiling
// appears in 3+ places — the route's EXPORT_MAX_ROWS constant, the
// docs/api/audit-log.md customer-facing copy, and the marketing-site
// /docs/audit-log.astro reference. Drift on the cap would either
// surprise customers ("I asked for 50k rows; got 10k truncated")
// or invite memory blowup on the server (DoS vector).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');
const DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages/api/audit-log.md');
const MARKETING = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/audit-log.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('audit-log export 10k-row ceiling cross-source invariant', () => {
  const route = read(ROUTE);
  const docs = read(DOCS);
  const marketing = read(MARKETING);

  it('routes/account-audit pins EXPORT_MAX_ROWS = 10_000 constant + the row-fetch loop guard', () => {
    expect(route).toMatch(/const EXPORT_MAX_ROWS = 10_000;/);
    expect(route).toMatch(/while \(all\.length < EXPORT_MAX_ROWS\) \{/);
  });

  it('routes/account-audit sets truncated flag when row-count hits the cap', () => {
    expect(route).toMatch(/const truncated = all\.length >= EXPORT_MAX_ROWS;/);
  });

  it("docs/api/audit-log.md customer copy claims 'Cap: 10,000 rows per file.' + 'truncated flag is true when the row count hit the 10,000-row' — pinned so the customer-facing claim matches the server-side EXPORT_MAX_ROWS constant", () => {
    expect(docs).toMatch(/Cap: 10,000 rows per file\./);
    expect(docs).toMatch(/The `truncated` flag is `true` when the row count hit the 10,000-row/);
  });

  it("docs/api/audit-log.md sample-output references '10,000 audit-log entries' as the upper bound", () => {
    expect(docs).toMatch(
      /\/\* up to 10,000 audit-log entries — same shape as the read endpoint \*\//,
    );
  });

  it('marketing-site /docs/audit-log.astro references the 10,000-row ceiling in the inline endpoint annotation', () => {
    expect(marketing).toMatch(
      /<code>GET \/v1\/account\/audit-log\/export\?format=csv<\/code> \(10,000-row/,
    );
  });
});
