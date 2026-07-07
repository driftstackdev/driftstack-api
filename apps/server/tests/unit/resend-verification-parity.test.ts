// #187 — drift guard for the self-service signup-verification resend
// flow. Pins the wire-up across:
//
//   • POST /v1/auth/resend-verification route registered in auth.ts
//   • ResendVerificationRequestSchema exported from @driftstack/api-types
//   • AUTH_IP_LIMITS.resendVerification (3/min, matches password-reset)
//   • customer-dashboard /verify-email page exposes a Resend button
//     wired to the endpoint
//   • /docs/email-troubleshooting no longer says "no self-service
//     resend today"
//   • /docs/error-codes email-not-verified action references the
//     /verify-email page, not the (wrong) /forgot-password page

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResendVerificationRequestSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');
const RATE_LIMIT = resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts');
const VERIFY_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro');
// S47 2026-07-07 (founder-approved: mirror deprecation): the legacy
// /docs/email-troubleshooting mirror is deleted (301 →
// docs.driftstack.dev/reference/emails/); the self-service-resend
// claim now lives on the docs successor, so the guard reads that
// source.
const TROUBLESHOOTING = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/emails.md');
const ERROR_CODES = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/error-codes.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('#187 resend-verification parity', () => {
  const routes = read(AUTH_ROUTE);
  const limits = read(RATE_LIMIT);
  const verifyPage = read(VERIFY_PAGE);

  it('exports ResendVerificationRequestSchema with an email field', () => {
    const parsed = ResendVerificationRequestSchema.safeParse({
      email: 'user@example.com',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects payloads without a valid email', () => {
    expect(ResendVerificationRequestSchema.safeParse({}).success).toBe(false);
    expect(ResendVerificationRequestSchema.safeParse({ email: 'not-an-email' }).success).toBe(
      false,
    );
  });

  it('auth.ts registers POST /v1/auth/resend-verification with the resend gate', () => {
    expect(routes).toContain("'/v1/auth/resend-verification'");
    expect(routes).toContain('resendVerificationGate');
    expect(routes).toContain('ResendVerificationRequestSchema');
    expect(routes).toContain('service.resendSignupVerification');
  });

  it('AUTH_IP_LIMITS.resendVerification matches password-reset cap (3/min)', () => {
    expect(limits).toMatch(
      /resendVerification:\s*\{\s*capacity:\s*3,\s*refillPerSecond:\s*3\s*\/\s*60\s*\}/,
    );
  });

  it('verify-email page exposes a Resend button wired to the endpoint', () => {
    expect(verifyPage).toContain('data-action="resend"');
    expect(verifyPage).toContain('Resend verification email');
    expect(verifyPage).toContain("'/v1/auth/resend-verification'");
    // The stale "lands in a future iteration" copy must be gone.
    expect(verifyPage).not.toMatch(/lands in a future iteration/);
  });

  it('the emails doc (S47 successor of /docs/email-troubleshooting) documents self-service resend, never denies it', () => {
    const body = read(TROUBLESHOOTING);
    expect(body).not.toMatch(/no\s+self-service\s+resend\s+today/);
    expect(body).toMatch(/Resend verification email/);
    // Successor framing: verification emails are safe to re-request
    // (self-service), with the same 3/min per-IP cap this suite pins
    // on the server limiter above.
    expect(body).toMatch(/safe to re-request/);
    expect(body).toMatch(/3\/minute per-IP cap/);
  });

  it('/docs/error-codes points email-not-verified at /verify-email, not /forgot-password', () => {
    const body = read(ERROR_CODES);
    expect(body).toMatch(/email-not-verified.*Resend verification email on \/verify-email/);
    expect(body).not.toMatch(/email-not-verified.*\/forgot-password/);
  });
});
