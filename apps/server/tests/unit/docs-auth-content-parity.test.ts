// Drift guard for apps/docs/src/pages/api/auth.md — final unguarded
// docs/api/*.md file in the slice 153/154/155/160/161/162/163
// coverage-completion track. Pins:
//   - the customer-key/web-session/device-credential framing (the load-bearing
//     "which auth do I use?" decision tree for customers);
//   - the discriminated-union login response (no-MFA → session;
//     MFA enrolled → challenge token);
//   - the 5-min challenge-token TTL + the password min-12 enforcement;
//   - the email-already-registered 409 contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/auth.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs api/auth content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Authentication flows/);
    expect(body).toMatch(
      /description: Sign up, log in, verify email, MFA challenge \+ step-up, magic link, password reset/,
    );
  });

  it('three-auth-surface framing pins paid customer keys, dashboard web sessions, and restricted desktop device credentials', () => {
    expect(body).toMatch(/Driftstack has three auth surfaces:/);
    expect(body).toMatch(/\*\*Customer API-key bearer auth\*\* for SDK consumers on any paid/);
    expect(body).toMatch(/tier, including Manual/);
    expect(body).toMatch(/\*\*Web-session auth\*\* for the customer dashboard/);
    expect(body).toMatch(/\*\*Browser-authorized device credentials\*\* for the desktop app/);
    expect(body).toMatch(/it is not a general sandbox\/customer key/);
  });

  it('credential truth pins ds_live paid keys, ds_test Free desktop credentials, upgrade recovery, and the actionable 403 detail', () => {
    expect(body).toMatch(/Paid\s*\n?customer keys use `ds_live_…`/);
    expect(body).toMatch(/`ds_test_…` on Free/);
    expect(body).toMatch(/They resume after an upgrade unless separately revoked or expired/);
    expect(body).toMatch(/The "apiAccess" feature is not available on the "free" tier/);
    expect(body).not.toMatch(/feature_not_available/);
  });

  it('discriminated-union login response pinned: no-MFA → session shape, MFA enrolled → challenge_token shape with mfa_required: true literal — drift to dropping the discriminator would make SDK consumers branch on token-shape inspection instead of the literal field', () => {
    expect(body).toMatch(/Returns a \*\*discriminated union\*\*/);
    expect(body).toMatch(/"mfa_required": true/);
    expect(body).toMatch(/Branch on the `mfa_required` literal/);
  });

  it('5-minute challenge-token TTL pinned: drift to longer window would weaken the post-password gate; drift to shorter would break customer UX between password-entry and TOTP-entry', () => {
    // Appears inline in a JSON example string, not markdown-backticked.
    expect(body).toMatch(/<one-time, expires in 5 minutes>/);
  });

  it('password min-12 enforcement pinned: drift to weakening would conflict with the slice-117-pattern security posture + the AuthPasswordSchema in api-types/auth.ts (12-128 chars, NIST 800-63B compliant)', () => {
    // Appears inline in a JSON example string.
    expect(body).toMatch(/<min 12 chars>/);
  });

  it('email-already-registered 409 contract pinned: drift to a different status code (e.g. 422) would break customer signup error-recovery code paths', () => {
    expect(body).toMatch(/`409 Conflict` is returned when `email` is already registered/);
  });
});
