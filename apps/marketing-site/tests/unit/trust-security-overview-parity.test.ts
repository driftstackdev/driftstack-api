// W262.C — drift-guard for /trust/security-overview. Pins:
// 1. Every "apps/server/src/..." code-path reference exists on disk.
// 2. Mentioned function names exist in those files.
// 3. mTLS is NOT claimed as live (it's a roadmap item per W246.A).
// 4. Customer-configurable egress remains framed as roadmap.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/security-overview.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W262.C /trust/security-overview ↔ live evidence parity', () => {
  const page = read(PAGE);

  it('every cited apps/server/src/* path exists on disk', () => {
    const paths = [...page.matchAll(/apps\/server\/src\/[\w./-]+\.ts/g)].map((m) => m[0]);
    expect(paths.length).toBeGreaterThan(3);
    const missing = paths.filter((p) => !existsSync(resolve(REPO_ROOT, p)));
    expect(missing).toEqual([]);
  });

  it('cited functions exist in api-keys.ts (hashApiKey / verifyApiKey)', () => {
    const apiKeys = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(page).toContain('hashApiKey()');
    expect(page).toContain('verifyApiKey()');
    expect(apiKeys).toMatch(/export\s+async\s+function\s+hashApiKey\b/);
    expect(apiKeys).toMatch(/export\s+async\s+function\s+verifyApiKey\b/);
  });

  it('mTLS is not advertised as live (roadmap per W246.A)', () => {
    expect(page).not.toMatch(/mTLS where applicable/);
    expect(page).not.toMatch(/client-cert validation on internal hops/);
  });

  it('customer-configurable egress is marked roadmap (amber ○), not live', () => {
    // The amber-○ pattern matches roadmap items; emerald-✓ is live.
    expect(page).toMatch(/Customer-configurable egress \(roadmap\)/);
    // Page must say the live state is Driftstack's own egress.
    expect(page).toMatch(/Driftstack's own EU network egress/);
  });

  it('webhook signing claim matches the live HMAC scheme (Stripe + NowPayments + outbound)', () => {
    expect(page).toMatch(/HMAC-SHA256/);
    expect(page).toMatch(/HMAC-SHA512/);
    // Cited file refs must exist.
    expect(existsSync(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'))).toBe(true);
  });

  it('TOTP secret encryption is AES-256-GCM (matches the live MFA module)', () => {
    expect(page).toMatch(/AES-256-GCM/);
    const mfa = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(mfa).toMatch(/aes-256-gcm/i);
  });
});
