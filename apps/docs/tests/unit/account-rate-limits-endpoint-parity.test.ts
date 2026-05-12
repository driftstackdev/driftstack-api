// W325.A — drift guard for /api/account-rate-limits page. Pins
// the GET /v1/account/rate-limits endpoint citation + matches it to
// the server route registration. The doc also describes the
// effective vs. tier-default distinction (per V-194) — pin the
// "effective" framing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/account-rate-limits.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W325.A /api/account-rate-limits ↔ route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page cites GET /v1/account/rate-limits', () => {
    expect(page).toContain('GET /v1/account/rate-limits');
  });

  it('server registers /v1/account/rate-limits', () => {
    expect(route).toContain("'/v1/account/rate-limits'");
  });

  it('page describes effective config (admin overrides on top of tier defaults)', () => {
    expect(page).toMatch(/effective/i);
  });
});
