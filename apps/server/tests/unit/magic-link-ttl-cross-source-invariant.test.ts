// Cross-source invariant: magic-link TTL (15 minutes) appears in
// 3 places — AUTH_TOKEN_TTL_MS.magicLink server-side, the dashboard's
// magic-link-request page (default "15 minutes" copy), and the
// services/auth-flows code path using the constant. Drift on the
// server would render a wrong default in the customer's success card.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const AUTH_TOKENS = resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts');
const AUTH_FLOWS = resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts');
const DASHBOARD = resolve(
  REPO_ROOT,
  'apps/customer-dashboard/src/pages/auth/magic-link-request.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('magic-link 15-min-TTL cross-source invariant', () => {
  const tokens = read(AUTH_TOKENS);
  const flows = read(AUTH_FLOWS);
  const dashboard = read(DASHBOARD);

  it('lib/auth-tokens.ts pins magicLink: 15 * 60 * 1000 (15 minutes in ms)', () => {
    expect(tokens).toMatch(/magicLink: 15 \* 60 \* 1000,/);
  });

  it('services/auth-flows.ts derives expiresAt from AUTH_TOKEN_TTL_MS.magicLink — pinned so the canonical-constant routing stays documented (drift to a hardcoded value would create a different TTL than the auth-tokens lib advertises)', () => {
    expect(flows).toMatch(
      /const expiresAt = new Date\(Date\.now\(\) \+ AUTH_TOKEN_TTL_MS\.magicLink\);/,
    );
  });

  it('customer-dashboard magic-link-request page default copy reads "15 minutes" — pinned so the customer-facing default expiry text stays in sync with the server-side TTL constant (drift would over/under-promise the link lifetime)', () => {
    expect(dashboard).toMatch(/class="font-mono">15 minutes<\/span/);
  });

  it("Dynamic-minutes-from-expires_at fallback math still rounds to >=1 minute — pinned so the Math.max(1, …) floor stays in the dashboard script (prevents '0 minutes' surface on sub-30s windows)", () => {
    expect(dashboard).toMatch(
      /const minutes = Math\.max\(\s*1,\s*Math\.round\(\(new Date\(body\.expires_at\)\.getTime\(\) - Date\.now\(\)\) \/ 60000\),\s*\);/,
    );
  });
});
