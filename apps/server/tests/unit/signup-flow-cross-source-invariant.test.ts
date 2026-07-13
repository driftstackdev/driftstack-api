// W900 — SignupRequest + SignupResponse cross-source invariant.
// Two-hundred-twenty-sixth in the drift-guard series. Pins the
// signup flow shape:
//
//   SignupRequest (3 fields):
//     - email: AuthEmailSchema.
//     - password: AuthPasswordSchema (12-128 NIST 800-63B).
//     - name?: trim 1-120 chars (optional display name).
//
//   SignupResponse (2 fields):
//     - verification_email_expires_at: ISO (rendered to user).
//     - debug_token?: stub-mode-only (EMAIL_DELIVERY_MODE=stub).
//       Absent on real responses; tests assert against it.
//
//   The debug_token escape-hatch is the CRITICAL test-vs-prod
//   contract: stub-mode lets tests assert the verification token
//   inline; prod responses NEVER include it (no token leak).
//
// stays in lockstep across api-types Zod canonical.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W900 Signup flow cross-source invariant', () => {
  // ─── SignupRequest 3-field shape ─────────────────────────────

  it('CRITICAL packages/api-types/src/auth.ts SignupRequestSchema has 3 fields — email: AuthEmailSchema + password: AuthPasswordSchema + name (optional 1-120 chars). The 3-field shape is the minimum-info-needed-to-create-account contract.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /SignupRequestSchema = z\.object\(\{\s*\n\s*email: AuthEmailSchema,\s*\n\s*password: AuthPasswordSchema,/,
    );
    expect(p).toMatch(/name: z\.string\(\)\.min\(1\)\.max\(120\)\.optional\(\)/);
  });

  it("CRITICAL SignupRequest.name comment pins 'Optional display name. Server stores untrimmed-but-bounded'. The 'untrimmed' part is intentional — the server preserves the user's exact input (leading/trailing space) so 'Jane ' renders as 'Jane ' (vs 'Jane') in the dashboard.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/Optional display name\. Server stores untrimmed-but-bounded/);
  });

  // ─── SignupResponse 2-field shape ────────────────────────────

  it('CRITICAL SignupResponseSchema has 2 fields — verification_email_expires_at (ISO) + debug_token (optional, stub-mode). The 2-field minimal response keeps the surface narrow.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /SignupResponseSchema = z\.object\(\{[\s\S]+?verification_email_expires_at: Iso8601Schema/,
    );
    expect(p).toMatch(
      /debug_token: z\s*\n?\s*\.string\(\)\s*\n?\s*\.optional\(\)\s*\n?\s*\.describe\('Stub email mode only — the plaintext verification token'\)/,
    );
  });

  it("CRITICAL SignupResponse.verification_email_expires_at comment — 'ISO timestamp the email-verify token expires at. Client renders this so the user knows how long they have to click the link'. The expires_at lets the dashboard show 'this link expires at 14:30 UTC' to the customer.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/ISO timestamp the email-verify token expires at\. Client renders/);
    expect(p).toMatch(/this so the user knows how long they have to click the link/);
  });

  // ─── debug_token EMAIL_DELIVERY_MODE=stub contract ──────────

  it("CRITICAL debug_token framing pins 'EMAIL_DELIVERY_MODE=stub' escape-hatch — 'Absent on real responses — this is a debug field that's only ever populated when the server runs with EMAIL_DELIVERY_MODE=stub. Tests assert against it; production responses always have it omitted'. The framing pins the test-vs-prod contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/Absent on real responses — this is a debug field that's only ever/);
    expect(p).toMatch(/populated when the server runs with EMAIL_DELIVERY_MODE=stub/);
    expect(p).toMatch(
      /Tests\s*\n\s*\/\/ assert against it; production responses always have it omitted/,
    );
  });

  // ─── Types re-exported ───────────────────────────────────────

  it('CRITICAL SignupRequest + SignupResponse types re-export from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/export type SignupRequest = z\.infer<typeof SignupRequestSchema>;/);
    expect(p).toMatch(/export type SignupResponse = z\.infer<typeof SignupResponseSchema>;/);
  });

  // ─── 3-field SignupRequest cardinality ───────────────────────

  it('CRITICAL SignupRequest = EXACTLY 3 fields — email + password + name (optional). bundled_llm_consent / bundled_llm_monthly_cap_usd_cents (Arc 1 sub-slice 6.2 v2-#6) were REMOVED 2026-06-30 as a security fix — an unauthenticated caller could self-declare up to the $10,000/month cap on a fresh free-tier account with no payment method/tier/manual-review gate; that budget is now settable only via the authenticated PATCH /v1/account/me/bundled-llm-settings route. The 3-field shape also intentionally avoids signup-time CAPTCHA / phone-number / source / referral_code fields — those are post-verify enhancements, not signup requirements.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    const m = p.match(/SignupRequestSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1] ?? '';
    const fieldCount = (body.match(/^\s*[a-z_]+:/gm) || []).length;
    expect(fieldCount).toBe(3);
    // Drift-guard: the removed fields must not silently reappear.
    expect(body).not.toMatch(/bundled_llm_consent:/);
    expect(body).not.toMatch(/bundled_llm_monthly_cap_usd_cents:/);
  });

  // ─── No forbidden signup fields ──────────────────────────────

  it('CRITICAL SignupRequest does NOT include forbidden fields (phone / captcha_token / source / referral_code / company). These are common signup-form additions Driftstack intentionally avoids — keep the signup surface minimal.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    const m = p.match(/SignupRequestSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const forbidden of ['phone:', 'captcha_token:', 'source:', 'referral_code:', 'company:']) {
      expect(body, `SignupRequest must NOT include forbidden ${forbidden}`).not.toMatch(
        new RegExp(forbidden),
      );
    }
  });

  // ─── PasswordResetConfirmResponse + SuccessfulReset comment ──

  it('CRITICAL PasswordResetConfirm returns a session or the shared MFA challenge union', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/PasswordResetConfirmResponseSchema = LoginResponseUnionSchema/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/signup-flow-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
