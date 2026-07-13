// W435.C — drift guard for packages/api-types/src/auth.ts.
// V-079 dashboard auth flows (NOT SDK — these are dashboard-only).
// Drift here either weakens AuthPasswordSchema (NIST 800-63B no-
// composition-rule rationale is the locked decision; reintroducing
// upper/digit/symbol composition is a regression) or breaks the
// V-353d MFA discriminated-union (login pretends MFA isn't required,
// session gets minted bypassing the challenge step).
//
//   • V-079 framing pinned: SDK does not surface auth flows; dashboard
//     + onboarding landing pages consume; schemas live here so
//     admin/dashboard code imports type-safely without depending on
//     server package.
//   • AuthEmailSchema: trim+lower+email+max 254 (RFC 5321 line cap).
//   • AuthPasswordSchema: 12..128, NO composition rules per NIST
//     800-63B-3 — length is the lever.
//   • AuthTokenSchema: URL-safe regex + 32..256 + sha256-hashed at rest.
//   • Signup / VerifyEmail / ResendVerification / Login flows.
//   • V-353d Login MFA: discriminated-union LoginResponseUnion
//     (LoginResponse | LoginMfaRequiredResponse); MfaChallenge request
//     code/recovery_code refine; via enum totp|recovery.
//   • V-353e step-up reauth: same refine on existing session; refreshes
//     mfa_satisfied_at for step-up-gated routes.
//   • Magic-link / Password-reset: shape-stable sent:true to avoid
//     account-existence leak.
//   • Refresh rotates session (old revoked_at + new row); Logout: ok.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W435.C packages/api-types/src/auth.ts content parity', () => {
  const body = read(LIB);

  it('V-079 framing pinned: dashboard-only auth flows distinct from api-keys.ts (SDK long-lived flow); SDK does not surface auth; schemas live here so admin/dashboard import without depending on server package', () => {
    expect(body).toMatch(
      /\/\/ User-facing auth-flow schemas \(signup, verify-email, login, magic-link,\s*\n?\s*\/\/ password-reset, refresh, logout\)\. Distinct from `api-keys\.ts` which covers\s*\n?\s*\/\/ the long-lived API-key issuance flow used by SDK consumers\./,
    );
    expect(body).toMatch(
      /\/\/ V-079 scaffolding: the SDK does not surface auth flows — these endpoints\s*\n?\s*\/\/ are consumed by the customer dashboard \(browser\) and the onboarding flow\s*\n?\s*\/\/ landing pages\. Schemas live here so admin\/dashboard code can import them\s*\n?\s*\/\/ type-safely without depending on the server package\./,
    );
  });

  it("imports: z + Iso8601Schema from './common.js'", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ Iso8601Schema \} from '\.\/common\.js';/);
  });

  it('AuthEmail: trim + lowercase + email + max 254 (RFC 5321 line-length cap rationale); describe "normalised lowercase server-side"', () => {
    expect(body).toMatch(
      /\/\/ Email is normalised lowercase server-side\. Length cap is the same 254\s*\n?\s*\/\/ max from RFC 5321 line-length limits — well above any realistic email\./,
    );
    expect(body).toMatch(
      /export const AuthEmailSchema = z\s*\n?\s*\.string\(\)\s*\n?\s*\.trim\(\)\s*\n?\s*\.toLowerCase\(\)\s*\n?\s*\.email\(\)\s*\n?\s*\.max\(254\)\s*\n?\s*\.describe\('Account email — normalised lowercase server-side'\);/,
    );
  });

  it('AuthPassword: 12..128, NO composition rules per NIST 800-63B-3 (length is the lever)', () => {
    expect(body).toMatch(
      /\/\/ Password rules: minimum 12, maximum 128\. We do NOT impose composition\s*\n?\s*\/\/ rules \(NIST 800-63B-3 explicitly recommends against forcing\s*\n?\s*\/\/ uppercase\/digits\/symbols mixes\)\. Length is the lever that matters\./,
    );
    expect(body).toMatch(
      /export const AuthPasswordSchema = z\s*\n?\s*\.string\(\)\s*\n?\s*\.min\(12\)\s*\n?\s*\.max\(128\)\s*\n?\s*\.describe\('Account password — 12-128 chars; no composition rules per NIST 800-63B'\);/,
    );
  });

  it('AuthToken: URL-safe regex [A-Za-z0-9_-]+ + 32..256 + sha256-hashed at rest framing', () => {
    expect(body).toMatch(
      /\/\/ Opaque single-use token returned by signup-verify \/ magic-link request \/\s*\n?\s*\/\/ password-reset request as a URL-safe string\. Stored sha256-hashed\./,
    );
    expect(body).toMatch(
      /export const AuthTokenSchema = z\s*\n?\s*\.string\(\)\s*\n?\s*\.min\(32\)\s*\n?\s*\.max\(256\)\s*\n?\s*\.regex\(\/\^\[A-Za-z0-9_-\]\+\$\/\)\s*\n?\s*\.describe\('URL-safe single-use auth token; sha256-hashed at rest'\);/,
    );
  });

  it('SignupRequest: email + password + name 1..120 optional; SignupResponse: verification_email_expires_at + debug_token optional (stub email mode only) describe pinned', () => {
    // Arc 1 sub-slice 6.2 (v2-#6)'s bundled-LLM consent + monthly-cap
    // fields were REMOVED from this schema 2026-06-30 (security fix —
    // an unauthenticated caller could self-declare up to the
    // $10,000/month cap on a fresh no-card free-tier account; now only
    // settable via the authenticated PATCH /v1/account/me/bundled-llm-settings).
    expect(body).toMatch(
      /export const SignupRequestSchema = z\.object\(\{\s*\n?\s*email: AuthEmailSchema,\s*\n?\s*password: AuthPasswordSchema,\s*\n?\s*\/\/ Optional display name\. Server stores untrimmed-but-bounded\.\s*\n?\s*name: z\.string\(\)\.min\(1\)\.max\(120\)\.optional\(\),\s*\n?[\s\S]*?\n\s*\}\);/,
    );
    expect(body).not.toMatch(/bundled_llm_consent:/);
    expect(body).not.toMatch(/bundled_llm_monthly_cap_usd_cents:/);
    expect(body).toMatch(
      /export const SignupResponseSchema = z\.object\(\{\s*\n?\s*\/\/ ISO timestamp the email-verify token expires at\. Client renders\s*\n?\s*\/\/ this so the user knows how long they have to click the link\.\s*\n?\s*verification_email_expires_at: Iso8601Schema,/,
    );
    expect(body).toMatch(
      /\/\/ Absent on real responses — this is a debug field that's only ever\s*\n?\s*\/\/ populated when the server runs with EMAIL_DELIVERY_MODE=stub\. Tests\s*\n?\s*\/\/ assert against it; production responses always have it omitted\./,
    );
    expect(body).toMatch(
      /debug_token: z\s*\n?\s*\.string\(\)\s*\n?\s*\.optional\(\)\s*\n?\s*\.describe\('Stub email mode only — the plaintext verification token'\),/,
    );
  });

  it('VerifyEmail issues web-session ("logged in directly from verification link click without extra step") rationale; WebSession: plaintext token returned ONCE + expires_at + account_id', () => {
    expect(body).toMatch(
      /\/\/ Successful verify also issues a web-session, so the user is logged in\s*\n?\s*\/\/ directly from the verification link click without an extra step\./,
    );
    expect(body).toMatch(
      /export const WebSessionSchema = z\.object\(\{\s*\n?\s*\/\/ Plaintext session token — returned ONCE here, never retrievable again\.\s*\n?\s*\/\/ Caller stores it in the auth cookie\.\s*\n?\s*token: z\.string\(\),\s*\n?\s*expires_at: Iso8601Schema,\s*\n?\s*account_id: z\.string\(\),\s*\n?\s*\}\);/,
    );
  });

  it('ResendVerification shape-stable framing pinned: client never learns whether email matched an unverified account (mints + sends OR silently no-ops for verified/no-account/recent-resend)', () => {
    expect(body).toMatch(
      /\/\/ Shape-stable: client never learns whether the email matched an\s*\n?\s*\/\/ unverified account\. Service either mints \+ sends a fresh token or\s*\n?\s*\/\/ silently no-ops \(already verified, no account, recent re-send\)\./,
    );
    expect(body).toMatch(
      /export const ResendVerificationResponseSchema = z\.object\(\{\s*\n?\s*sent: z\.literal\(true\),\s*\n?\s*expires_at: Iso8601Schema,/,
    );
  });

  it('V-353d Login MFA framing pinned: alternate response when MFA enrolled; customer POSTs challenge_token + 6-digit code (or recovery_code) to /v1/auth/mfa/challenge to exchange for real session', () => {
    expect(body).toMatch(
      /\/\/ V-353d — alternate login response when the account has MFA enrolled\.\s*\n?\s*\/\/ The customer must POST the challenge_token \+ 6-digit code \(or\s*\n?\s*\/\/ recovery code\) to \/v1\/auth\/mfa\/challenge to exchange for the real\s*\n?\s*\/\/ session\./,
    );
    expect(body).toMatch(
      /export const LoginMfaRequiredResponseSchema = z\.object\(\{\s*\n?\s*mfa_required: z\.literal\(true\),\s*\n?\s*challenge_token: z\.string\(\),\s*\n?\s*challenge_expires_at: Iso8601Schema,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /\/\*\* Discriminated-union response shape for \/v1\/auth\/login\. Clients\s*\n?\s*\*\s*branch on `mfa_required` \(presence \+ literal true\) to decide\s*\n?\s*\*\s*whether to drop into the challenge UI or store the session\. \*\//,
    );
    expect(body).toMatch(
      /export const LoginResponseUnionSchema = z\.union\(\[\s*\n?\s*LoginResponseSchema,\s*\n?\s*LoginMfaRequiredResponseSchema,\s*\n?\s*\]\);/,
    );
  });

  it('V-353d MfaChallenge: challenge_token + 6-digit code regex /^\\d{6}$/ optional + recovery_code optional + refine "Either code or recovery_code must be provided"; MfaChallengeResponse via enum totp|recovery', () => {
    expect(body).toMatch(/\/\/ V-353d — POST \/v1\/auth\/mfa\/challenge body\./);
    expect(body).toMatch(
      /export const MfaChallengeRequestSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*challenge_token: z\.string\(\)\.min\(1\),\s*\n?\s*code: z\s*\n?\s*\.string\(\)\s*\n?\s*\.regex\(\/\^\\d\{6\}\$\/, 'Must be a 6-digit code\.'\)\s*\n?\s*\.optional\(\),\s*\n?\s*recovery_code: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n?\s*\}\)\s*\n?\s*\.refine\(\(v\) => v\.code !== undefined \|\| v\.recovery_code !== undefined, \{\s*\n?\s*message: 'Either `code` or `recovery_code` must be provided\.',\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const MfaChallengeResponseSchema = z\.object\(\{\s*\n?\s*session: WebSessionSchema,\s*\n?\s*via: z\.enum\(\['totp', 'recovery'\]\),\s*\n?\s*\}\);/,
    );
  });

  it('V-353e step-up reauth framing pinned: bearer-authed existing web session; posts 6-digit (or recovery) code; server refreshes mfa_satisfied_at so step-up-gated routes pass', () => {
    expect(body).toMatch(
      /\/\/ V-353e — step-up reauth on the existing session\. Caller is bearer-\s*\n?\s*\/\/ authed \(web session\); posts 6-digit \(or recovery\) code; server\s*\n?\s*\/\/ refreshes `mfa_satisfied_at` so step-up-gated routes pass\./,
    );
    expect(body).toMatch(
      /export const MfaStepUpRequestSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*code: z\s*\n?\s*\.string\(\)\s*\n?\s*\.regex\(\/\^\\d\{6\}\$\/, 'Must be a 6-digit code\.'\)\s*\n?\s*\.optional\(\),\s*\n?\s*recovery_code: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n?\s*\}\)\s*\n?\s*\.refine\(\(v\) => v\.code !== undefined \|\| v\.recovery_code !== undefined, \{\s*\n?\s*message: 'Either `code` or `recovery_code` must be provided\.',\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const MfaStepUpResponseSchema = z\.object\(\{\s*\n?\s*via: z\.enum\(\['totp', 'recovery'\]\),\s*\n?\s*mfa_satisfied_at: Iso8601Schema,\s*\n?\s*\}\);/,
    );
  });

  it('MagicLink shape-stable framing pinned: sent always true to client even when email does not exist; service either sends or silently no-ops on lookup so response shape does not leak account-existence', () => {
    expect(body).toMatch(
      /\/\/ Whether a magic-link email was actually sent\. Always `true` to the\s*\n?\s*\/\/ client even when the email doesn't exist, so the response shape\s*\n?\s*\/\/ doesn't leak account-existence; service layer either sends or\s*\n?\s*\/\/ silently no-ops based on the lookup\./,
    );
    expect(body).toMatch(
      /export const MagicLinkRequestResponseSchema = z\.object\(\{[\s\S]*?sent: z\.literal\(true\),\s*\n?\s*expires_at: Iso8601Schema,\s*\n?\s*debug_token: z\.string\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/export const MagicLinkConsumeResponseSchema = LoginResponseUnionSchema;/);
  });

  it('PasswordReset: request shape-stable sent:true; confirm body token + new_password; confirm returns session-or-MFA', () => {
    expect(body).toMatch(
      /export const PasswordResetRequestResponseSchema = z\.object\(\{\s*\n?\s*sent: z\.literal\(true\),\s*\n?\s*expires_at: Iso8601Schema,\s*\n?\s*debug_token: z\.string\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const PasswordResetConfirmRequestSchema = z\.object\(\{\s*\n?\s*token: AuthTokenSchema,\s*\n?\s*new_password: AuthPasswordSchema,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const PasswordResetConfirmResponseSchema = LoginResponseUnionSchema;/,
    );
  });

  it('Refresh rotates session framing pinned: old row gets revoked_at, new row issued; plaintext token in request body carries current, response carries new', () => {
    expect(body).toMatch(
      /\/\/ Refresh rotates the session: old session row gets revoked_at, new row\s*\n?\s*\/\/ issued\. The plaintext request body carries the current token; the\s*\n?\s*\/\/ response carries the new one\./,
    );
    expect(body).toMatch(
      /export const RefreshSessionRequestSchema = z\.object\(\{\s*\n?\s*token: z\.string\(\)\.min\(32\)\.max\(256\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const RefreshSessionResponseSchema = z\.object\(\{\s*\n?\s*session: WebSessionSchema,\s*\n?\s*\}\);/,
    );
  });

  it('Logout: token in body; LogoutResponse ok literal(true)', () => {
    expect(body).toMatch(
      /export const LogoutRequestSchema = z\.object\(\{\s*\n?\s*token: z\.string\(\)\.min\(32\)\.max\(256\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const LogoutResponseSchema = z\.object\(\{\s*\n?\s*ok: z\.literal\(true\),\s*\n?\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
