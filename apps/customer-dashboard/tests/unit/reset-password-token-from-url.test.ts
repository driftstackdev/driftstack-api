// V-184a.B (related) — drift guard for the reset-password page's
// URL token handling. The reset-password email links to
// /reset-password?token=…; the page must read the token from the
// query string and surface a "missing token" UI when absent. If a
// future edit drops this, the reset flow silently regresses.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro'),
  'utf8',
);

describe('reset-password page — token from URL', () => {
  it('reads `token` from URL search params', () => {
    expect(PAGE).toContain("params.get('token')");
  });

  it('surfaces a missing-token UI when ?token is absent', () => {
    // The page hides the form + shows the [data-missing] block
    // when there's no token to consume.
    expect(PAGE).toContain('data-missing');
    expect(PAGE).toContain('classList.remove');
  });
});
