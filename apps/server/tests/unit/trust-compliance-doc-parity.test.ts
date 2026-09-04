// W240.A — drift-guard for /trust/compliance. The previous revision
// linked the customer audit log at /v1/account/audit (404) via a
// docs.driftstack.io URL that may or may not exist. Pin the current
// dashboard + real API endpoint access paths.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'trust', 'compliance.astro');
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'account-audit.ts');

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

  it('describes dashboard and API access without a placeholder docs link', () => {
    expect(doc).toMatch(/available through the dashboard and/);
    expect(doc).toMatch(/GET \/v1\/account\/audit-log/);
    expect(doc).not.toMatch(/\/docs\/audit-log/);
    expect(doc).not.toMatch(/https:\/\/docs\.driftstack\.io\/api\/audit/);
  });
});
