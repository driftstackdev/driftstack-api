// Drift guard for the AUTHENTICATED frontends' Cloudflare Pages security
// headers: apps/customer-dashboard/public/_headers + apps/admin-panel/public/_headers.
//
// Why this guard exists: the marketing-site (W523.C) and docs (W792) _headers
// already pin their X-Frame-Options/nosniff/Referrer security set, and the
// status-site is pinned as intentionally-fileless (CF-edge headers). But the
// two authenticated surfaces — which render the MOST sensitive data (customer
// dashboard: API keys, billing, account, audit log; admin panel: cross-customer
// account/audit/crypto views) — had NO parity guard on their security headers.
// A refactor of the cache rules (or an accidental deletion) could silently drop
// `X-Frame-Options: DENY` and reintroduce a clickjacking surface on the exact
// pages where it matters most, with no test catching the regression.
//
// Scope: pin the per-path `/*` security-header block on BOTH files. The
// family-wide CSP origin audit completed 2026-07-13; the exact per-surface
// directives are pinned in frontend-pages-csp-security-parity.test.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

// ⛔ 2026-08-27 — THE STATUS-SITE SENTENCE ABOVE IS STALE. It has shipped a real
// `apps/status-site/public/_headers` (3670 bytes) since the referrer hardening;
// it is no longer fileless. Left in place as the reason this guard was written,
// corrected here rather than silently edited.
//
// ⭐ WHY THE TWO POLICIES DIFFER, recorded because nothing said so and the
// difference invites a wrong "consistency" fix in either direction. `no-referrer`
// is not the stricter-is-better choice applied unevenly — it tracks whether the
// app SERVES a page whose own URL carries a credential. Measured across all six
// Astro surfaces on 2026-08-27:
//
//   serves a token-bearing URL  → no-referrer
//     customer-dashboard  (reset-password.astro, verify-email.astro)
//     status-site         (subscribe confirm + one-click unsubscribe)
//   does not                    → strict-origin-when-cross-origin
//     admin-panel   (no token route at all — bearer lives in a header)
//     docs, marketing-site  (they DOCUMENT token URLs in prose; they serve none)
//     errors-site
//
// Six of six consistent. So harmonising admin-panel UP to `no-referrer` would be
// harmless but meaningless, and harmonising customer-dashboard DOWN to match
// admin-panel would re-expose a reset token to every same-origin asset the page
// loads — which is exactly the exposure the status-site fix closed.

const SURFACES = [
  {
    name: 'customer-dashboard',
    path: 'apps/customer-dashboard/public/_headers',
    title: '# Cloudflare Pages security headers for the customer dashboard.',
    referrerPolicy: 'no-referrer',
  },
  {
    name: 'admin-panel',
    path: 'apps/admin-panel/public/_headers',
    title: '# Cloudflare Pages security headers for the admin panel.',
    referrerPolicy: 'strict-origin-when-cross-origin',
  },
] as const;

describe('authenticated-frontend _headers security parity (customer-dashboard + admin-panel)', () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      const file = resolve(REPO_ROOT, surface.path);

      it(`${surface.path} exists`, () => {
        expect(existsSync(file)).toBe(true);
      });

      const body = existsSync(file) ? readFileSync(file, 'utf8') : '';

      it('documents its purpose as Cloudflare Pages SECURITY headers (intent survives a cache-only refactor)', () => {
        expect(body).toMatch(
          new RegExp(`^${surface.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
        );
      });

      it('CRITICAL: catch-all /* sets X-Frame-Options: DENY — the clickjacking defense on the authenticated surface MUST NOT silently regress', () => {
        expect(body).toMatch(/^\/\*$/m);
        expect(body).toMatch(/^ {2}X-Frame-Options: DENY$/m);
      });

      it('CRITICAL: Strict-Transport-Security forces HTTPS (2026-06-03 — these surfaces hold ds_web_session_token; CF edge served no STS so a TLS-strip on first visit could MITM the token)', () => {
        // 2-year max-age + includeSubDomains, matching the API's HSTS
        // (apps/server/src/lib/app.ts). Dropping this reopens a
        // TLS-stripping / session-token-MITM window on the authenticated
        // frontends.
        expect(body).toMatch(
          /^ {2}Strict-Transport-Security: max-age=63072000; includeSubDomains; preload$/m,
        );
      });

      it(`CRITICAL: X-Content-Type-Options: nosniff + exact Referrer-Policy: ${surface.referrerPolicy}`, () => {
        expect(body).toMatch(/^ {2}X-Content-Type-Options: nosniff$/m);
        expect(body.match(/^ {2}Referrer-Policy: .+$/gm)).toEqual([
          `  Referrer-Policy: ${surface.referrerPolicy}`,
        ]);
      });

      it('Permissions-Policy locks the sensitive sensor/payment surface (camera + microphone + geolocation + payment disabled)', () => {
        expect(body).toMatch(/^ {2}Permissions-Policy:.*\bcamera=\(\)/m);
        expect(body).toMatch(/^ {2}Permissions-Policy:.*\bmicrophone=\(\)/m);
        expect(body).toMatch(/^ {2}Permissions-Policy:.*\bgeolocation=\(\)/m);
        expect(body).toMatch(/^ {2}Permissions-Policy:.*\bpayment=\(\)/m);
      });

      it('enforces one Content-Security-Policy header in the catch-all', () => {
        expect(body.match(/^ {2}Content-Security-Policy:/gm)).toHaveLength(1);
      });
    });
  }

  it('customer dashboard never sends one-time query credentials through Referer', () => {
    const body = readFileSync(
      resolve(REPO_ROOT, 'apps/customer-dashboard/public/_headers'),
      'utf8',
    );
    expect(body).toMatch(/^ {2}Referrer-Policy: no-referrer$/m);
    expect(body).not.toMatch(/^ {2}Referrer-Policy: strict-origin-when-cross-origin$/m);
    expect(body).toMatch(/OAuth callback, magic-link,/);
    expect(body).toMatch(/full URL on same-origin asset\/navigation requests/);
  });
});
