// W309.A — drift guard for /api/api-keys rotation grace narrative.
// The doc page promises a 24-hour grace period on rotate. The
// server-side default in apps/server/src/services/api-keys.ts must
// match (24 * 60 * 60 * 1000 ms = 86_400_000 ms).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/api-keys.md');
const SVC = resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W309.A /api/api-keys ↔ rotation grace parity', () => {
  const page = read(PAGE);
  const svc = read(SVC);

  it('page claims a 24-hour grace period on rotate', () => {
    expect(page).toMatch(/24[- ]hour\s+grace/i);
  });

  it('page references grace_period_ends_at response field', () => {
    expect(page).toContain('grace_period_ends_at');
  });

  it('server default grace is 24 * 60 * 60 * 1000 ms (matches doc 24-hour claim)', () => {
    expect(svc).toMatch(
      /gracePeriodMs\s*=\s*opts\.gracePeriodMs\s*\?\?\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    );
  });

  it('page describes plaintext-shown-once posture', () => {
    expect(page).toMatch(/[Pp]laintext is shown ONCE|shown only once|displayed once/);
  });

  it('page warns that old key returns 401 after grace expires', () => {
    expect(page).toMatch(/401/);
    expect(page).toMatch(/after\s+`?grace_period_ends_at`?/i);
  });
});
