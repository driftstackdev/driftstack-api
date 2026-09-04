// W256.B — drift-guard for docs.driftstack.io/api/audit-log. Pins
// list + export endpoints, cursor-paginated `data` + `next_cursor`
// envelope, and the actor_type enum.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/audit-log.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W256.B docs/api/audit-log ↔ /v1/account/audit-log parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);

  it('GET /v1/account/audit-log + /export are documented + registered', () => {
    expect(doc).toMatch(/GET \/v1\/account\/audit-log\b/);
    expect(route).toContain(`'/v1/account/audit-log'`);
    expect(route).toContain(`'/v1/account/audit-log/export'`);
  });

  it('uses the data + next_cursor envelope (not orders / records)', () => {
    expect(doc).toMatch(/"data":\s*\[/);
    expect(doc).toMatch(/"next_cursor":/);
  });

  it('actor_type enum covers customer / system / staff', () => {
    for (const a of ['customer', 'system', 'staff']) {
      expect(doc).toMatch(new RegExp(`\`${a}\``));
    }
  });

  it('lists action filter as a single-value query param', () => {
    expect(doc).toMatch(/`action`/);
    expect(doc).toMatch(/filter to a single action name/i);
  });

  it('pagination clamps limit 1-100 with default 50', () => {
    expect(doc).toMatch(/1-100;\s*default 50/);
  });

  it('cites api_key.minted as a real action-name example', () => {
    expect(doc).toMatch(/"action":\s*"api_key\.minted"/);
  });
});
