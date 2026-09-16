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

  it('customer-configurable egress is marked SHIPPED (emerald ✓, per profile). 2026-05-22 — flipped from amber ○ "(roadmap)" after the SocksProxyBackend impl + bootstrap wire landed per planning 133 Phase 1. 2026-09-15 refuter: the "Driftstack EU egress" / "managed exit" fallback this title used to assert does not exist in the shipped config — an API session names a saved proxy_id and no shared Driftstack exit is configured.', () => {
    // 2026-09-15 plain-language pass: same shipped claim, customer words.
    expect(page).toMatch(/Your own proxy or VPN, per profile/);
    // 2026-09-15 refuter: the "managed exit" fallback was an INVENTED feature —
    // no Driftstack-run exit is configured for production (infra/env-templates/
    // production.env.template leaves DEFAULT_EGRESS_HOST/PORT empty on purpose:
    // "UNSET IS VALID AND DELIBERATE"; production.env carries no DEFAULT_EGRESS_*
    // line; apps/server/src/routes/agent-sessions.ts dispatches NO proxy when
    // proxy_id is omitted and a REQUIRE_PROXY=1 node refuses by name). The page
    // now says an API session names a saved proxy and that no shared Driftstack
    // exit exists; the old clause is negatively pinned so it cannot return.
    expect(page).toMatch(/names one of your saved proxies by\s+its proxy_id/);
    expect(page).toMatch(
      /Driftstack does not route your traffic through\s+a shared exit of its own/,
    );
    expect(page).not.toMatch(/managed exit/);
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
