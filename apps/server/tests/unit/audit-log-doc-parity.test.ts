// W218.A — drift-guard between /docs/audit-log and the actual
// account-audit endpoints. The previous revision claimed:
//   - endpoint at /v1/account/audit (real: /v1/account/audit-log)
//   - response envelope with `items` key (real: `data`)
//   - id prefix `aud_…` (real: raw uuid)
//   - account_owner scope requirement (real: no scope gate)
//   - team members get 403 (real: read-allowed for both roles)
// All of those would steer integrators into 404s, broken JSON
// parsing, or wrong RBAC expectations.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'audit-log.astro');
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'account-audit.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W218.A audit-log doc parity', () => {
  const doc = read(DOC_PATH);
  const route = read(ROUTE_PATH);

  it('endpoint path in doc matches the route registration', () => {
    expect(route).toMatch(/'\/v1\/account\/audit-log'/);
    expect(doc).toMatch(/\/v1\/account\/audit-log/);
    // The stale /v1/account/audit path must not appear (we tolerate
    // it inside audit-log to match the longer string, but not as a
    // path on its own).
    expect(doc).not.toMatch(/\/v1\/account\/audit(?![/-])/);
  });

  it('response envelope is {data, next_cursor}, not {items, …}', () => {
    expect(route).toMatch(
      /data: page\.items\.map\(\(row\) => publicEntry\(row, redactActorPrivacy\)\)/,
    );
    expect(doc).toMatch(/"data":/);
    expect(doc).not.toMatch(/"items":\s*\[/);
  });

  it('entry id in the doc example is a raw UUID, not a prefixed string', () => {
    // The route returns `id: row.id` (raw uuid).
    expect(route).toMatch(/id: row\.id,/);
    expect(doc).not.toMatch(/"id":\s*"aud_/);
  });

  it('doc does not claim a per-scope gate that the route does not enforce', () => {
    // No requireScope call in the route file → no scope claim in doc.
    expect(route).not.toMatch(/requireScope\(/);
    expect(doc).not.toMatch(/requires the .* scope/i);
    expect(doc).not.toMatch(/requires account_owner scope/);
  });

  it('doc does not claim team members get 403 (read-allowed for both roles)', () => {
    expect(doc).not.toMatch(/Members.*get 403/i);
    expect(doc).toMatch(/both .*member.* and .*admin.* team\s+roles are read-allowed/i);
  });
});
