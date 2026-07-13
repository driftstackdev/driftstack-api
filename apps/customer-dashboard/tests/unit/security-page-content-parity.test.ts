// W366.B-security — drift guard for customer-dashboard /security page
// content. V-216 + V-079 + V-353h. These pins lived in
// settings-page-content-parity.test.ts until the 2026-07-03
// design-system v2 split moved the security surfaces to the dedicated
// /security page. This guard pins:
//
//   • V-216 + V-079 endpoints registered server-side + wired on page.
//   • Password change uses /v1/auth/password-reset/request +
//     "60-minute magic link" copy pinned.
//   • change-password sends to the KNOWN account email (captured from
//     /account/me) — no re-prompt a typo could silently fail.
//   • TOTP enrollment: SHA-1 / 30s / 6-digit (RFC 6238 defaults).
//   • Recovery-codes + "support intervention" framing pinned —
//     load-bearing customer claim about lockout recovery cost.
//   • localStorage ds_web_session_token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/security.astro');
const AUDIT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W366.B-security customer-dashboard /security page content parity', () => {
  const body = read(PAGE);

  it('V-216 /v1/account/audit-log registered server-side + wired on page', () => {
    expect(existsSync(AUDIT_ROUTE)).toBe(true);
    expect(read(AUDIT_ROUTE)).toContain("'/v1/account/audit-log'");
    expect(body).toContain('/v1/account/audit-log');
  });

  it('V-079 /v1/auth/password-reset/request is the change-password trigger', () => {
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/password-reset/request'");
    expect(body).toContain('/v1/auth/password-reset/request');
    // Customer-facing copy commits to magic-link + 60-min expiry
    // (matches AUTH_TOKEN_TTL_MS.passwordReset = 60 * 60 * 1000, the
    // server TTL for the /v1/auth/password-reset/request link this
    // triggers — the prior "15 minutes" copy was the magic-link TTL
    // for a different flow, fixed alongside the /forgot-password drift).
    expect(body).toMatch(
      /We email you a magic link to confirm\. The link expires after 60\s+minutes/,
    );
    // Existing sessions are NOT invalidated by password-reset
    // request — load-bearing behavioural claim.
    expect(body).toMatch(/old sessions stay signed in until they naturally expire/);
  });

  it('change-password uses the known account email (captured from /account/me), no re-prompt that a typo could silently fail', () => {
    // me.email captured into a module-scoped var on the /account/me load.
    expect(body).toMatch(/let accountEmail = null/);
    expect(body).toMatch(/if \(me\.email\) accountEmail = me\.email/);
    // The reset is sent to the known email directly when available; the
    // prompt is only a defensive fallback (pre-filled with the email).
    expect(body).toMatch(/let email = accountEmail/);
    expect(body).toMatch(/defaultValue: accountEmail/);
  });

  it('bounds every authenticated request and serializes password-reset before prompting', () => {
    expect(body).toContain('const SECURITY_TIMEOUT_MS = 15_000;');
    expect(body).toContain('let passwordResetInFlight = false;');
    expect(body).toMatch(/if \(passwordResetInFlight\) return;/);
    expect(body).toMatch(/const controller = new AbortController\(\);/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/\.finally\(\(\) => window\.clearTimeout\(timeout\)\)/);
    expect(body).toContain('Request took too long. Check your connection and try again.');
    expect(body).toMatch(/passwordResetInFlight = false;/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\)/);
  });

  it('V-353h TOTP enrollment: SHA-1 / 30s / 6-digit (RFC 6238 defaults) pinned', () => {
    expect(body).toMatch(/SHA-1 \/ 30s \/ 6-digit \(RFC 6238 defaults/);
  });

  it('recovery-codes + "support intervention" lockout framing pinned', () => {
    expect(body).toMatch(
      /without your authenticator AND your recovery codes, account access\s+requires support intervention/,
    );
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });
});
