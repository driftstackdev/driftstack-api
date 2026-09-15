// W240.A — drift-guard for /trust/compliance. The previous revision
// linked the customer audit log at /v1/account/audit (404) via a
// docs.driftstack.io URL that may or may not exist. Pin the current
// dashboard + real API endpoint access paths.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'trust', 'compliance.astro');
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'account-audit.ts');
const AUDIT_DOCS_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'audit-log.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W240.A trust/compliance doc parity', () => {
  const doc = read(DOC_PATH);

  it('audit-log endpoint reference matches the real route path', () => {
    expect(read(ROUTE_PATH)).toMatch(/'\/v1\/account\/audit-log'/);
    expect(doc).toMatch(/\/v1\/account\/audit-log/);
    expect(doc).not.toMatch(/\/v1\/account\/audit(?!-log)/);
  });

  it('describes dashboard and API access, linking only a docs page that exists', () => {
    expect(doc).toMatch(/available in the dashboard and through\s+the API/);
    expect(doc).toMatch(/GET \/v1\/account\/audit-log/);
    // 2026-09-15: the docs link is no longer a placeholder — /docs/audit-log/
    // exists on this site; the retired docs.driftstack.io URL must not return.
    expect(doc).toMatch(/href="\/docs\/audit-log\/"/);
    expect(existsSync(AUDIT_DOCS_PATH)).toBe(true);
    expect(doc).not.toMatch(/https:\/\/docs\.driftstack\.io\/api\/audit/);
  });

  it('retention claim matches the audit-log docs page (kept indefinitely, on every plan — no tier window)', () => {
    // The old copy said entries "follow the account tier's published
    // retention"; the docs page states there is no tier-based window.
    expect(read(AUDIT_DOCS_PATH)).toMatch(
      /retained <strong>indefinitely<\/strong>,\s+on every tier/,
    );
    expect(doc).toMatch(/kept for as long as your account exists, on every plan/);
    expect(doc).not.toMatch(/account tier's published retention/);
  });
});
