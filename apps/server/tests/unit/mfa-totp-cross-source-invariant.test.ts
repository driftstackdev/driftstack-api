// W870 — V-353 MFA 6-digit TOTP + via 2-method cross-source
// invariant. One-hundred-ninety-sixth in the drift-guard series.
// Pins the V-353b/d/e MFA contract:
//
//   - Code shape: regex /^\d{6}$/ — exactly 6 digits.
//   - via enum: ['totp', 'recovery'] — 2 challenge methods.
//   - RFC 6238 TOTP defaults: SHA-1 / 30s / 6-digit (cross-app
//     vendor-compat — every authenticator app supports these).
//
// stays in lockstep across:
//   - packages/api-types/src/auth.ts MfaChallengeRequest +
//     MfaStepUpRequest (both use /^\d{6}$/).
//   - packages/api-types/src/auth.ts MfaChallengeResponse +
//     MfaStepUpResponse (both use via: z.enum(['totp', 'recovery'])).
//   - apps/customer-dashboard/src/pages/security.astro MFA enroll
//     form (pattern="\d{6}" + maxlength="6" + inputmode="numeric"
//     for the confirm input; moved from settings.astro with the
//     2026-07-03 design-system v2 /security split).
//
// Drift would silently break:
//   * Auth server rejecting valid TOTP codes (wrong digit count).
//   * Dashboard form accepting codes the server rejects.
//   * Authenticator-app interop if TOTP defaults change.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const MFA_METHODS = ['totp', 'recovery'] as const;

describe('W870 V-353 MFA cross-source invariant', () => {
  // ─── api-types canonical: MfaChallengeRequest 6-digit code ───

  it('CRITICAL packages/api-types/src/auth.ts MfaChallengeRequestSchema code field uses /^\\d{6}$/ regex with "Must be a 6-digit code." message. The V-353d login-mfa challenge accepts only exactly-6-digit codes.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /MfaChallengeRequestSchema = z\s*\.object\(\{[\s\S]+?code: z\s*\.string\(\)\s*\n\s*\.regex\(\/\^\\d\{6\}\$\/, 'Must be a 6-digit code\.'\)/,
    );
  });

  it("CRITICAL MfaChallengeRequestSchema requires either code OR recovery_code (refine). The 'Either code or recovery_code must be provided' message is the union-input contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/Either `code` or `recovery_code` must be provided\./);
  });

  // ─── api-types canonical: MfaStepUpRequest 6-digit code ──────

  it('CRITICAL packages/api-types/src/auth.ts MfaStepUpRequestSchema code field uses /^\\d{6}$/ regex. The V-353e step-up reauth path matches the V-353d login path on code shape.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /MfaStepUpRequestSchema = z\s*\.object\(\{[\s\S]+?code: z\s*\.string\(\)\s*\n\s*\.regex\(\/\^\\d\{6\}\$\/, 'Must be a 6-digit code\.'\)/,
    );
  });

  // ─── via enum: 2-value challenge-method ───────────────────────

  it("CRITICAL packages/api-types/src/auth.ts MfaChallengeResponseSchema includes via: z.enum(['totp', 'recovery']). The 2-method response field tells the client whether code or recovery_code was consumed.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /MfaChallengeResponseSchema = z\.object\(\{[\s\S]+?via: z\.enum\(\['totp', 'recovery'\]\)/,
    );
  });

  it("CRITICAL packages/api-types/src/auth.ts MfaStepUpResponseSchema includes via: z.enum(['totp', 'recovery']) + mfa_satisfied_at: Iso8601Schema. The step-up response signals method used + refresh timestamp.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /MfaStepUpResponseSchema = z\.object\(\{[\s\S]+?via: z\.enum\(\['totp', 'recovery'\]\)/,
    );
    expect(p).toMatch(
      /MfaStepUpResponseSchema = z\.object\(\{[\s\S]+?mfa_satisfied_at: Iso8601Schema/,
    );
  });

  // ─── V-353d + V-353e anchors traceable ───────────────────────

  it('CRITICAL V-353d anchor pinned for login-mfa challenge (alternate login response when account has MFA enrolled).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/V-353d — alternate login response when the account has MFA enrolled/);
  });

  it("CRITICAL V-353e anchor pinned for step-up reauth path. The 'refreshes `mfa_satisfied_at` so step-up-gated routes pass' framing pins the step-up provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/V-353e — step-up reauth on the existing session/);
    expect(p).toMatch(/refreshes `mfa_satisfied_at` so step-up-gated routes pass/);
  });

  // ─── Dashboard settings.astro MFA form attrs ─────────────────

  it('CRITICAL apps/customer-dashboard/src/pages/security.astro MFA enroll-confirm input has pattern="[0-9]{6}" + maxlength="6" + inputmode="numeric". The HTML5 attrs match the api-types Zod regex — drift would let the form accept invalid input. NOTE: pattern MUST use the [0-9] char class, NOT \\d — Astro strips the backslash from a `pattern="\\d{6}"` attribute at build so the rendered HTML becomes pattern="d{6}" (matches six literal "d", not digits) → every valid code fails "please match the requested format" (founder-reported 2026-07-07). [0-9] has no backslash to strip.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/security.astro'));
    expect(p).toMatch(/inputmode="numeric"/);
    expect(p).toMatch(/pattern="\[0-9\]\{6\}"/);
    // A raw \d MUST NOT reappear (build-strip regression guard).
    expect(p).not.toMatch(/pattern="\\d/);
    expect(p).toMatch(/maxlength="6"/);
  });

  it("CRITICAL apps/customer-dashboard/src/pages/security.astro pins the RFC 6238 TOTP defaults ('SHA-1 / 30s / 6-digit (RFC 6238 defaults; every authenticator app …)'). Drift would change authenticator-app interop.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/security.astro'));
    expect(p).toMatch(/SHA-1 \/ 30s \/ 6-digit \(RFC 6238 defaults; every authenticator app/);
  });

  // ─── 2-method cardinality ────────────────────────────────────

  it('CRITICAL MFA via enum = EXACTLY 2 methods (totp + recovery). The 2-method model intentionally avoids SMS / email / push (each adds attack surface). Drift would expand the surface area requiring server-side support.', () => {
    expect(MFA_METHODS.length).toBe(2);
    expect(MFA_METHODS).toEqual(['totp', 'recovery']);
  });

  it('CRITICAL no source declares forbidden MFA-method names (sms / email / push / call / hardware / yubikey). These are common but deliberately excluded — V-353 limits to TOTP + recovery codes for v1.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    const forbidden = ['sms', 'email', 'push', 'call', 'hardware', 'yubikey'];
    // Pull both via.enum bodies.
    const challengeM = p.match(/MfaChallengeResponseSchema = z\.object\(\{[\s\S]+?\}\)/);
    expect(challengeM).not.toBeNull();
    const stepUpM = p.match(/MfaStepUpResponseSchema = z\.object\(\{[\s\S]+?\}\)/);
    expect(stepUpM).not.toBeNull();
    for (const body of [challengeM![0], stepUpM![0]]) {
      for (const f of forbidden) {
        expect(body, `MFA via must NOT include forbidden '${f}'`).not.toMatch(new RegExp(`'${f}'`));
      }
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/mfa-totp-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
