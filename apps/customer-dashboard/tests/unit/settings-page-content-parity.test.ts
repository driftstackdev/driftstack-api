// W366.B — drift guard for customer-dashboard /settings page
// content. V-217 + V-204 + V-216 + V-079 + V-353h. Existing
// parity tests cover endpoint wiring + MFA endpoint shape +
// route registration; this guard pins:
//
//   • EMAIL_EVENTS list on the page is EXACTLY
//     OptOutableEmailEventSchema's 8 values (a schema add
//     without a page update silently makes that event
//     unsubscribable from the GUI; a page add without a schema
//     update silently 400s).
//   • V-204 + V-216 + V-079 endpoints registered server-side.
//   • Password change uses /v1/auth/password-reset/request +
//     "15-minute magic link" copy pinned.
//   • TOTP enrollment: SHA-1 / 30s / 6-digit (RFC 6238 defaults).
//   • Recovery-codes + "support intervention" framing pinned —
//     load-bearing customer claim about lockout recovery cost.
//   • localStorage ds_web_session_token.
//   • Profile editing is explicitly a follow-up slice ("currently
//     no-op") — pin so a future GUI claim can't outpace the
//     server-side endpoint.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OptOutableEmailEventSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro');
const EMAIL_PREFS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts');
const AUDIT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W366.B customer-dashboard /settings page content parity', () => {
  const body = read(PAGE);

  it('EMAIL_EVENTS list on the page exactly matches OptOutableEmailEventSchema', () => {
    const block = body.match(/const EMAIL_EVENTS = \[([\s\S]*?)\] as const;/);
    expect(block).not.toBeNull();
    const types = Array.from(block![1]!.matchAll(/type: '([a-z\-]+)'/g)).map((m) => m[1] as string);
    const schemaVals = [
      ...(OptOutableEmailEventSchema._def as { values: readonly string[] }).values,
    ];
    expect(types.sort()).toEqual([...schemaVals].sort());
    // 6 total today (the trial-pack pair was removed with the dead
    // trial_pack lifecycle) — pin the count so a 7th type can't slip
    // into the schema without updating the page.
    expect(types.length).toBe(6);
  });

  it('V-204 /v1/account/email-preferences registered server-side + wired on page', () => {
    expect(existsSync(EMAIL_PREFS_ROUTE)).toBe(true);
    expect(read(EMAIL_PREFS_ROUTE)).toContain("'/v1/account/email-preferences'");
    expect(body).toContain('/v1/account/email-preferences');
  });

  it('V-216 /v1/account/audit-log registered server-side + wired on page', () => {
    expect(existsSync(AUDIT_ROUTE)).toBe(true);
    expect(read(AUDIT_ROUTE)).toContain("'/v1/account/audit-log'");
    expect(body).toContain('/v1/account/audit-log');
  });

  it('V-079 /v1/auth/password-reset/request is the change-password trigger', () => {
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/password-reset/request'");
    expect(body).toContain('/v1/auth/password-reset/request');
    // Customer-facing copy commits to magic-link + 15-min expiry.
    expect(body).toMatch(
      /We email you a magic link to confirm\. The link expires after 15\s+minutes/,
    );
    // Existing sessions are NOT invalidated by password-reset
    // request — load-bearing behavioural claim.
    expect(body).toMatch(/old sessions stay signed in until they naturally expire/);
  });

  it('V-353h TOTP enrollment: SHA-1 / 30s / 6-digit (RFC 6238 defaults) pinned', () => {
    expect(body).toMatch(/SHA-1 \/ 30s \/ 6-digit \(RFC 6238 defaults/);
  });

  it('recovery-codes + "support intervention" lockout framing pinned', () => {
    expect(body).toMatch(
      /without your authenticator AND your recovery codes, account access\s+requires support intervention/,
    );
  });

  it('profile-editing explicitly flagged as follow-up slice (currently no-op)', () => {
    // Load-bearing honesty claim — the Save-changes button is
    // visible but does nothing until the /v1/account profile
    // endpoint lands. A future copy edit that drops this caveat
    // without landing the endpoint creates a silent UX bug.
    expect(body).toMatch(
      /Profile editing endpoint lands as a follow-up slice; saves are\s+currently no-op/,
    );
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('V-217 progressive-enhancement framing pinned (SSG mocks + inline-script live wiring)', () => {
    expect(body).toMatch(
      /V-217 — progressive-enhancement live wiring against:[\s\S]*?\/v1\/account\/email-preferences \(V-204\)[\s\S]*?\/v1\/account\/audit-log \(V-216\)[\s\S]*?\/v1\/auth\/password-reset\/request \(V-079\)/,
    );
  });

  it('billing-receipt copy distinguishes Driftstack receipts from Stripe receipts', () => {
    // Load-bearing claim — opting out of Driftstack billing
    // receipts does NOT opt out of Stripe receipts. Pin so a
    // future receipt-system change can't soften the distinction.
    expect(body).toMatch(/Per-invoice receipt emails\. Stripe receipts continue regardless/);
  });
});
